using System.Net;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using MshTV.Core;
using MshTV.Infrastructure;
using MshTV.Server.Export;
using MshTV.Server.Library;
using MshTV.Server.Workspace;

namespace MshTV.Server.Clipboard;

internal sealed record CopyClipboardRequest(long Revision, string[]? ItemIds, string[]? GroupIds);
internal sealed record ClipboardFailure(string Name, string Reason);

internal static class ClipboardEndpoints
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly SemaphoreSlim WriteSlot = new(1);
    private static readonly string[] ProxyHeaders = ["Forwarded", "Via", "X-Real-IP"];

    public static void MapFileClipboard(this WebApplication app)
    {
        app.MapGet("/api/v1/clipboard/capability", (HttpContext context) =>
        {
            var reason = UnavailableReason(context);
            return Results.Ok(new { available = reason == null, reason });
        });
        app.MapPost("/api/v1/clipboard/files", Copy);
    }

    private static string? UnavailableReason(HttpContext context)
    {
        var request = context.Request;
        var host = request.Host.Host;
        var port = request.Host.Port ?? (request.IsHttps ? 443 : 80);
        if (host is not ("127.0.0.1" or "localhost" or "[::1]") ||
            context.Connection.RemoteIpAddress is not { } remote || !IPAddress.IsLoopback(remote) ||
            context.Connection.LocalIpAddress is not { } local || !IPAddress.IsLoopback(local) ||
            port != context.Connection.LocalPort ||
            request.Headers.Keys.Any(header => header.StartsWith("X-Forwarded-", StringComparison.OrdinalIgnoreCase)) ||
            ProxyHeaders.Any(request.Headers.ContainsKey) ||
            !request.Headers.UserAgent.ToString().Contains("Windows NT", StringComparison.Ordinal) ||
            request.Headers["Sec-Fetch-Site"] != "same-origin")
            return "请用 Windows 后端电脑上的浏览器直接打开本机 MshTV 页面。其他设备可使用导出或下载。";

        return WindowsFileClipboard.IsDesktopAvailable() ? null : "当前后端没有可用的 Windows 交互式桌面剪贴板。";
    }

    private static async Task<IResult> Copy(CopyClipboardRequest request, HttpContext context, CanvasDatabase db,
        IHostApplicationLifetime lifetime, CancellationToken ct)
    {
        if (UnavailableReason(context) is { } unavailable)
            return Results.Problem(statusCode: 403, title: unavailable);
        if (request.ItemIds is { Length: > 10000 } || request.GroupIds is { Length: > 1000 })
            return Results.Problem(statusCode: 400, title: "选中的画布元素过多。");
        if (!await WriteSlot.WaitAsync(0, ct))
            return Results.Problem(statusCode: 409, title: "正在复制文件，请稍后重试。");

        using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(ct, lifetime.ApplicationStopping);
        cancellation.CancelAfter(TimeSpan.FromSeconds(25));
        try { return await CopySelection(request, WorkspaceScope.Get(context), db, cancellation.Token); }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested && !lifetime.ApplicationStopping.IsCancellationRequested)
        { return Results.Problem(statusCode: 408, title: "复制超时，请减少选中的文件后重试。"); }
        finally { WriteSlot.Release(); }
    }

    private static async Task<IResult> CopySelection(CopyClipboardRequest request, WorkspaceScope scope, CanvasDatabase db, CancellationToken ct)
    {
        var board = await WorkspaceScope.LiveBoards(db).AsNoTracking().SingleOrDefaultAsync(row => row.Id == scope.BoardId && row.LibraryId == scope.LibraryId, ct);
        if (board == null) return WorkspaceScope.Changed();
        var document = JsonSerializer.Deserialize<BoardDocument>(board.DocumentJson, Json)!;
        var items = (request.ItemIds ?? []).ToHashSet();
        var groups = (request.GroupIds ?? []).ToHashSet();
        if (board.Revision != request.Revision || !items.IsSubsetOf(document.Items.Select(item => item.Id)) ||
            !groups.IsSubsetOf(document.Groups.Select(group => group.Id)))
            return Results.Problem(statusCode: 409, title: "画布或选区已变化，请重新选择后复制。");

        var selected = document.Items.Where(item => items.Contains(item.Id) || item.GroupId != null && groups.Contains(item.GroupId)).ToList();
        var media = selected.Where(item => item.Type is "image" or "video" or "audio" && Guid.TryParse(item.AssetId, out _))
            .DistinctBy(item => item.AssetId, StringComparer.OrdinalIgnoreCase).ToList();
        var ignored = selected.Count(item => item.Type == "note" || !Guid.TryParse(item.AssetId, out _));
        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var files = new List<(string Path, string Name)>();
        var failures = new List<ClipboardFailure>();
        var unavailable = 0;
        var pathBytes = 22L;
        foreach (var batch in media.Chunk(200))
        {
            var ids = batch.Select(item => item.AssetId!).ToArray();
            var sources = await ScopedAsset.Query(db, scope.LibraryId).Where(row => ids.Contains(row.Asset.Id))
                .ToDictionaryAsync(row => row.Asset.Id, ct);
            foreach (var item in batch)
            {
                ct.ThrowIfCancellationRequested();
                var source = sources.GetValueOrDefault(item.AssetId!);
                var reason = ResolveOriginal(item.Type, source, out var path);
                if (reason != null)
                {
                    unavailable++;
                    if (failures.Count < 30) failures.Add(new(source?.Asset.Name ?? item.Title, reason));
                }
                else if (paths.Add(path!))
                {
                    var filePath = path!;
                    var name = Path.GetFileName(filePath);
                    if (source!.PhysicalRoot.Id == LibraryRoot.ImportedRootId && ExportDirectory.ValidName(source.Asset.Name) &&
                        string.Equals(Path.GetExtension(name), Path.GetExtension(source.Asset.Name), StringComparison.OrdinalIgnoreCase))
                        name = source.Asset.Name;
                    files.Add((filePath, name));
                    pathBytes += 2L * (filePath.Length + 1);
                    if (pathBytes > WindowsFileClipboard.MaxBytes)
                        return Results.Problem(statusCode: 400, title: "文件路径列表过长，请分批复制。");
                }
            }
        }

        if (paths.Count > 0)
        {
            if (!await scope.IsCurrent(db, ct)) return WorkspaceScope.Changed();
            if (!WindowsFileClipboard.IsDesktopAvailable())
                return Results.Problem(statusCode: 403, title: "Windows 桌面剪贴板当前不可用。");
            try
            {
                if (!WindowsFileClipboard.Write(files, ct))
                    return Results.Problem(statusCode: 423, title: "剪贴板正被其他程序占用，请稍后重试。");
            }
            catch (IOException e) { return Results.Problem(statusCode: 503, title: e.Message); }
        }
        return Results.Ok(new { copied = paths.Count, unavailable, ignored, failures });
    }

    private static string? ResolveOriginal(string kind, ScopedAsset? entry, out string? path)
    {
        path = null;
        if (entry == null || entry.Asset.Kind != kind) return "素材记录不存在或类型不符。";
        if (entry.Status is "removed" or "sourceRemoved") return "素材或来源已移除。";
        if (entry.Status == "offline") return "素材来源离线。";
        if (entry.Status == "missing") return "原文件缺失。";
        if (entry.Status != "ready") return "原文件尚未就绪。";
        var asset = entry.Asset;
        var root = entry.PhysicalRoot;
        try
        {
            var drive = Path.GetPathRoot(root.Path);
            if (drive is not { Length: 3 } || drive[1] != ':' ||
                new DriveInfo(drive).DriveType is not (DriveType.Fixed or DriveType.Removable))
                return "原文件不在受支持的本地磁盘上。";
            using var source = SafeMediaFiles.Open(root.Path, asset.RelativePath);
            var modified = new DateTimeOffset(File.GetLastWriteTimeUtc(source.SafeFileHandle)).ToUnixTimeMilliseconds();
            if (source.Length != asset.Size || modified != asset.ModifiedAt ||
                (asset.FileKey != null && SafeMediaFiles.Identity(source) != asset.FileKey))
                return "原文件已变化，请等待素材库更新。";
            var original = SafeMediaFiles.FinalPath(source.SafeFileHandle);
            if (LibraryTypes.Kind(Path.GetExtension(original)) != kind) return "原文件类型不符。";
            path = original;
            return null;
        }
        catch (FileNotFoundException) { return "原文件缺失。"; }
        catch (DirectoryNotFoundException) { return "原文件所在目录缺失。"; }
        catch (UnauthorizedAccessException) { return "没有读取原文件的权限。"; }
        catch (Exception e) when (e is IOException or ArgumentException or NotSupportedException)
        { return "原文件路径无效或当前无法读取。"; }
    }
}
