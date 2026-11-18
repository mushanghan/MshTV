using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Xml;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Net.Http.Headers;
using MshTV.Core;
using MshTV.Infrastructure;
using MshTV.Server.Library;

namespace MshTV.Server.Workspace;

internal static class WorkspaceCover
{
    private sealed record Cover(byte[] Content, EntityTagHeaderValue Tag);
    private sealed record Colors(string Background, string EmptyTile, string EmptyMark, string Group, string Media, string Note, string NoteText);
    private static readonly Colors Dark = new("#15181b", "#252e29", "#8faf9a", "#2d3731", "#323a41", "#51473a", "#dad3bd");
    private static readonly Colors Light = new("#f2f3f5", "#e5e7ea", "#686e79", "#e3e6ea", "#c8cdd4", "#ffffff", "#373b43");
    private static readonly MemoryCache Cache = new(new MemoryCacheOptions { SizeLimit = 32 });
    private static readonly SemaphoreSlim RenderSlots = new(2);

    public static async Task<IResult> Get(string id, HttpContext context, CanvasDatabase db, LibraryPaths paths, CancellationToken ct)
    {
        var live = WorkspaceScope.LiveBoards(db).AsNoTracking().Where(row => row.Id == id);
        var version = await live.Select(row => (long?)row.Revision).SingleOrDefaultAsync(ct);
        if (version == null) return Results.NotFound();
        var light = context.Request.Query["theme"] == "light";
        var key = (id, version.Value, light);
        if (!Cache.TryGetValue<Cover>(key, out var cover) || cover == null)
        {
            await RenderSlots.WaitAsync(ct);
            try
            {
                if (!Cache.TryGetValue(key, out cover) || cover == null)
                {
                    var board = await live.SingleOrDefaultAsync(ct);
                    if (board == null) return Results.NotFound();
                    var content = await Render(WorkspaceEndpoints.Document(board), board.LibraryId, db, paths, light ? Light : Dark, ct);
                    cover = new Cover(content, new EntityTagHeaderValue($"\"{Convert.ToHexString(SHA256.HashData(content))}\""));
                    Cache.Set((id, board.Revision, light), cover, new MemoryCacheEntryOptions().SetSize(1).SetAbsoluteExpiration(TimeSpan.FromSeconds(20)));
                }
            }
            finally { RenderSlots.Release(); }
        }
        context.Response.Headers.CacheControl = "private, max-age=0, must-revalidate";
        context.Response.Headers.ContentSecurityPolicy = "default-src 'none'; img-src data:; sandbox";
        return Results.Bytes(cover.Content, "image/svg+xml", entityTag: cover.Tag);
    }

    private static async Task<byte[]> Render(BoardDocument document, string libraryId, CanvasDatabase db, LibraryPaths paths, Colors colors, CancellationToken ct)
    {
        var doc = BoardRules.Normalize(document);
        var cards = doc.Items.Take(32).ToList();
        var ids = cards.Select(card => card.AssetId).OfType<string>().Where(id => Guid.TryParse(id, out _)).Distinct().Take(12).ToList();
        var assets = ids.Count == 0 ? [] : await ScopedAsset.Query(db, libraryId)
            .Where(row => ids.Contains(row.Asset.Id) && row.Asset.HasThumbnail).ToListAsync(ct);
        var pictures = new Dictionary<string, string>();
        foreach (var row in assets.Where(row => row.Status == "ready"))
        {
            try
            {
                var path = LibraryTypes.CachePath(paths, row.Asset, "thumb");
                await using var stream = SafeMediaFiles.Open(paths.Cache, Path.GetFileName(path));
                if (stream.Length is <= 0 or > 48 * 1024) continue;
                var bytes = new byte[(int)stream.Length];
                await stream.ReadExactlyAsync(bytes, ct);
                pictures.Add(row.Asset.Id, $"data:image/webp;base64,{Convert.ToBase64String(bytes)}");
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
        }

        var boxes = doc.Items.Select(item => (item.X, item.Y, item.Width, item.Height))
            .Concat(doc.Groups.Select(group => (X: group.X ?? 0, Y: group.Y ?? 0, Width: group.Width ?? 0, Height: group.Height ?? 0))).ToArray();
        var svg = new StringBuilder();
        using (var xml = XmlWriter.Create(svg, new XmlWriterSettings { OmitXmlDeclaration = true }))
        {
            xml.WriteStartElement("svg", "http://www.w3.org/2000/svg");
            xml.WriteAttributeString("viewBox", "0 0 320 180");
            Rect(xml, 0, 0, 320, 180, colors.Background);
            if (boxes.Length == 0)
            {
                Rect(xml, 139, 66, 42, 42, colors.EmptyTile, 7);
                Rect(xml, 151, 86, 18, 2, colors.EmptyMark);
                Rect(xml, 159, 78, 2, 18, colors.EmptyMark);
            }
            else
            {
                var left = boxes.Min(rect => rect.X);
                var top = boxes.Min(rect => rect.Y);
                var width = Math.Max(1, boxes.Max(rect => rect.X + rect.Width) - left);
                var height = Math.Max(1, boxes.Max(rect => rect.Y + rect.Height) - top);
                var scale = Math.Min(1, Math.Min(294 / width, 154 / height));
                double X(double value) => (320 - width * scale) / 2 + (value - left) * scale;
                double Y(double value) => (180 - height * scale) / 2 + (value - top) * scale;
                foreach (var group in doc.Groups.Take(32))
                    Rect(xml, X(group.X ?? 0), Y(group.Y ?? 0), (group.Width ?? 0) * scale, (group.Height ?? 0) * scale, colors.Group, 2);
                foreach (var card in cards)
                {
                    var x = X(card.X); var y = Y(card.Y); var w = card.Width * scale; var h = card.Height * scale;
                    Rect(xml, x, y, w, h, card.Type == "note" ? colors.Note : colors.Media, 2);
                    if (card.AssetId != null && pictures.TryGetValue(card.AssetId, out var picture) && w > 4 && h > 5)
                    {
                        Position(xml, "image", x + 1, y + 1, w - 2, h - 3);
                        xml.WriteAttributeString("href", picture);
                        xml.WriteEndElement();
                    }
                    else if (card.Type == "note" && w > 26 && h > 12)
                    {
                        xml.WriteStartElement("text");
                        xml.WriteAttributeString("x", Number(x + 3)); xml.WriteAttributeString("y", Number(y + 8));
                        xml.WriteAttributeString("fill", colors.NoteText); xml.WriteAttributeString("font-size", "6");
                        var capacity = Math.Clamp((int)(w / 6), 1, 22);
                        xml.WriteString(string.Concat(card.Text.TakeWhile(character => character != '\n').Where(XmlConvert.IsXmlChar).Take(capacity)));
                        xml.WriteEndElement();
                    }
                }
            }
            xml.WriteEndElement();
        }
        return Encoding.UTF8.GetBytes(svg.ToString());
    }

    private static string Number(double value) => value.ToString("0.###", CultureInfo.InvariantCulture);
    private static void Position(XmlWriter xml, string kind, double x, double y, double w, double h)
    {
        xml.WriteStartElement(kind);
        xml.WriteAttributeString("x", Number(x)); xml.WriteAttributeString("y", Number(y));
        xml.WriteAttributeString("width", Number(w)); xml.WriteAttributeString("height", Number(h));
    }
    private static void Rect(XmlWriter xml, double x, double y, double w, double h, string color, int radius = 0)
    {
        Position(xml, "rect", x, y, w, h);
        xml.WriteAttributeString("fill", color);
        if (radius > 0) xml.WriteAttributeString("rx", radius.ToString(CultureInfo.InvariantCulture));
        xml.WriteEndElement();
    }
}
