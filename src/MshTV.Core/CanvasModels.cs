namespace MshTV.Core;

public record CanvasItem(string Id, string Type, string? AssetId, string Title, string Text,
    double X, double Y, double Width, double Height, string? GroupId, List<NoteSpan>? NoteSpans = null);
public record NoteSpan(int From, int To, bool Bold = false, bool Italic = false, bool Underline = false, bool Red = false);
public record CanvasGroup(string Id, string Name, double? X = null, double? Y = null, double? Width = null, double? Height = null);
public record BoardDocument(int SchemaVersion, string Name, List<CanvasItem> Items, List<CanvasGroup> Groups);
public record BoardSnapshot(string Id, long Revision, BoardDocument Document);
public record BoardOperation(string Kind, CanvasItem? Item = null, CanvasGroup? Group = null, string? Id = null);
public record MutationRequest(long BaseRevision, string ClientId, string MutationId, List<BoardOperation> Operations);
public record MutationResult(long Revision);

public static class BoardRules
{
    // Additive compatibility for saved groups that only had id/name and derived their bounds.
    // IDs, member coordinates and the board revision remain unchanged on read.
    public static BoardDocument Normalize(BoardDocument doc) => doc with
    {
        Groups = doc.Groups.Select(group =>
        {
            if (group.X != null || group.Y != null || group.Width != null || group.Height != null) return group;
            var members = doc.Items.Where(i => i.GroupId == group.Id).ToList();
            var x = members.Count > 0 ? members.Min(i => i.X) : 0;
            var y = members.Count > 0 ? members.Min(i => i.Y) : 0;
            var right = members.Count > 0 ? members.Max(i => i.X + i.Width) : 320;
            var bottom = members.Count > 0 ? members.Max(i => i.Y + i.Height) : 200;
            return group with { X = x - 24, Y = y - 48, Width = Math.Max(80, right - x + 48), Height = Math.Max(80, bottom - y + 72) };
        }).ToList()
    };

    private static bool ValidDimension(double? value, double minimum, double maximum) =>
        value is double number && double.IsFinite(number) && number >= minimum && number <= maximum;

    public static void Validate(BoardDocument doc)
    {
        if (doc.SchemaVersion != 1 || doc.Items.Count > 10000 || doc.Groups.Count > 1000)
            throw new ArgumentException("画布版本或元素数量无效。");
        if (doc.Items.Select(x => x.Id).Distinct().Count() != doc.Items.Count ||
            doc.Groups.Select(x => x.Id).Distinct().Count() != doc.Groups.Count)
            throw new ArgumentException("元素 ID 重复。");
        foreach (var group in doc.Groups)
            if (group == null || !Guid.TryParse(group.Id, out _) || string.IsNullOrWhiteSpace(group.Name) || group.Name.Length > 100 ||
                !ValidDimension(group.X, -1e9, 1e9) || !ValidDimension(group.Y, -1e9, 1e9) ||
                !ValidDimension(group.Width, 80, 1e9) || !ValidDimension(group.Height, 80, 1e9))
                throw new ArgumentException("分组无效。");
        foreach (var item in doc.Items)
        {
            if (item == null || !Guid.TryParse(item.Id, out _) || item.Type is not ("image" or "video" or "audio" or "note") ||
                item.Title == null || item.Text == null || item.Title.Length > 200 || item.Text.Length > 10000 ||
                !double.IsFinite(item.X) || !double.IsFinite(item.Y) || Math.Abs(item.X) > 1e9 || Math.Abs(item.Y) > 1e9 ||
                !double.IsFinite(item.Width) || !double.IsFinite(item.Height) ||
                item.Width < 40 || item.Height < 40 || item.Width > 10000 || item.Height > 10000 ||
                (item.GroupId != null && !doc.Groups.Any(g => g.Id == item.GroupId)) ||
                (item.AssetId != null && item.AssetId is not ("sample-dunes" or "sample-coast" or "sample-studio") && !Guid.TryParse(item.AssetId, out _)))
                throw new ArgumentException("卡片数据无效。");
            if (item.NoteSpans is { Count: > 2000 } || (item.Type != "note" && item.NoteSpans is { Count: > 0 }))
                throw new ArgumentException("备注样式数据无效。");
            var previousEnd = 0;
            foreach (var span in item.NoteSpans ?? [])
            {
                if (span == null || span.From < previousEnd || span.From < 0 || span.To <= span.From || span.To > item.Text.Length ||
                    !(span.Bold || span.Italic || span.Underline || span.Red) ||
                    (span.From > 0 && char.IsLowSurrogate(item.Text[span.From])) ||
                    (span.To < item.Text.Length && char.IsLowSurrogate(item.Text[span.To])))
                    throw new ArgumentException("备注样式范围无效。");
                previousEnd = span.To;
            }
        }
    }

    public static BoardDocument Apply(BoardDocument doc, List<BoardOperation> operations)
    {
        doc = Normalize(doc);
        var items = doc.Items.ToDictionary(x => x.Id);
        var groups = doc.Groups.ToDictionary(x => x.Id);
        if (operations.Count is 0 or > 500) throw new ArgumentException("每批需要 1–500 个操作。");
        foreach (var op in operations)
        {
            if (op == null) throw new ArgumentException("操作不能为空。");
            switch (op.Kind)
            {
                case "putItem" when op.Item != null: items[op.Item.Id] = op.Item; break;
                case "deleteItem" when op.Id != null: items.Remove(op.Id); break;
                case "putGroup" when op.Group != null: groups[op.Group.Id] = op.Group; break;
                case "deleteGroup" when op.Id != null: groups.Remove(op.Id); break;
                default: throw new ArgumentException("未知操作。");
            }
        }
        var next = Normalize(doc with { Items = items.Values.ToList(), Groups = groups.Values.ToList() });
        Validate(next);
        return next;
    }
}
