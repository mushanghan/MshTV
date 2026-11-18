using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using MshTV.Core;
using MshTV.Infrastructure;
using MshTV.Server.Library;
using MshTV.Server.Export;

namespace MshTV.Server.Workspace;

internal record WorkspaceCreate(string? Name, string? GroupId);
internal record WorkspaceEdit(string? Action, long? Revision, string? Name, string? GroupId, bool? Pinned);
internal record BoardCard(string Id, string Name, string? GroupId, long Revision, long CreatedAt, long ModifiedAt, long? DeletedAt, bool Pinned);
internal record GroupCard(string Id, string Name, long Revision, long CreatedAt, long? DeletedAt, int BoardCount);
internal record BoardProject(int FormatVersion, string LibraryId, long Revision, BoardDocument Document);

internal static class WorkspaceEndpoints
{
    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static void MapWorkspace(this WebApplication app)
    {
        var routes = app.MapGroup("/api/v1/workspace");
        routes.MapGet("/", List);
        routes.MapPost("/boards", CreateBoard);
        routes.MapPost("/groups", CreateGroup);
        routes.MapPatch("/boards/{id}", EditBoard);
        routes.MapPatch("/groups/{id}", EditGroup);
        routes.MapGet("/boards/{id}/cover", WorkspaceCover.Get);
        routes.MapGet("/boards/{id}/project", DownloadProject);
        routes.MapPost("/projects", ImportProject).WithMetadata(new RequestSizeLimitAttribute(32 * 1024 * 1024));
    }

    private static async Task<IResult> DownloadProject(string id, CanvasDatabase db, CancellationToken ct)
    {
        var board = await WorkspaceScope.LiveBoards(db).AsNoTracking().SingleOrDefaultAsync(row => row.Id == id, ct);
        if (board == null) return Results.NotFound();
        var project = new BoardProject(1, board.LibraryId, board.Revision, BoardRules.Normalize(Document(board)));
        return Results.File(JsonSerializer.SerializeToUtf8Bytes(project, Json), "application/json",
            ExportDirectory.CleanName(board.Name, "MshTV") + ".mshtv");
    }

    private static Task<IResult> ImportProject(BoardProject project, CanvasDatabase db, DatabaseWriteGate gate, CancellationToken ct) =>
        Write(db, gate, ct, async () =>
        {
            var doc = project.Document;
            if (project.FormatVersion != 1 || doc?.Items == null || doc.Groups == null ||
                doc.Items.Any(item => item == null) || doc.Groups.Any(group => group == null))
                return Results.Problem(statusCode: 400, title: "工程文件格式无效。");
            var name = ValidName(doc.Name);
            if (name == null) return InvalidName();
            try { doc = BoardRules.Normalize(doc); BoardRules.Validate(doc); }
            catch (ArgumentException e) { return Results.Problem(statusCode: 400, title: e.Message); }
            var references = doc.Items.Where(item => Guid.TryParse(item.AssetId, out _)).ToLookup(item => item.AssetId!);
            foreach (var ids in references.Select(items => items.Key).Chunk(200))
            {
                var assets = await ScopedAsset.Query(db, project.LibraryId).Where(row => ids.Contains(row.Asset.Id))
                    .Select(row => new { row.Asset.Id, row.Asset.Kind }).ToListAsync(ct);
                if (assets.Count != ids.Length || assets.Any(asset => references[asset.Id].Any(item => item.Type != asset.Kind)))
                    return Results.Problem(statusCode: 409, title: "本机素材库缺少工程引用。请先恢复原工作空间备份后再导入。");
            }
            var board = await AddBoard(db, name, null, doc, ct);
            if (references.Count > 0)
                await ShareReferences(db, new BoardRow { LibraryId = project.LibraryId, DocumentJson = board.DocumentJson }, board.LibraryId, ct);
            return Results.Ok(Card(board));
        });

    private static async Task<IResult> List(CanvasDatabase db, CancellationToken ct)
    {
        // Card metadata stays separate from the potentially large editor documents.
        var boards = await db.Boards.AsNoTracking().OrderByDescending(row => row.Pinned).ThenByDescending(row => row.ModifiedAt)
            .Select(row => new BoardCard(row.Id, row.Name, row.GroupId, row.Revision, row.CreatedAt, row.ModifiedAt, row.DeletedAt, row.Pinned)).ToListAsync(ct);
        var groups = await db.WorkspaceGroups.AsNoTracking().OrderByDescending(row => row.CreatedAt)
            .Select(row => new GroupCard(row.Id, row.Name, row.Revision, row.CreatedAt, row.DeletedAt,
                db.Boards.Count(board => board.GroupId == row.Id && (row.DeletedAt != null || board.DeletedAt == null)))).ToListAsync(ct);
        return Results.Ok(new { boards, groups });
    }

    private static Task<IResult> CreateBoard(WorkspaceCreate request, CanvasDatabase db, DatabaseWriteGate gate, CancellationToken ct) =>
        Write(db, gate, ct, async () =>
        {
            var name = ValidName(request.Name);
            if (name == null) return InvalidName();
            var group = await Group(db, request.GroupId, ct);
            if (request.GroupId != null && group is not { DeletedAt: null }) return Results.NotFound();
            var board = await AddBoard(db, name, group, new(1, name, [], []), ct);
            return Results.Ok(Card(board));
        });

    private static Task<IResult> CreateGroup(WorkspaceCreate request, CanvasDatabase db, DatabaseWriteGate gate, CancellationToken ct) =>
        Write(db, gate, ct, () =>
        {
            var name = ValidName(request.Name);
            if (name == null) return Task.FromResult(InvalidName());
            var id = Guid.NewGuid().ToString();
            var row = new WorkspaceGroupRow { Id = id, Name = name, CreatedAt = LibraryTypes.Now };
            db.MaterialLibraries.Add(new() { Id = id });
            db.WorkspaceGroups.Add(row);
            return Task.FromResult(Results.Ok(new GroupCard(id, name, 0, row.CreatedAt, null, 0)));
        });

    private static Task<IResult> EditBoard(string id, WorkspaceEdit request, CanvasDatabase db, DatabaseWriteGate gate, CancellationToken ct) =>
        Write(db, gate, ct, async () =>
        {
            var board = await db.Boards.FindAsync([id], ct);
            if (board == null) return Results.NotFound();
            if (request.Revision != board.Revision) return Conflict();
            var group = await Group(db, board.GroupId, ct);
            if (request.Action == "purge")
            {
                if (board.DeletedAt == null) return TrashRequired();
                await PurgeBoards(db, db.Boards.Where(row => row.Id == id), ct);
                if (group != null) group.Revision++;
                return Results.Ok(new { removed = true });
            }
            if (group?.DeletedAt != null) return Results.Problem(statusCode: 409, title: "请先恢复这张画布所属的画布组。");
            if (board.DeletedAt != null && request.Action != "restore") return Results.NotFound();
            var now = LibraryTypes.Now;
            switch (request.Action)
            {
                case "rename":
                    var name = ValidName(request.Name);
                    if (name == null) return InvalidName();
                    board.Name = name;
                    board.DocumentJson = JsonSerializer.Serialize(Document(board) with { Name = name }, Json);
                    break;
                case "pin" when request.Pinned is bool pinned:
                    board.Pinned = pinned;
                    break;
                case "move":
                    if (board.GroupId == request.GroupId) return Results.Ok(Card(board));
                    var target = await Group(db, request.GroupId, ct);
                    if (request.GroupId != null && target is not { DeletedAt: null }) return Results.NotFound();
                    var destination = target?.Id ?? Guid.NewGuid().ToString();
                    if (target == null) { db.MaterialLibraries.Add(new() { Id = destination }); await db.SaveChangesAsync(ct); }
                    if (group == null)
                    {
                        await MergeLibrary(db, board.LibraryId, destination, ct);
                        await ShareReferences(db, board, destination, ct);
                        await Archive(db, board.LibraryId, true, ct);
                    }
                    else await ShareReferences(db, board, destination, ct);
                    board.GroupId = target?.Id; board.LibraryId = destination;
                    if (group != null) group.Revision++;
                    if (target != null) target.Revision++;
                    break;
                case "copy":
                    var copyName = ValidName(request.Name) ?? $"{ValidName(board.Name.Length <= 95 ? board.Name : board.Name[..95]) ?? "画布"} 副本";
                    var copy = await AddBoard(db, copyName, group, Document(board), ct);
                    if (group == null) await ShareReferences(db, board, copy.LibraryId, ct);
                    return Results.Ok(Card(copy));
                case "delete":
                    board.DeletedAt = now;
                    if (group == null) await Archive(db, board.LibraryId, true, ct);
                    else group.Revision++;
                    break;
                case "restore" when board.DeletedAt != null:
                    board.DeletedAt = null;
                    if (group == null) await Archive(db, board.LibraryId, false, ct);
                    else group.Revision++;
                    break;
                default: return Results.Problem(statusCode: 400, title: "画布操作无效。");
            }
            board.Revision++; board.ModifiedAt = now;
            return Results.Ok(Card(board));
        });

    private static Task<IResult> EditGroup(string id, WorkspaceEdit request, CanvasDatabase db, DatabaseWriteGate gate, CancellationToken ct) =>
        Write(db, gate, ct, async () =>
        {
            var group = await Group(db, id, ct);
            if (group == null || group.DeletedAt != null && request.Action is not ("restore" or "purge")) return Results.NotFound();
            if (group.Revision != request.Revision) return Conflict();
            switch (request.Action)
            {
                case "rename":
                    var name = ValidName(request.Name);
                    if (name == null) return InvalidName();
                    group.Name = name;
                    break;
                case "delete": group.DeletedAt = LibraryTypes.Now; await Archive(db, id, true, ct); break;
                case "restore" when group.DeletedAt != null: group.DeletedAt = null; await Archive(db, id, false, ct); break;
                case "purge":
                    if (group.DeletedAt == null) return TrashRequired();
                    await PurgeBoards(db, db.Boards.Where(row => row.GroupId == id), ct);
                    db.WorkspaceGroups.Remove(group);
                    return Results.Ok(new { removed = true });
                default: return Results.Problem(statusCode: 400, title: "画布组操作无效。");
            }
            group.Revision++;
            var count = await db.Boards.CountAsync(row => row.GroupId == id && (group.DeletedAt != null || row.DeletedAt == null), ct);
            return Results.Ok(new GroupCard(id, group.Name, group.Revision, group.CreatedAt, group.DeletedAt, count));
        });

    private static async Task PurgeBoards(CanvasDatabase db, IQueryable<BoardRow> boards, CancellationToken ct)
    {
        await db.Receipts.Where(receipt => boards.Any(board => receipt.Key.StartsWith(board.Id + ":"))).ExecuteDeleteAsync(ct);
        await boards.ExecuteDeleteAsync(ct);
    }

    private static async Task<IResult> Write(CanvasDatabase db, DatabaseWriteGate gate, CancellationToken ct, Func<Task<IResult>> operation)
    {
        await gate.Semaphore.WaitAsync(ct);
        try
        {
            await using var transaction = await db.Database.BeginTransactionAsync(ct);
            var result = await operation();
            if (result is IStatusCodeHttpResult { StatusCode: >= 400 }) return result;
            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
            return result;
        }
        finally { gate.Semaphore.Release(); }
    }

    private static async Task<BoardRow> AddBoard(CanvasDatabase db, string name, WorkspaceGroupRow? group, BoardDocument doc, CancellationToken ct)
    {
        var id = Guid.NewGuid().ToString();
        var now = LibraryTypes.Now;
        if (group == null) db.MaterialLibraries.Add(new() { Id = id });
        else group.Revision++;
        var board = new BoardRow { Id = id, GroupId = group?.Id, LibraryId = group?.Id ?? id, Name = name, CreatedAt = now,
            ModifiedAt = now, DocumentJson = JsonSerializer.Serialize(doc with { Name = name }, Json) };
        db.Boards.Add(board);
        await db.SaveChangesAsync(ct);
        return board;
    }

    private static async Task ShareReferences(CanvasDatabase db, BoardRow board, string destination, CancellationToken ct)
    {
        foreach (var ids in Document(board).Items.Select(item => item.AssetId).OfType<string>().Where(id => Guid.TryParse(id, out _)).Distinct().Chunk(200))
        {
            var candidates = await ScopedAsset.Query(db, board.LibraryId).Where(row => ids.Contains(row.Asset.Id)).ToListAsync(ct);
            var targets = await ScopedAsset.Query(db, destination).Where(row => ids.Contains(row.Asset.Id)).ToDictionaryAsync(row => row.Asset.Id, ct);
            foreach (var row in candidates)
            {
                var importedRoot = row.PhysicalRoot.Id == LibraryRoot.ImportedRootId ? row.PhysicalRoot.Id : null;
                if (!targets.TryGetValue(row.Asset.Id, out var existing))
                {
                    // The destination has no watcher for this reference. Follow physical asset recovery,
                    // but keep a missing association when the file moved outside its authorized source.
                    var missingFromScope = row.Source == null ? row.Member.Missing :
                        !SafeMediaFiles.Within(row.Source.Path, row.Asset.PhysicalPath);
                    db.LibraryMembers.Add(new() { LibraryId = destination, AssetId = row.Asset.Id,
                        Removed = row.Status is "removed" or "sourceRemoved", Missing = missingFromScope,
                        RootId = importedRoot });
                }
                else if ((row.Status is "ready" or "pending") && (existing.Status is "removed" or "sourceRemoved" or "missing" or "offline"))
                {
                    // An explicit transfer reattaches a usable reference needed by the incoming board.
                    db.LibraryMembers.Attach(existing.Member);
                    existing.Member.Removed = false; existing.Member.Missing = false; existing.Member.Revision++;
                    if (existing.Source is { Removed: true } or { Online: false } ||
                        existing.Source != null && !SafeMediaFiles.Within(existing.Source.Path, row.Asset.PhysicalPath))
                        existing.Member.RootId = importedRoot;
                }
            }
        }
    }

    private static async Task MergeLibrary(CanvasDatabase db, string source, string destination, CancellationToken ct)
    {
        var roots = await db.LibraryRoots.AsNoTracking().Where(root => root.LibraryId == source && root.Id != LibraryRoot.ImportedRootId).ToListAsync(ct);
        var targets = await db.LibraryRoots.AsNoTracking().Where(root => root.LibraryId == destination).ToListAsync(ct);
        foreach (var root in roots)
        {
            var target = targets.Find(candidate => string.Equals(candidate.Path, root.Path, StringComparison.OrdinalIgnoreCase));
            if (target == null)
            {
                target = new LibraryRoot { LibraryId = destination, Path = root.Path, Enabled = root.Enabled, Removed = root.Removed,
                    Online = root.Online, LastScanAt = root.LastScanAt, Error = root.Error,
                    IncludeSubdirectories = root.IncludeSubdirectories, NewFilesOnly = root.NewFilesOnly, BaselinePending = root.BaselinePending };
                db.LibraryRoots.Add(target); targets.Add(target);
                await db.SaveChangesAsync(ct);
                await db.Database.ExecuteSqlInterpolatedAsync($"""
                    INSERT INTO LibraryIgnoredFiles (RootId, PathKey, RelativePath, FileKey)
                    SELECT {target.Id}, PathKey, RelativePath, FileKey FROM LibraryIgnoredFiles WHERE RootId = {root.Id}
                    """, ct);
            }
            await MergeMembers(db, source, destination, root.Id, target.Id, ct);
        }
        await MergeMembers(db, source, destination, LibraryRoot.ImportedRootId, LibraryRoot.ImportedRootId, ct);
        await MergeMembers(db, source, destination, null, null, ct);
    }

    private static Task<int> MergeMembers(CanvasDatabase db, string source, string destination, string? from, string? to, CancellationToken ct) =>
        db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO LibraryMembers (LibraryId, AssetId, RootId, Removed, Missing, Revision, SeenScan)
            SELECT {destination}, AssetId, {to}, Removed, Missing, 0, SeenScan FROM LibraryMembers
            WHERE LibraryId = {source} AND RootId IS {from}
            ON CONFLICT (LibraryId, AssetId) DO NOTHING
            """, ct);

    private static async Task Archive(CanvasDatabase db, string id, bool archived, CancellationToken ct)
    {
        var library = await db.MaterialLibraries.FindAsync([id], ct) ?? throw new InvalidOperationException("Missing material library");
        library.Archived = archived;
    }

    private static async Task<WorkspaceGroupRow?> Group(CanvasDatabase db, string? id, CancellationToken ct) =>
        id == null ? null : await db.WorkspaceGroups.FindAsync([id], ct);
    internal static BoardDocument Document(BoardRow board) => JsonSerializer.Deserialize<BoardDocument>(board.DocumentJson, Json)!;
    private static string? ValidName(string? name) => name?.Trim() is { Length: > 0 and <= 100 } value && !value.Any(char.IsControl) ? value : null;
    private static BoardCard Card(BoardRow row) => new(row.Id, row.Name, row.GroupId, row.Revision, row.CreatedAt, row.ModifiedAt, row.DeletedAt, row.Pinned);
    private static IResult InvalidName() => Results.Problem(statusCode: 400, title: "请输入 1 至 100 个字符的名称。");
    private static IResult Conflict() => Results.Problem(statusCode: 409, title: "这项内容已变化，请刷新后重试。");
    private static IResult TrashRequired() => Results.Problem(statusCode: 409, title: "请先将这项内容移入回收站。");
}
