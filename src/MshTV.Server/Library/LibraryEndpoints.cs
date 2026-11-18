using Microsoft.EntityFrameworkCore;
using MshTV.Core;
using MshTV.Infrastructure;
using MshTV.Server.Workspace;
using MshTV.Server.Network;

namespace MshTV.Server.Library;

public static class LibraryEndpoints
{
    public static void MapLibrary(this WebApplication app)
    {
        app.MapGet("/api/v1/assets/drop-candidates", DropCandidates.Find);
        app.MapPost("/api/v1/assets/import", DropImport.Save);
        app.MapGet("/api/v1/media/{id}/waveform", (string id, long? v, HttpContext context, AudioWaveforms waveforms, CanvasDatabase db,
            IHostApplicationLifetime lifetime, CancellationToken ct) =>
            waveforms.Get(id, v, WorkspaceScope.Get(context), db, lifetime.ApplicationStopping, ct));
        app.MapGet("/api/v1/library/roots", ListRoots);
        app.MapGet("/api/v1/library/tools", () => Results.Ok(new { ffmpeg = MediaProcessor.Tool("ffmpeg") != null, ffprobe = MediaProcessor.Tool("ffprobe") != null }));
        app.MapPost("/api/v1/library/roots", AddRoot);
        app.MapPatch("/api/v1/library/roots/{id}", UpdateRoot);
        app.MapDelete("/api/v1/library/roots/{id}", (string id, HttpContext context, CanvasDatabase db, DatabaseWriteGate gate, LibraryWorker worker, CancellationToken ct) =>
            RemoveRoot(id, false, context, db, gate, worker, ct));
        app.MapDelete("/api/v1/library/roots/{id}/library", (string id, HttpContext context, CanvasDatabase db, DatabaseWriteGate gate, LibraryWorker worker, CancellationToken ct) =>
            RemoveRoot(id, true, context, db, gate, worker, ct));
        app.MapPost("/api/v1/library/roots/{id}/scan", async (string id, HttpContext context, CanvasDatabase db, LibraryWorker worker, CancellationToken ct) =>
        {
            if (id == LibraryRoot.ImportedRootId) return ManagedRoot();
            var library = WorkspaceScope.Get(context).LibraryId;
            if (!await db.LibraryRoots.AnyAsync(r => r.Id == id && r.LibraryId == library && !r.Removed, ct)) return Results.NotFound();
            worker.RequestScan(id, true); return Results.Accepted(value: new { });
        });
        app.MapDelete("/api/v1/assets/{id}", RemoveAsset);
        app.MapGet("/api/v1/assets", ListAssets);
        app.MapGet("/api/v1/assets/batch", async (HttpContext context, CanvasDatabase db, CancellationToken ct) =>
        {
            var ids = context.Request.Query["ids"].ToString().Split(',', StringSplitOptions.RemoveEmptyEntries);
            if (ids.Length > 100 || ids.Any(id => !Guid.TryParse(id, out _))) return Results.BadRequest();
            var rows = await ScopedAsset.Query(db, WorkspaceScope.Get(context).LibraryId).Where(row => ids.Contains(row.Asset.Id)).ToListAsync(ct);
            return Results.Ok(rows.Select(row => row.Dto()));
        });
        app.MapGet("/api/v1/assets/{id}", async (string id, HttpContext context, CanvasDatabase db, CancellationToken ct) =>
        {
            var row = await ScopedAsset.Query(db, WorkspaceScope.Get(context).LibraryId).SingleOrDefaultAsync(row => row.Asset.Id == id, ct);
            return row == null ? Results.NotFound() : Results.Ok(row.Dto());
        });
        app.MapMethods("/api/v1/media/{id}/{variant}", ["GET", "HEAD"], ServeMedia);
        app.MapHub<LibraryHub>("/api/v1/events");
    }

    private static async Task<IResult> ListRoots(bool? includeImports, HttpContext context, CanvasDatabase db, CancellationToken ct)
    {
        var library = WorkspaceScope.Get(context).LibraryId;
        var roots = await db.LibraryRoots.AsNoTracking().Where(root => !root.Removed && root.Id != LibraryRoot.ImportedRootId &&
            root.LibraryId == library).ToListAsync(ct);
        if (includeImports == true && await db.LibraryMembers.AnyAsync(row => row.LibraryId == library && row.RootId == LibraryRoot.ImportedRootId, ct))
        {
            var imported = await db.LibraryRoots.AsNoTracking().SingleAsync(root => root.Id == LibraryRoot.ImportedRootId, ct);
            roots.Add(imported);
        }
        var rows = roots.Select(RootDto.From);
        if (AccessSessions.IsRemote(context))
            rows = rows.Select(root => root with { Path = Path.GetFileName(Path.TrimEndingDirectorySeparator(root.Path)) });
        return Results.Ok(rows);
    }

    private static async Task<IResult> AddRoot(RootRequest request, HttpContext context, CanvasDatabase db, LibraryPaths paths,
        DatabaseWriteGate gate, LibraryWorker worker, CancellationToken ct)
    {
        string full;
        try { full = SafeMediaFiles.NormalizeRoot(request.Path, paths.Data); }
        catch (Exception e) when (e is IOException or ArgumentException or UnauthorizedAccessException or NotSupportedException)
        { return Results.Problem(statusCode: 400, title: "无法添加：请输入后端可读的本地目录，不能是链接、共享路径或应用数据目录。"); }
        var scope = WorkspaceScope.Get(context);
        await gate.Semaphore.WaitAsync(ct);
        LibraryRoot root;
        try
        {
            if (!await scope.IsCurrent(db, ct)) return WorkspaceScope.Changed();
            var roots = await db.LibraryRoots.Where(root => root.LibraryId == scope.LibraryId && root.Id != LibraryRoot.ImportedRootId).ToListAsync(ct);
            root = roots.FirstOrDefault(r => string.Equals(r.Path, full, StringComparison.OrdinalIgnoreCase)) ??
                new LibraryRoot { Path = full, LibraryId = scope.LibraryId };
            if (!roots.Contains(root))
            {
                if (roots.Any(r => !r.Removed && (SafeMediaFiles.Within(r.Path, full) || SafeMediaFiles.Within(full, r.Path))))
                    return Results.Problem(statusCode: 400, title: "目录与当前素材库的已有来源重叠。");
                db.LibraryRoots.Add(root);
            }
            else if (!root.Removed)
            {
                if (root.IncludeSubdirectories != request.IncludeSubdirectories || root.NewFilesOnly != request.NewFilesOnly)
                    return Results.Problem(statusCode: 409, title: "这个文件夹已添加。上方选项只用于新目录；请在下方该文件夹的设置中修改扫描范围。");
                return Results.Ok(RootDto.From(root));
            }
            else root.Revision++;
            await using var transaction = await db.Database.BeginTransactionAsync(ct);
            await db.LibraryIgnoredFiles.Where(f => f.RootId == root.Id).ExecuteDeleteAsync(ct);
            var restore = db.LibraryMembers.Where(member => member.RootId == root.Id && member.Removed && !request.NewFilesOnly);
            var prefix = Prefix(full);
            if (!request.IncludeSubdirectories)
                restore = restore.Where(member => db.LibraryAssets.Any(asset => asset.Id == member.AssetId &&
                    asset.PhysicalPath.StartsWith(prefix) && !asset.PhysicalPath.Substring(prefix.Length).Contains("\\") &&
                    !asset.PhysicalPath.Substring(prefix.Length).Contains("/")));
            await restore.ExecuteUpdateAsync(p => p.SetProperty(row => row.Removed, false).SetProperty(row => row.Revision, row => row.Revision + 1), ct);
            root.IncludeSubdirectories = request.IncludeSubdirectories;
            root.NewFilesOnly = request.NewFilesOnly; root.BaselinePending = request.NewFilesOnly;
            root.Removed = false; root.Enabled = true; root.Online = true; root.Error = null;
            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
        }
        finally { gate.Semaphore.Release(); }
        worker.RequestScan(root.Id); await worker.Notify(allAssets: true, libraryId: scope.LibraryId);
        return Results.Ok(RootDto.From(root));
    }

    private static async Task<IResult> UpdateRoot(string id, RootSettings request, HttpContext context,
        CanvasDatabase db, DatabaseWriteGate gate, LibraryWorker worker, CancellationToken ct)
    {
        if (id == LibraryRoot.ImportedRootId) return ManagedRoot();
        var scope = WorkspaceScope.Get(context);
        var optionsChanged = false;
        await gate.Semaphore.WaitAsync(ct);
        try
        {
            if (!await scope.IsCurrent(db, ct)) return WorkspaceScope.Changed();
            var root = await db.LibraryRoots.SingleOrDefaultAsync(root => root.Id == id && root.LibraryId == scope.LibraryId && !root.Removed, ct);
            if (root == null) return Results.NotFound();
            if (root.Revision != request.Revision) return RootConflict();
            var recursive = request.IncludeSubdirectories ?? root.IncludeSubdirectories;
            var newOnly = request.NewFilesOnly ?? root.NewFilesOnly;
            optionsChanged = recursive != root.IncludeSubdirectories || newOnly != root.NewFilesOnly;
            await using var transaction = await db.Database.BeginTransactionAsync(ct);
            if (optionsChanged)
            {
                await db.LibraryIgnoredFiles.Where(f => f.RootId == id).ExecuteDeleteAsync(ct);
                root.IncludeSubdirectories = recursive; root.NewFilesOnly = newOnly; root.BaselinePending = newOnly;
            }
            root.Enabled = request.Enabled; root.Revision++;
            await db.SaveChangesAsync(ct); await transaction.CommitAsync(ct);
        }
        finally { gate.Semaphore.Release(); }
        if (optionsChanged || request.Enabled) worker.RequestScan(id, optionsChanged);
        await worker.Notify(allAssets: true, libraryId: scope.LibraryId);
        return Results.Ok(new { });
    }

    private static async Task<IResult> RemoveRoot(string id, bool suppressAssets, HttpContext context,
        CanvasDatabase db, DatabaseWriteGate gate, LibraryWorker worker, CancellationToken ct)
    {
        if (id == LibraryRoot.ImportedRootId) return ManagedRoot();
        var scope = WorkspaceScope.Get(context);
        await gate.Semaphore.WaitAsync(ct);
        try
        {
            if (!await scope.IsCurrent(db, ct)) return WorkspaceScope.Changed();
            var root = await db.LibraryRoots.SingleOrDefaultAsync(root => root.Id == id && root.LibraryId == scope.LibraryId && !root.Removed, ct);
            if (root == null) return Results.NotFound();
            if (!long.TryParse(context.Request.Query["revision"], out var revision) || root.Revision != revision) return RootConflict();
            await using var transaction = await db.Database.BeginTransactionAsync(ct);
            root.Removed = true; root.Enabled = false; root.Revision++;
            if (suppressAssets)
                await db.LibraryMembers.Where(member => member.RootId == id && member.LibraryId == scope.LibraryId && !member.Removed)
                    .ExecuteUpdateAsync(p => p.SetProperty(row => row.Removed, true).SetProperty(row => row.Revision, row => row.Revision + 1), ct);
            await db.SaveChangesAsync(ct); await transaction.CommitAsync(ct);
        }
        finally { gate.Semaphore.Release(); }
        await worker.Notify(allAssets: true, libraryId: scope.LibraryId);
        return Results.Ok(new { });
    }

    private static async Task<IResult> RemoveAsset(string id, HttpContext context, CanvasDatabase db, DatabaseWriteGate gate,
        LibraryWorker worker, CancellationToken ct)
    {
        var scope = WorkspaceScope.Get(context);
        await gate.Semaphore.WaitAsync(ct);
        try
        {
            if (!await scope.IsCurrent(db, ct)) return WorkspaceScope.Changed();
            var row = await ScopedAsset.Query(db, scope.LibraryId).SingleOrDefaultAsync(row => row.Asset.Id == id, ct);
            if (row == null) return Results.NotFound();
            if (!long.TryParse(context.Request.Query["revision"], out var revision) || row.Revision != revision)
                return Results.Problem(statusCode: 409, title: "素材信息已改变，请刷新后重试。");
            if (!row.Member.Removed)
            {
                db.LibraryMembers.Attach(row.Member);
                row.Member.Removed = true;
                row.Member.Revision++;
                await db.SaveChangesAsync(ct);
            }
        }
        finally { gate.Semaphore.Release(); }
        await worker.Notify(id, libraryId: scope.LibraryId);
        return Results.Ok(new { });
    }

    private static async Task<IResult> ListAssets(HttpContext context, CanvasDatabase db, CancellationToken ct)
    {
        var request = context.Request;
        var q = request.Query["q"].ToString(); if (q.Length > 200) return Results.BadRequest();
        var kind = request.Query["kind"].ToString(); var modified = request.Query["sort"] == "modified"; var ascending = request.Query["direction"] == "asc";
        var limit = int.TryParse(request.Query["limit"], out var size) ? Math.Clamp(size, 1, 200) : 50;
        var library = WorkspaceScope.Get(context).LibraryId;
        var members = db.LibraryMembers.AsNoTracking().Where(row => row.LibraryId == library && !row.Removed &&
            (row.RootId == null || !db.LibraryRoots.Any(root => root.Id == row.RootId && root.Removed)));
        var rootId = request.Query["rootId"].ToString();
        if (rootId.Length > 0) { if (!Guid.TryParse(rootId, out _)) return Results.BadRequest(); members = members.Where(row => row.RootId == rootId); }
        // Select a page using the asset time indexes before loading scoped source metadata.
        var assets = db.LibraryAssets.AsNoTracking();
        var query = rootId.Length == 0
            ? assets.Where(asset => members.Any(row => row.AssetId == asset.Id))
            : from member in members join asset in assets on member.AssetId equals asset.Id select asset;
        if (kind is "image" or "video" or "audio") query = query.Where(asset => asset.Kind == kind);
        if (q.Length > 0)
        {
            var pattern = "%" + q.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_") + "%";
            query = query.Where(asset => EF.Functions.Like(asset.Name, pattern, "\\"));
        }
        if (request.Query["cursor"].ToString() is { Length: > 0 } cursor)
        {
            var split = cursor.Split(':', 2); if (split.Length != 2 || !long.TryParse(split[0], out var time) || !Guid.TryParse(split[1], out _)) return Results.BadRequest();
            var key = split[1];
            if (modified) query = ascending ? query.Where(a => a.ModifiedAt > time || (a.ModifiedAt == time && a.Id.CompareTo(key) > 0)) :
                query.Where(a => a.ModifiedAt < time || (a.ModifiedAt == time && a.Id.CompareTo(key) < 0));
            else query = ascending ? query.Where(a => a.AddedAt > time || (a.AddedAt == time && a.Id.CompareTo(key) > 0)) :
                query.Where(a => a.AddedAt < time || (a.AddedAt == time && a.Id.CompareTo(key) < 0));
        }
        var sorted = modified
            ? ascending ? query.OrderBy(a => a.ModifiedAt).ThenBy(a => a.Id) : query.OrderByDescending(a => a.ModifiedAt).ThenByDescending(a => a.Id)
            : ascending ? query.OrderBy(a => a.AddedAt).ThenBy(a => a.Id) : query.OrderByDescending(a => a.AddedAt).ThenByDescending(a => a.Id);
        var page = sorted.Select(a => a.Id).Take(limit + 1);
        var details = ScopedAsset.Query(db, library).Where(row => page.Contains(row.Asset.Id));
        var selected = await details.ToListAsync(ct);
        var byTime = selected.OrderBy(row => modified ? row.Asset.ModifiedAt : row.Asset.AddedAt)
            .ThenBy(row => row.Asset.Id, StringComparer.Ordinal);
        var rows = (ascending ? byTime : byTime.Reverse()).ToList();
        var last = rows.Count > limit ? rows[limit - 1].Asset : null;
        return Results.Ok(new { items = rows.Take(limit).Select(row => row.Dto()),
            nextCursor = last == null ? null : $"{(modified ? last.ModifiedAt : last.AddedAt)}:{last.Id}" });
    }

    private static async Task<IResult> ServeMedia(string id, string variant, HttpContext context, CanvasDatabase db,
        LibraryPaths paths, LibraryWorker worker, DatabaseWriteGate gate, CancellationToken ct)
    {
        if (variant is not ("source" or "thumb" or "preview")) return Results.NotFound();
        var scope = WorkspaceScope.Get(context);
        var row = await ScopedAsset.Query(db, scope.LibraryId).SingleOrDefaultAsync(row => row.Asset.Id == id, ct);
        if (row == null) return Results.NotFound();
        if (row.Status is "removed" or "sourceRemoved") return Results.StatusCode(410);
        if (row.Status is "offline" or "missing") return Results.NotFound();
        if (row.Status != "ready") return Results.Problem(statusCode: 409, title: "文件尚未写入完成。");
        var asset = row.Asset;
        var root = row.PhysicalRoot;
        FileStream? opened = null;
        try
        {
            if (variant != "source")
            {
                var path = LibraryTypes.CachePath(paths, asset, variant);
                opened = SafeMediaFiles.Open(paths.Cache, Path.GetFileName(path));
                if (File.Exists(path) && File.GetLastAccessTimeUtc(path) < DateTime.UtcNow.AddMinutes(-1)) File.SetLastAccessTimeUtc(path, DateTime.UtcNow);
                return Results.Stream(opened, "image/webp", enableRangeProcessing: true, entityTag: new($"\"{asset.Id}-{asset.Version}-{variant}\""));
            }
            opened = SafeMediaFiles.Open(root.Path, asset.RelativePath);
            var modifiedAt = new DateTimeOffset(File.GetLastWriteTimeUtc(opened.SafeFileHandle)).ToUnixTimeMilliseconds();
            if (opened.Length != asset.Size || modifiedAt != asset.ModifiedAt)
            { opened.Dispose(); worker.RequestScan(row.Source?.Id ?? root.Id); return Results.StatusCode(409); }
            return Results.Stream(opened, LibraryTypes.Mime(asset.Extension), fileDownloadName: context.Request.Query["download"] == "1" ? asset.Name : null,
                enableRangeProcessing: true, entityTag: new($"\"{asset.Id}-{asset.Version}\""));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            opened?.Dispose();
            worker.RequestScan(row.Source?.Id ?? root.Id);
            if (variant != "source")
            {
                await gate.Semaphore.WaitAsync(ct);
                try
                {
                    var saved = await db.LibraryAssets.FindAsync([id], ct);
                    if (saved?.Status == "ready" && saved.Version == asset.Version && await scope.IsCurrent(db, ct))
                    {
                        saved.Status = "pending"; saved.Revision++; saved.RetryAt = 0; saved.LeaseUntil = 0;
                        saved.HasThumbnail = false; saved.HasPreview = false;
                        await db.SaveChangesAsync(ct);
                    }
                }
                finally { gate.Semaphore.Release(); }
                await worker.Notify(id);
            }
            return Results.NotFound();
        }
    }

    internal static string Prefix(string path) => Path.EndsInDirectorySeparator(path) ? path : path + Path.DirectorySeparatorChar;
    private static IResult RootConflict() => Results.Problem(statusCode: 409, title: "文件夹配置已改变，请刷新后重试。");
    private static IResult ManagedRoot() => Results.Problem(statusCode: 400, title: "拖入导入是应用保存的素材，请从素材列表管理。");
}
