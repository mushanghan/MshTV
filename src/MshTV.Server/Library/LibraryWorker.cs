using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using MshTV.Core;
using MshTV.Infrastructure;

namespace MshTV.Server.Library;

public sealed class LibraryWorker(IServiceScopeFactory scopes, DatabaseWriteGate gate, IHubContext<LibraryHub> hub,
    MediaProcessor media, MediaProcessingMode mode, LibraryPaths paths, ILogger<LibraryWorker> logger) : BackgroundService
{
    private readonly ConcurrentDictionary<string, long> dirty = new();
    private readonly ConcurrentDictionary<string, bool> manual = new();
    private readonly Dictionary<string, FileSystemWatcher> watchers = new();
    private long lastTrim;
    public void RequestScan(string id, bool force = false) { if (force) manual[id] = true; dirty.TryAdd(id, LibraryTypes.Now); }
    public async Task Notify(string? assetId = null, bool allAssets = false, string? libraryId = null)
    {
        if (libraryId != null)
        {
            await hub.Clients.Group(libraryId).SendAsync("LibraryChanged", new { assetId, allAssets });
            return;
        }
        using var scope = scopes.CreateScope();
        var libraries = await Database(scope).LibraryMembers.Where(row => row.AssetId == assetId)
            .Select(row => row.LibraryId).Distinct().ToListAsync();
        await hub.Clients.Groups(libraries).SendAsync("LibraryChanged", new { assetId, allAssets });
    }
    private CanvasDatabase Database(IServiceScope scope) => scope.ServiceProvider.GetRequiredService<CanvasDatabase>();
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        Directory.CreateDirectory(paths.Cache);
        var mediaLoops = Enumerable.Range(0, MediaProcessingMode.MaximumAnalysisJobs).Select(_ => MediaLoop(stoppingToken));
        await Task.WhenAll(mediaLoops.Prepend(ScanLoop(stoppingToken)));
    }
    private async Task ScanLoop(CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    if (LibraryTypes.Now - lastTrim > 60000) { lastTrim = LibraryTypes.Now; media.TrimCache(); }
                    using var scope = scopes.CreateScope(); var db = Database(scope);
                    var roots = await db.LibraryRoots.AsNoTracking().Where(r => !r.Removed && r.Id != LibraryRoot.ImportedRootId &&
                        db.MaterialLibraries.Any(library => library.Id == r.LibraryId && !library.Archived)).ToListAsync(ct);
                    foreach (var id in watchers.Keys.ToArray()) if (!roots.Any(r => r.Id == id && r.Enabled && r.Online && r.IncludeSubdirectories == watchers[id].IncludeSubdirectories)) { watchers[id].Dispose(); watchers.Remove(id); }
                    foreach (var root in roots)
                    {
                        if (root.Enabled && !watchers.ContainsKey(root.Id) && (root.Online || LibraryTypes.Now - root.LastScanAt > 10000))
                        {
                            try
                            {
                                SafeMediaFiles.CheckComponents(root.Path);
                                var watcher = new FileSystemWatcher(root.Path) { IncludeSubdirectories = root.IncludeSubdirectories, NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.Size | NotifyFilters.LastWrite, InternalBufferSize = 32768 };
                                watcher.Created += (_, _) => RequestScan(root.Id); watcher.Changed += (_, _) => RequestScan(root.Id);
                                watcher.Deleted += (_, _) => RequestScan(root.Id); watcher.Renamed += (_, _) => RequestScan(root.Id);
                                watcher.Error += (_, _) => RequestScan(root.Id); watcher.EnableRaisingEvents = true;
                                watchers[root.Id] = watcher; RequestScan(root.Id);
                            }
                            catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException) { RequestScan(root.Id); }
                        }
                        if (root.Enabled && LibraryTypes.Now - root.LastScanAt > 300_000) RequestScan(root.Id);
                        if (dirty.TryGetValue(root.Id, out var since) && LibraryTypes.Now - since >= 700 && dirty.TryRemove(root.Id, out _))
                        { var forced = manual.TryRemove(root.Id, out _); if (root.Enabled || forced) await Scan(root, ct, forced); }
                    }
                    foreach (var key in dirty.Keys) if (!roots.Any(r => r.Id == key)) { dirty.TryRemove(key, out _); manual.TryRemove(key, out _); }
                }
                catch (Exception e) when (e is not OperationCanceledException) { logger.LogWarning("素材扫描暂时失败：{Type}", e.GetType().Name); }
                await Task.Delay(500, ct);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        finally { foreach (var watcher in watchers.Values) watcher.Dispose(); }
    }
    private IEnumerable<(string Path, FileInfo Info, string? Key)> Files(string root, bool recursive)
    {
        foreach (var file in Directory.EnumerateFiles(root, "*", new EnumerationOptions { RecurseSubdirectories = recursive, IgnoreInaccessible = false, AttributesToSkip = FileAttributes.ReparsePoint | FileAttributes.System }))
        {
            if (LibraryTypes.Kind(Path.GetExtension(file)) == null) continue;
            SafeMediaFiles.CheckComponents(file); var info = new FileInfo(file); string? key = null;
            try { using var stream = SafeMediaFiles.Open(root, Path.GetRelativePath(root, file), true); key = SafeMediaFiles.Identity(stream); } catch (IOException) { }
            yield return (file, info, key);
        }
    }
    private static string Key(string path) => OperatingSystem.IsWindows() ? path.ToUpperInvariant() : path;

    private async Task Scan(LibraryRoot root, CancellationToken ct, bool retryErrors)
    {
        // A configuration request may arrive after ScanLoop read its root list. Never consume it using stale options.
        using (var scope = scopes.CreateScope())
        {
            var db = Database(scope);
            var latest = await db.LibraryRoots.AsNoTracking().FirstOrDefaultAsync(r => r.Id == root.Id && !r.Removed &&
                db.MaterialLibraries.Any(library => library.Id == r.LibraryId && !library.Archived), ct);
            if (latest == null || (!latest.Enabled && !retryErrors)) return;
            root = latest;
        }
        var token = Guid.NewGuid().ToString(); bool success = false, assetsChanged = false; string? error = null;
        try
        {
            SafeMediaFiles.CheckComponents(root.Path);
            foreach (var batch in Files(root.Path, root.IncludeSubdirectories).Chunk(200))
            {
                var batchChanged = false;
                ct.ThrowIfCancellationRequested(); await gate.Semaphore.WaitAsync(ct);
                try
                {
                    using var scope = scopes.CreateScope(); var db = Database(scope);
                    if (!await db.LibraryRoots.AnyAsync(r => r.Id == root.Id && !r.Removed && r.Revision == root.Revision &&
                        db.MaterialLibraries.Any(library => library.Id == r.LibraryId && !library.Archived), ct))
                    { RequestScan(root.Id, retryErrors); return; }
                    var positions = batch.Select(f => f.Path).ToArray();
                    var keys = batch.Select(f => Key(Path.GetRelativePath(root.Path, f.Path))).ToArray();
                    var identities = batch.Where(f => f.Key != null).Select(f => f.Key!).ToArray();
                    var existing = await db.LibraryAssets.Where(a => positions.Contains(a.PhysicalPath) ||
                        (a.FileKey != null && identities.Contains(a.FileKey))).ToListAsync(ct);
                    var ids = existing.Select(a => a.Id).ToArray();
                    var memberships = await db.LibraryMembers.Where(row => row.LibraryId == root.LibraryId && ids.Contains(row.AssetId))
                        .ToDictionaryAsync(row => row.AssetId, ct);
                    var ignored = root.NewFilesOnly ? await db.LibraryIgnoredFiles.Where(f => f.RootId == root.Id &&
                        (keys.Contains(f.PathKey) || (f.FileKey != null && identities.Contains(f.FileKey)))).ToListAsync(ct) : [];
                    foreach (var file in batch)
                    {
                        var relative = Path.GetRelativePath(root.Path, file.Path); var pathKey = Key(relative);
                        var asset = existing.FirstOrDefault(a => string.Equals(a.PhysicalPath, file.Path, StringComparison.OrdinalIgnoreCase));
                        // Identity follows renames only after the old path disappears. Hard links have separate entries.
                        asset ??= existing.FirstOrDefault(a => file.Key != null && a.FileKey == file.Key && !File.Exists(a.PhysicalPath));
                        var member = asset == null ? null : memberships.GetValueOrDefault(asset.Id);
                        if (member == null && root.NewFilesOnly)
                        {
                            var atPath = ignored.FirstOrDefault(f => f.PathKey == pathKey);
                            var wasPresent = atPath != null && (atPath.FileKey == null || file.Key == null || atPath.FileKey == file.Key);
                            wasPresent |= ignored.Any(f => file.Key != null && f.FileKey == file.Key && !File.Exists(Path.Combine(root.Path, f.RelativePath)));
                            if (root.BaselinePending || wasPresent)
                            {
                                if (root.BaselinePending)
                                {
                                    if (atPath == null) { atPath = new LibraryIgnoredFile { RootId = root.Id, PathKey = pathKey }; db.LibraryIgnoredFiles.Add(atPath); ignored.Add(atPath); }
                                    atPath.RelativePath = relative; atPath.FileKey = file.Key;
                                }
                                continue;
                            }
                        }
                        if (asset == null)
                        {
                            asset = new LibraryAsset { RootId = root.Id, StableSince = LibraryTypes.Now };
                            db.LibraryAssets.Add(asset); existing.Add(asset);
                        }
                        var relocated = !string.Equals(asset.PhysicalPath, file.Path, StringComparison.OrdinalIgnoreCase);
                        if (member == null)
                        {
                            member = new LibraryMember { LibraryId = root.LibraryId, RootId = root.Id, AssetId = asset.Id };
                            db.LibraryMembers.Add(member); memberships.Add(asset.Id, member); batchChanged = true;
                        }
                        // The first monitor to register an overlapping path owns the visible source.
                        // A relocated or previously missing file can be reassigned to the source that sees it now.
                        if (member.RootId == null || relocated || member.Missing)
                        {
                            if (member.RootId != root.Id || member.Missing) { member.RootId = root.Id; member.Missing = false; member.Revision++; batchChanged = true; }
                        }
                        if (member.RootId == root.Id) member.SeenScan = token;
                        if (relocated)
                        {
                            asset.RootId = root.Id; asset.RelativePath = relative; asset.PathKey = pathKey;
                            asset.PhysicalPath = file.Path; asset.Name = file.Info.Name;
                            if (asset.Status == "pending" && asset.LeaseUntil != 0)
                            {
                                asset.Version++; asset.LeaseUntil = 0; asset.RetryAt = 0;
                            }
                            asset.Revision++; batchChanged = true;
                        }
                        else if (asset.Name != file.Info.Name)
                        {
                            asset.Name = file.Info.Name; asset.Revision++; batchChanged = true;
                        }
                        asset.SeenScan = token;
                        if (member.Removed) continue;
                        var modified = new DateTimeOffset(file.Info.LastWriteTimeUtc).ToUnixTimeMilliseconds();
                        if (asset.Size != file.Info.Length || asset.ModifiedAt != modified || asset.Status == "missing" ||
                            (retryErrors && asset.Status == "ready" && asset.Error != null) || (file.Key != null && asset.FileKey != null && asset.FileKey != file.Key))
                        {
                            asset.Revision++; asset.Version++; asset.Status = "pending"; asset.StableSince = LibraryTypes.Now;
                            asset.RetryAt = 0; asset.LeaseUntil = 0;
                            asset.HasThumbnail = false; asset.HasPreview = false; asset.Width = null; asset.Height = null; asset.Duration = null; asset.Error = null;
                            batchChanged = true;
                        }
                        asset.FileKey = file.Key ?? asset.FileKey;
                        asset.Size = file.Info.Length; asset.ModifiedAt = modified; asset.Kind = LibraryTypes.Kind(file.Info.Extension)!;
                        asset.Extension = file.Info.Extension.ToLowerInvariant();
                    }
                    await db.SaveChangesAsync(ct);
                }
                finally { gate.Semaphore.Release(); }
                if (batchChanged)
                {
                    assetsChanged = true;
                    await Notify(libraryId: root.LibraryId);
                }
            }
            success = true;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { error = "目录离线、权限不足或存在不安全路径；未执行缺失对账。"; }
        await gate.Semaphore.WaitAsync(ct);
        try
        {
            using var scope = scopes.CreateScope(); var db = Database(scope); var saved = await db.LibraryRoots.FindAsync([root.Id], ct);
            if (saved == null || saved.Removed ||
                !await db.MaterialLibraries.AnyAsync(library => library.Id == root.LibraryId && !library.Archived, ct)) return;
            if (saved.Revision != root.Revision) { RequestScan(root.Id, retryErrors); return; }
            await using var transaction = await db.Database.BeginTransactionAsync(ct);
            assetsChanged |= saved.Online != success;
            saved.Online = success; saved.Error = error; saved.LastScanAt = LibraryTypes.Now;
            if (success)
            {
                var prefix = Path.TrimEndingDirectorySeparator(root.Path);
                if (!Path.EndsInDirectorySeparator(prefix)) prefix += Path.DirectorySeparatorChar;
                var unseen = db.LibraryMembers.Where(member => member.RootId == root.Id && !member.Removed && !member.Missing && member.SeenScan != token);
                var physical = db.LibraryAssets.Where(asset => asset.SeenScan != token && asset.Status != "missing" &&
                    (asset.RootId == root.Id || asset.PhysicalPath.StartsWith(prefix) && db.LibraryMembers.Any(member =>
                        member.AssetId == asset.Id && member.RootId == root.Id)));
                if (!root.IncludeSubdirectories)
                {
                    unseen = unseen.Where(member => db.LibraryAssets.Any(asset => asset.Id == member.AssetId &&
                        (!asset.PhysicalPath.StartsWith(prefix) || (!asset.PhysicalPath.Substring(prefix.Length).Contains("\\") &&
                        !asset.PhysicalPath.Substring(prefix.Length).Contains("/")))));
                    physical = physical.Where(asset => asset.PhysicalPath.StartsWith(prefix) &&
                        !asset.PhysicalPath.Substring(prefix.Length).Contains("\\") && !asset.PhysicalPath.Substring(prefix.Length).Contains("/"));
                }
                assetsChanged |= await unseen.ExecuteUpdateAsync(p => p.SetProperty(a => a.Missing, true).SetProperty(a => a.Revision, a => a.Revision + 1), ct) != 0;
                assetsChanged |= await physical.ExecuteUpdateAsync(p => p.SetProperty(a => a.Status, "missing").SetProperty(a => a.Revision, a => a.Revision + 1), ct) != 0;
                saved.BaselinePending = false;
            }
            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
        }
        finally { gate.Semaphore.Release(); }
        await Notify(allAssets: assetsChanged, libraryId: root.LibraryId);
    }
    private async Task MediaLoop(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                if (!mode.HasCapacity || !await ProcessNextMedia(ct)) await Task.Delay(500, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch (Exception e) { logger.LogWarning("媒体工作器将重试：{Type}", e.GetType().Name); try { await Task.Delay(1000, ct); } catch (OperationCanceledException) { break; } }
        }
    }

    private async Task<bool> ProcessNextMedia(CancellationToken ct)
    {
        var started = false;
        try
        {
            LibraryAsset? asset; LibraryRoot? root = null;
            await gate.Semaphore.WaitAsync(ct);
            try
            {
                // The setting and the job claim share the write gate, so a mode switch cannot admit an old-limit claim.
                if (!mode.TryStart()) return false;
                started = true;
                using var scope = scopes.CreateScope(); var db = Database(scope); var now = LibraryTypes.Now;
                asset = await db.LibraryAssets.Where(a => !a.Removed && a.Status == "pending" && a.StableSince < now - 2000 && a.RetryAt < now && a.LeaseUntil < now)
                    .Where(a => db.LibraryMembers.Any(member => member.AssetId == a.Id && !member.Removed && !member.Missing &&
                        db.MaterialLibraries.Any(library => library.Id == member.LibraryId && !library.Archived) &&
                        (member.RootId == null || db.LibraryRoots.Any(r => r.Id == member.RootId && !r.Removed && r.Online)))).OrderBy(a => a.RetryAt).FirstOrDefaultAsync(ct);
                // Probe + two sequential image variants can each use 25 seconds. Lease must outlive the whole job.
                if (asset != null) { root = await db.LibraryRoots.FindAsync([asset.RootId], ct); asset.LeaseUntil = now + 120_000; await db.SaveChangesAsync(ct); }
            }
            finally { gate.Semaphore.Release(); }
            if (asset == null || root == null) return false;

            var status = "ready"; string? error = null;
            try { await media.Process(asset, root, ct); }
            catch (IOException) { status = File.Exists(Path.Combine(root.Path, asset.RelativePath)) ? "pending" : "missing"; error = "等待文件写入完成，或媒体暂时无法读取。"; }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested) { error = "媒体分析超时，可尝试浏览器原生预览。"; }
            catch (Exception e) when (e is not OperationCanceledException) { error = "无法分析或生成封面，可尝试浏览器原生预览。"; }
            await gate.Semaphore.WaitAsync(ct);
            try
            {
                using var scope = scopes.CreateScope(); var db = Database(scope); var saved = await db.LibraryAssets.FindAsync([asset.Id], ct);
                if (saved != null && !saved.Removed && saved.Version == asset.Version && saved.RootId == asset.RootId &&
                    saved.RelativePath == asset.RelativePath && saved.LeaseUntil == asset.LeaseUntil && saved.Status == "pending")
                {
                    saved.Status = status; saved.RetryAt = LibraryTypes.Now + (status == "pending" ? 5000 : 0); saved.LeaseUntil = 0;
                    saved.Width = asset.Width; saved.Height = asset.Height; saved.Duration = asset.Duration; saved.Error = error ?? asset.Error;
                    saved.HasThumbnail = asset.HasThumbnail; saved.HasPreview = asset.HasPreview; saved.Revision++; await db.SaveChangesAsync(ct);
                }
            }
            finally { gate.Semaphore.Release(); }
            await Notify(asset.Id);
            return true;
        }
        finally { if (started) mode.Finish(); }
    }
}
