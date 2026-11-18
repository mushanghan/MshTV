using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.EntityFrameworkCore;
using MshTV.Core;
using MshTV.Infrastructure;
using MshTV.Server.Library;
using MshTV.Server.Workspace;

namespace MshTV.Server.Export;

internal sealed record ExportRequest(long Revision, string? Scope, string[]? ItemIds, string[]? GroupIds, string? Parent, string? Name);
internal sealed record ExportFile(string AssetId, string Title, string Folder);
internal sealed record ExportFailure(string Folder, string Name, string Reason);
internal sealed record ExportProgress(Guid Id, string Status, string? Path, int Total, int Succeeded, int Failed,
    string? Current, long FileBytes, long CopiedBytes, string? Error, ExportFailure[] Failures);

internal sealed class BoardExport(IServiceScopeFactory scopes, LibraryPaths paths, DatabaseWriteGate gate, ILogger<BoardExport> logger) : BackgroundService
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly object sync = new();
    private readonly Dictionary<Guid, Job> jobs = [];
    private readonly Channel<Job> queue = Channel.CreateBounded<Job>(1);

    public async Task<IResult> Start(ExportRequest request, string owner, WorkspaceScope scope, CanvasDatabase db, CancellationToken ct)
    {
        if (!OperatingSystem.IsWindows()) return Results.Problem(statusCode: 501, title: "导出需要 Windows 后端。");
        if (request.Scope is not ("selection" or "board") || request.Name is not { Length: <= 100 } ||
            !ExportDirectory.ValidName(request.Name) || request.ItemIds is { Length: > 10000 } || request.GroupIds is { Length: > 1000 })
            return Results.Problem(statusCode: 400, title: "导出范围或文件夹名称无效。");

        var board = await WorkspaceScope.LiveBoards(db).AsNoTracking().SingleOrDefaultAsync(row => row.Id == scope.BoardId && row.LibraryId == scope.LibraryId, ct);
        if (board == null) return WorkspaceScope.Changed();
        if (board.Revision != request.Revision)
            return Results.Problem(statusCode: 409, title: "画布已更新，请重新加载后导出。");
        var doc = JsonSerializer.Deserialize<BoardDocument>(board.DocumentJson, Json)!;
        var itemIds = (request.ItemIds ?? []).ToHashSet();
        var groupIds = (request.GroupIds ?? []).ToHashSet();
        if (request.Scope == "selection" &&
            (!itemIds.IsSubsetOf(doc.Items.Select(item => item.Id)) || !groupIds.IsSubsetOf(doc.Groups.Select(group => group.Id))))
            return Results.Problem(statusCode: 409, title: "所选内容已变化，请重新选择。");
        var folders = new Dictionary<string, string>();
        var used = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "未分组素材" };
        var planned = new HashSet<(string?, string)>();
        var files = new List<ExportFile>();
        foreach (var group in doc.Groups)
        {
            var name = ExportDirectory.CleanName(group.Name, "分组");
            var folder = name;
            for (var suffix = 2; !used.Add(folder); suffix++) folder = $"{name} ({suffix})";
            folders.Add(group.Id, folder);
        }
        foreach (var item in doc.Items)
        {
            if (item.Type == "note" || !Guid.TryParse(item.AssetId, out var assetId)) continue;
            if (request.Scope == "selection" && !itemIds.Contains(item.Id) && (item.GroupId == null || !groupIds.Contains(item.GroupId))) continue;
            if (!planned.Add((item.GroupId, assetId.ToString()))) continue;
            var folder = item.GroupId != null && folders.TryGetValue(item.GroupId, out var name) ? name : "未分组素材";
            files.Add(new ExportFile(item.AssetId!, item.Title, folder));
        }
        if (files.Count == 0) return Results.Problem(statusCode: 400, title: "所选范围内没有可导出的原始素材。");

        string parent;
        try { parent = ExportDirectory.ValidateParent(request.Parent, paths.Data, await SourceDirectories(db, ct)); }
        catch (Exception e) when (e is ArgumentException or IOException or UnauthorizedAccessException)
        { return Results.Problem(statusCode: 400, title: e is ArgumentException ? e.Message : "无法访问目标目录或目录包含链接。"); }

        lock (sync)
        {
            if (jobs.Values.Any(job => job.Active)) return Results.Problem(statusCode: 409, title: "已有导出在运行。");
            if (jobs.Count >= 8) jobs.Remove(jobs.Keys.First());
            var job = new Job(owner, scope, parent, request.Name, files);
            jobs.Add(job.Id, job);
            if (!queue.Writer.TryWrite(job))
            {
                jobs.Remove(job.Id);
                job.Cancel.Dispose();
                return Results.Problem(statusCode: 503, title: "导出服务暂不可用。");
            }
            return Results.Accepted($"/api/v1/exports/{job.Id}?boardId={Uri.EscapeDataString(scope.BoardId)}", job.Snapshot());
        }
    }

    public IResult Status(Guid id, string owner, string boardId)
    {
        lock (sync) return Find(id, owner, boardId) is { } job ? Results.Ok(job.Snapshot()) : Results.NotFound();
    }

    public IResult Active(string owner, string boardId)
    {
        lock (sync) return Results.Json(new { job = jobs.Values.FirstOrDefault(job => job.Active && job.Owner == owner && job.Scope.BoardId == boardId)?.Snapshot() });
    }

    public IResult Cancel(Guid id, string owner, string boardId)
    {
        lock (sync)
        {
            if (Find(id, owner, boardId) is not { } job) return Results.NotFound();
            if (job.Active) job.Cancel.Cancel();
            return Results.Ok(job.Snapshot());
        }
    }

    public IResult Open(Guid id, string owner, string boardId)
    {
        string? path;
        lock (sync) path = Find(id, owner, boardId) is { Active: false } job ? job.Path : null;
        if (path == null) return Results.NotFound();
        try
        {
            using var directories = new ExportDirectory();
            directories.PinParent(path);
            var explorer = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe");
            var launch = new ProcessStartInfo(explorer) { UseShellExecute = false };
            launch.ArgumentList.Add(path);
            using var process = Process.Start(launch);
            return Results.Ok(new { opened = true });
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or System.ComponentModel.Win32Exception)
        { return Results.Problem(statusCode: 400, title: "无法打开 Windows 导出文件夹。"); }
    }

    private Job? Find(Guid id, string owner, string boardId) =>
        jobs.TryGetValue(id, out var job) && job.Owner == owner && job.Scope.BoardId == boardId ? job : null;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var job in queue.Reader.ReadAllAsync(stoppingToken))
        {
            using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken, job.Cancel.Token);
            try { await Run(job, cancellation.Token); }
            finally { lock (sync) job.Cancel.Dispose(); }
        }
    }

    private static Task<List<string>> SourceDirectories(CanvasDatabase db, CancellationToken ct) =>
        db.LibraryRoots.AsNoTracking().Select(root => root.Path).ToListAsync(ct);

    private async Task Run(Job job, CancellationToken ct)
    {
        StreamWriter? report = null;
        var status = "completed";
        string? error = null;
        using var directories = new ExportDirectory();
        try
        {
            ct.ThrowIfCancellationRequested();
            await using var scope = scopes.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<CanvasDatabase>();
            string target;
            await gate.Semaphore.WaitAsync(ct);
            try
            {
                var parent = ExportDirectory.ValidateParent(job.Parent, paths.Data, await SourceDirectories(db, ct));
                directories.PinParent(parent);
                target = ExportDirectory.CreateUnique(parent, job.Name);
                directories.Pin(target);
            }
            finally { gate.Semaphore.Release(); }
            lock (sync) { job.Path = target; job.Status = "running"; }
            var reportPath = Path.Combine(target, "导出报告.txt");
            report = new StreamWriter(new FileStream(reportPath, FileMode.CreateNew, FileAccess.Write, FileShare.Read),
                new UTF8Encoding(encoderShouldEmitUTF8Identifier: true)) { AutoFlush = true };
            await report.WriteLineAsync($"MshTV 导出 · 计划 {job.Files.Count} 个文件");
            await report.WriteLineAsync("若无结束记录，则本次导出曾中断。已完成文件可使用，*.partial 是未完成文件。");
            var folders = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var nextSuffix = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            var buffer = new byte[256 * 1024];
            foreach (var file in job.Files)
            {
                ct.ThrowIfCancellationRequested();
                await ExportOne(job, file, db, target, directories, folders, nextSuffix, buffer, report, ct);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { status = "cancelled"; }
        catch (Exception e)
        {
            status = "failed";
            error = e is ArgumentException ? e.Message : "无法继续导出，请检查目标目录权限及可用空间。";
            logger.LogWarning("导出任务 {Id} 已中断：{Type}", job.Id, e.GetType().Name);
        }
        finally
        {
            if (report != null)
            {
                try
                {
                    var outcome = status == "cancelled" ? "已取消" : status == "failed" ? "已中断" : "已完成";
                    await using (report)
                        await report.WriteLineAsync($"{outcome} · 成功 {job.Succeeded} · 失败 {job.Failed} · 未处理 {job.Files.Count - job.Succeeded - job.Failed}");
                }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException)
                { error ??= "导出报告未完整写入。"; }
            }
            lock (sync) { job.Current = null; job.Status = status; job.Error = error; }
        }
    }

    private async Task ExportOne(Job job, ExportFile file, CanvasDatabase db, string target, ExportDirectory directories,
        Dictionary<string, string> folders, Dictionary<string, int> nextSuffix, byte[] buffer, StreamWriter report, CancellationToken ct)
    {
        var row = await job.Scope.IsCurrent(db, ct)
            ? await ScopedAsset.Query(db, job.Scope.LibraryId).SingleOrDefaultAsync(entry => entry.Asset.Id == file.AssetId, ct)
            : null;
        var name = row?.Asset.Name ?? file.Title;
        lock (sync) { job.Current = name; job.FileBytes = row?.Asset.Size ?? 0; job.CopiedBytes = 0; }
        string? reason;
        string? output = null;
        if (row == null) reason = "素材记录不存在。";
        else if (row.Status is "removed" or "sourceRemoved") reason = "素材或来源已从素材库移除。";
        else if (row.Status == "offline") reason = "素材来源离线。";
        else if (row.Status == "missing") reason = "原文件缺失。";
        else if (row.Status != "ready") reason = "原文件尚未就绪，请稍后重试。";
        else
        {
            try
            {
                await using var source = SafeMediaFiles.Open(row.PhysicalRoot.Path, row.Asset.RelativePath);
                var time = new DateTimeOffset(File.GetLastWriteTimeUtc(source.SafeFileHandle)).ToUnixTimeMilliseconds();
                if (source.Length != row.Asset.Size || time != row.Asset.ModifiedAt ||
                    (row.Asset.FileKey != null && SafeMediaFiles.Identity(source) != row.Asset.FileKey))
                {
                    reason = "原文件已变化，请等待素材库更新。";
                }
                else
                {
                    if (!folders.TryGetValue(file.Folder, out var folder))
                    {
                        folder = ExportDirectory.CreateUnique(target, file.Folder);
                        directories.Pin(folder);
                        folders.Add(file.Folder, folder);
                    }
                    output = await Copy(job, source, folder, row.Asset.Name, nextSuffix, buffer, ct);
                    reason = null;
                }
            }
            catch (FileNotFoundException) { reason = "原文件缺失。"; }
            catch (DirectoryNotFoundException) { reason = "原文件所在目录缺失。"; }
            catch (UnauthorizedAccessException) { reason = "Windows 拒绝读取原文件或写入目标。"; }
            catch (IOException) { reason = "无法读取原文件或写入目标，请检查文件占用、路径和磁盘空间。"; }
        }
        lock (sync)
        {
            if (reason == null) job.Succeeded++;
            else { job.Failed++; if (job.Failures.Count < 100) job.Failures.Add(new(file.Folder, name, reason)); }
        }
        var line = reason == null ? $"成功 · {Path.GetRelativePath(target, output!)}" : $"失败 · {file.Folder} / {name} · {reason}";
        await report.WriteLineAsync(line.Replace('\r', ' ').Replace('\n', ' '));
    }

    private async Task<string> Copy(Job job, FileStream source, string folder, string originalName,
        Dictionary<string, int> nextSuffix, byte[] buffer, CancellationToken ct)
    {
        var temporary = Path.Combine(folder, $".mshtv-{Guid.NewGuid():N}.partial");
        var extension = Path.GetExtension(originalName);
        if (!ExportDirectory.ValidName("file" + extension) || extension.Length > 32) extension = "";
        var stem = ExportDirectory.CleanName(Path.GetFileNameWithoutExtension(originalName), "素材");
        var key = Path.Combine(folder, stem + extension);
        var created = false;
        try
        {
            await using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1, FileOptions.Asynchronous))
            {
                created = true;
                SafeMediaFiles.ValidateHandle(folder, output.SafeFileHandle);
                int size;
                while ((size = await source.ReadAsync(buffer, ct)) != 0)
                {
                    await output.WriteAsync(buffer.AsMemory(0, size), ct);
                    lock (sync) job.CopiedBytes += size;
                }
                await output.FlushAsync(ct);
            }
            ct.ThrowIfCancellationRequested();
            for (var suffix = nextSuffix.GetValueOrDefault(key, 1); suffix <= 20000; suffix++)
            {
                var name = suffix == 1 ? stem : $"{stem} ({suffix})";
                var destination = Path.Combine(folder, name + extension);
                try
                {
                    File.Move(temporary, destination, overwrite: false);
                    created = false;
                    nextSuffix[key] = suffix + 1;
                    return destination;
                }
                catch (IOException) when (File.Exists(destination) || Directory.Exists(destination)) { }
            }
            throw new IOException("同名文件过多。");
        }
        finally
        {
            if (created)
            {
                try { File.Delete(SafeMediaFiles.Resolve(folder, Path.GetFileName(temporary))); }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
            }
        }
    }

    private sealed class Job(string owner, WorkspaceScope scope, string parent, string name, List<ExportFile> files)
    {
        public Guid Id { get; } = Guid.NewGuid();
        public string Owner { get; } = owner;
        public WorkspaceScope Scope { get; } = scope;
        public string Parent { get; } = parent;
        public string Name { get; } = name;
        public List<ExportFile> Files { get; } = files;
        public CancellationTokenSource Cancel { get; } = new();
        public string Status = "queued";
        public bool Active => Status is "queued" or "running";
        public string? Path, Current, Error;
        public int Succeeded, Failed;
        public long FileBytes, CopiedBytes;
        public List<ExportFailure> Failures { get; } = [];
        public ExportProgress Snapshot() => new(Id, Status, Path, Files.Count, Succeeded, Failed, Current, FileBytes, CopiedBytes, Error, [.. Failures]);
    }
}
