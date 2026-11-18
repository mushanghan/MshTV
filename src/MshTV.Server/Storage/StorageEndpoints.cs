using System.Diagnostics;
using Microsoft.EntityFrameworkCore;
using MshTV.Core;
using MshTV.Infrastructure;
using MshTV.Server.Export;
using MshTV.Server.Library;

namespace MshTV.Server.Storage;

internal static class StorageEndpoints
{
    private static readonly EnumerationOptions FilesOnly = new() { AttributesToSkip = FileAttributes.ReparsePoint };
    private static readonly SemaphoreSlim Operation = new(1);

    public static void MapStorage(this WebApplication app)
    {
        var routes = app.MapGroup("/api/v1/storage");
        routes.MapGet("/status", (StorageLocation storage) => Results.Ok(new { directory = storage.Current, storage.State.Pending, storage.State.Last }));
        routes.MapPost("/pick-folder", FolderPicker.Pick);
        routes.MapPost("/open", OpenFolder);
        routes.MapPost("/check", Check);
        routes.MapPost("/clear-cache", ClearCache);
        routes.MapPost("/jobs", Schedule);
        routes.MapDelete("/jobs", (StorageLocation storage) => Results.Ok(storage.Schedule(null)));
    }

    private static async Task<IResult> Schedule(StorageJob job, StorageLocation storage, CanvasDatabase db, CancellationToken ct)
    {
        try
        {
            var roots = await db.LibraryRoots.AsNoTracking().Where(root => root.Id != LibraryRoot.ImportedRootId).Select(root => root.Path).ToListAsync(ct);
            return Results.Ok(storage.Schedule(storage.Validate(job, roots)));
        }
        catch (InvalidOperationException e) { return Results.Problem(statusCode: 409, title: e.Message); }
        catch (ArgumentException e) { return Results.Problem(statusCode: 400, title: e.Message); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        { return Results.Problem(statusCode: 400, title: "请检查目标位置。恢复需选择 MshTV 创建的备份，目标须在数据及素材目录之外。"); }
    }

    private static IResult OpenFolder(StorageLocation storage)
    {
        if (!OperatingSystem.IsWindows() || !Environment.UserInteractive) return Results.StatusCode(501);
        try
        {
            SafeMediaFiles.CheckComponents(storage.Current);
            var explorer = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe");
            var start = new ProcessStartInfo(explorer) { UseShellExecute = false };
            start.ArgumentList.Add(storage.Current);
            using var process = Process.Start(start);
            return Results.Ok(new { path = storage.Current });
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or System.ComponentModel.Win32Exception)
        { return Results.Problem(statusCode: 400, title: "无法打开数据目录。"); }
    }

    private static async Task<IResult> Check(LibraryPaths paths, CanvasDatabase db, CancellationToken ct)
    {
        if (!await Operation.WaitAsync(0, ct)) return Busy();
        try
        {
            await db.Database.OpenConnectionAsync(ct);
            var sqlite = true;
            try { StorageLocation.Verify((Microsoft.Data.Sqlite.SqliteConnection)db.Database.GetDbConnection()); }
            catch (IOException) { sqlite = false; }
            var boards = await db.Boards.CountAsync(x => x.DeletedAt == null, ct);
            var missing = await (from member in db.LibraryMembers
                                 join asset in db.LibraryAssets on member.AssetId equals asset.Id
                                 where !member.Removed && (member.Missing || asset.Status == "missing") &&
                                    db.MaterialLibraries.Any(library => library.Id == member.LibraryId && !library.Archived)
                                 select member.AssetId).Distinct().CountAsync(ct);
            var offline = await db.LibraryRoots.CountAsync(x => !x.Online && !x.Removed && x.Id != LibraryRoot.ImportedRootId, ct);
            var broken = await db.Database.SqlQueryRaw<long>("""
                SELECT count(*) AS Value FROM Boards b, json_each(b.DocumentJson,'$.items') i
                WHERE b.DeletedAt IS NULL AND length(json_extract(i.value,'$.assetId'))=36
                  AND NOT EXISTS (SELECT 1 FROM LibraryMembers m WHERE m.LibraryId=b.LibraryId AND m.AssetId=json_extract(i.value,'$.assetId'))
                """).SingleAsync(ct);
            var external = await db.Database.SqlQuery<long>($"""
                SELECT COALESCE(sum(Size), 0) AS Value FROM (
                  SELECT max(a.Size) AS Size FROM LibraryAssets a
                  WHERE a.RootId <> {LibraryRoot.ImportedRootId}
                    AND EXISTS (SELECT 1 FROM LibraryMembers m JOIN MaterialLibraries l ON l.Id=m.LibraryId
                        WHERE m.AssetId=a.Id AND NOT m.Removed AND NOT l.Archived)
                  GROUP BY a.PhysicalPath
                )
                """).SingleAsync(ct);
            return Results.Ok(new { sqlite, boards, missing, offline, broken, space = new
            {
                database = LocalFiles(paths.Data).Where(f => f.Name is "canvas.db" or "canvas.db-wal" or "canvas.db-shm").Sum(f => f.Length),
                cache = CacheFiles(paths.Cache).Sum(f => f.Length),
                imports = LocalFiles(paths.Imports).Sum(f => f.Length),
                external,
                backups = LocalFiles(paths.Data).Where(f => f.Name.StartsWith("before-", StringComparison.Ordinal) && f.Extension == ".db").Sum(f => f.Length),
                free = new DriveInfo(Path.GetPathRoot(paths.Data)!).AvailableFreeSpace
            } });
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or Microsoft.Data.Sqlite.SqliteException)
        { return Results.Problem(statusCode: 409, title: "无法完成存储检查，请核对数据库和本机磁盘权限。"); }
        finally { Operation.Release(); }
    }

    private static async Task<IResult> ClearCache(LibraryPaths paths, CancellationToken ct)
    {
        if (!await Operation.WaitAsync(0, ct)) return Busy();
        try
        {
            var removed = 0;
            var skipped = 0;
            long bytes = 0;
            foreach (var file in CacheFiles(paths.Cache))
            {
                ct.ThrowIfCancellationRequested();
                try
                {
                    var path = SafeMediaFiles.Resolve(paths.Cache, file.Name);
                    SafeMediaFiles.CheckComponents(path);
                    var size = file.Length;
                    File.Delete(path);
                    removed++;
                    bytes += size;
                }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException) { skipped++; }
            }
            return Results.Ok(new { removed, skipped, bytes });
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        { return Results.Problem(statusCode: 409, title: "无法访问预览缓存目录。"); }
        finally { Operation.Release(); }
    }

    private static IEnumerable<FileInfo> LocalFiles(string directory)
    {
        if (!Directory.Exists(directory)) return [];
        SafeMediaFiles.CheckComponents(directory);
        return new DirectoryInfo(directory).EnumerateFiles("*", FilesOnly);
    }

    private static IEnumerable<FileInfo> CacheFiles(string directory) => LocalFiles(directory).Where(f => LibraryTypes.IsDerivedCacheFile(f.Name));
    private static IResult Busy() => Results.Problem(statusCode: 409, title: "已有存储检查或清理任务正在执行。");
}
