using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using MshTV.Core;
using MshTV.Infrastructure;
using MshTV.Server.Export;

namespace MshTV.Server.Storage;

internal sealed record StorageJob(string Operation, string? Parent, string? Backup, string? TargetDirectory = null);
internal sealed record StorageResult(string Operation, string? Directory, string? Error);
internal sealed record StorageState(string? Directory = null, StorageJob? Pending = null, StorageResult? Last = null);

internal sealed class StorageLocation
{
    private const string Marker = "mshtv-backup-v1";
    private static readonly Regex ImportName = new(@"\A[0-9A-Fa-f]{64}\.[a-z0-9]+\z", RegexOptions.CultureInvariant);
    private readonly object sync = new();
    private readonly string anchor;
    private string Settings => Path.Combine(anchor, "storage-location.json");
    public string Current { get; private set; }
    public StorageState State { get; private set; } = new();

    public StorageLocation(string anchor)
    {
        this.anchor = anchor;
        Current = anchor;
    }

    public FileStream Lock()
    {
        Directory.CreateDirectory(anchor);
        SafeMediaFiles.CheckComponents(anchor);
        var path = Path.Combine(anchor, "storage.lock");
        if (File.Exists(path)) SafeMediaFiles.CheckComponents(path);
        return new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
    }

    public void Start()
    {
        if (File.Exists(Settings))
        {
            using var stream = SafeMediaFiles.Open(anchor, Path.GetFileName(Settings));
            State = JsonSerializer.Deserialize<StorageState>(stream) ?? throw new IOException("存储配置无法读取。");
        }
        Current = State.Directory ?? anchor;
        if (State.Directory != null)
        {
            SafeMediaFiles.CheckComponents(Current);
            if (!File.Exists(Path.Combine(Current, "canvas.db"))) throw new IOException("已配置的 MshTV 数据目录不可用。");
        }
        if (State.Pending is not { } job) return;
        Console.WriteLine("MshTV 正在处理存储任务。处理完成后会打开工作空间。");
        string completed;
        try { completed = Execute(job); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException or SqliteException or InvalidOperationException)
        {
            var error = e is IOException or ArgumentException ? e.Message : "存储任务失败。请检查数据完整性、目标权限和可用空间。";
            Update(State with { Pending = null, Last = new(job.Operation, null, error) });
            Console.WriteLine("MshTV 存储任务失败，继续使用原数据目录。");
            return;
        }
        var directory = job.Operation == "backup" ? State.Directory : completed;
        Update(new(directory, null, new(job.Operation, completed, null)));
        Current = directory ?? anchor;
    }

    public StorageState Schedule(StorageJob? job)
    {
        lock (sync)
        {
            if (job != null && State.Pending != null) throw new InvalidOperationException("已有待执行任务，请先取消或重启。");
            Update(State with { Pending = job });
            return State;
        }
    }

    public StorageJob Validate(StorageJob job, IEnumerable<string> sources)
    {
        if (!OperatingSystem.IsWindows() || job.Operation is not ("backup" or "migrate" or "restore"))
            throw new ArgumentException("无法执行该存储操作。");
        if (job.Operation == "migrate" && job.TargetDirectory != null)
        {
            var directory = ExportDirectory.ValidateParent(job.TargetDirectory, Current, sources.Append(anchor));
            RequireEmptyDirectory(directory);
            return new(job.Operation, Path.GetDirectoryName(directory)!, null, directory);
        }
        var parent = ExportDirectory.ValidateParent(job.Parent, Current, sources.Append(anchor));
        string? backup = null;
        if (job.Operation == "restore")
        {
            backup = ExportDirectory.ValidateParent(job.Backup, Current, sources.Append(anchor));
            using var marker = SafeMediaFiles.Open(backup, Marker);
            if (marker.Length != 0) throw new ArgumentException("请选择 MshTV 创建的备份文件夹。");
        }
        return new(job.Operation, parent, backup);
    }

    private static void RequireEmptyDirectory(string directory)
    {
        SafeMediaFiles.CheckComponents(directory);
        if (Directory.EnumerateFileSystemEntries(directory).Any())
            throw new ArgumentException("请为工作目录选择一个空文件夹。");
    }

    private string Execute(StorageJob job)
    {
        var source = job.Operation == "restore" ? job.Backup ?? throw new ArgumentException() : Current;
        using var sourceHandle = SafeMediaFiles.Open(source, "canvas.db", forIdentity: true);
        using var db = OpenDatabase(Path.Combine(source, "canvas.db"), SqliteOpenMode.ReadOnly);
        Verify(db);
        using var roots = db.CreateCommand();
        roots.CommandText = "SELECT Path FROM LibraryRoots WHERE Id <> $id";
        roots.Parameters.AddWithValue("$id", LibraryRoot.ImportedRootId);
        var watched = new List<string>();
        using (var reader = roots.ExecuteReader()) while (reader.Read()) watched.Add(reader.GetString(0));
        job = Validate(job, watched);

        var parent = job.Parent!;
        using var pins = new ExportDirectory();
        pins.PinParent(parent);
        var name = $"MshTV-{(job.Operation == "backup" ? "备份" : "数据")}-{DateTime.Now:yyyyMMdd-HHmmss}-{Guid.NewGuid():N}";
        var target = job.TargetDirectory ?? Path.Combine(parent, name);
        var staging = ExportDirectory.CreateUnique(parent, name + ".partial");
        CopyDatabaseAndImports(db, source, staging, target);
        if (job.Operation == "backup") using (new FileStream(Path.Combine(staging, Marker), FileMode.CreateNew)) { }
        SafeMediaFiles.CheckComponents(staging);
        if (job.TargetDirectory == null) Directory.Move(staging, target);
        else PublishToEmptyDirectory(staging, target);
        return target;
    }

    private static void PublishToEmptyDirectory(string staging, string target)
    {
        RequireEmptyDirectory(target);
        // A same-volume directory rename publishes the validated files together.
        // Non-recursive removal fails if another program has populated the selected directory.
        Directory.Delete(target, recursive: false);
        try { Directory.Move(staging, target); }
        catch
        {
            if (!Path.Exists(target)) Directory.CreateDirectory(target);
            throw;
        }
    }

    private static void CopyDatabaseAndImports(SqliteConnection db, string source, string staging, string target)
    {
        var imports = Path.Combine(staging, "imports");
        Directory.CreateDirectory(imports);
        SafeMediaFiles.CheckComponents(imports);
        using var snapshot = OpenDatabase(Path.Combine(staging, "canvas.db"), SqliteOpenMode.ReadWriteCreate);
        db.BackupDatabase(snapshot);
        using var journal = snapshot.CreateCommand();
        journal.CommandText = "PRAGMA journal_mode=DELETE";
        if (!Equals(journal.ExecuteScalar(), "delete")) throw new IOException("无法生成独立的数据库副本。");
        using var select = snapshot.CreateCommand();
        select.CommandText = "SELECT Id, RelativePath, Size FROM LibraryAssets WHERE RootId=$root";
        select.Parameters.AddWithValue("$root", LibraryRoot.ImportedRootId);
        var files = new List<(string Id, string Name, long Size)>();
        using (var reader = select.ExecuteReader())
            while (reader.Read()) files.Add((reader.GetString(0), reader.GetString(1), reader.GetInt64(2)));
        var total = files.Sum(file => file.Size);
        if (new DriveInfo(Path.GetPathRoot(staging)!).AvailableFreeSpace < total)
            throw new IOException("目标磁盘空间不足。");
        var finalImports = Path.Combine(target, "imports");
        using var tx = snapshot.BeginTransaction();
        using var update = snapshot.CreateCommand();
        update.Transaction = tx;
        update.CommandText = "UPDATE LibraryAssets SET PhysicalPath=$path, FileKey=$key, ModifiedAt=$time, LeaseUntil=0 WHERE Id=$id";
        foreach (var file in files)
        {
            if (!ImportName.IsMatch(file.Name)) throw new IOException("导入副本名称无效。");
            using var input = SafeMediaFiles.Open(Path.Combine(source, "imports"), file.Name);
            if (input.Length != file.Size) throw new IOException("有导入副本缺失或大小不符。");
            var path = Path.Combine(imports, file.Name);
            using (var output = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                SafeMediaFiles.ValidateHandle(imports, output.SafeFileHandle);
                input.CopyTo(output);
                output.Flush(flushToDisk: true);
            }
            using var copy = SafeMediaFiles.Open(imports, file.Name);
            input.Position = 0;
            if (!SHA256.HashData(input).AsSpan().SequenceEqual(SHA256.HashData(copy)))
                throw new IOException("导入副本校验失败。");
            update.Parameters.Clear();
            update.Parameters.AddWithValue("$id", file.Id);
            update.Parameters.AddWithValue("$path", Path.Combine(finalImports, file.Name));
            update.Parameters.AddWithValue("$key", (object?)SafeMediaFiles.Identity(copy) ?? DBNull.Value);
            update.Parameters.AddWithValue("$time", new DateTimeOffset(File.GetLastWriteTimeUtc(copy.SafeFileHandle)).ToUnixTimeMilliseconds());
            update.ExecuteNonQuery();
        }
        update.Parameters.Clear();
        update.CommandText = "UPDATE LibraryRoots SET Path=$path WHERE Id=$id";
        update.Parameters.AddWithValue("$path", finalImports);
        update.Parameters.AddWithValue("$id", LibraryRoot.ImportedRootId);
        update.ExecuteNonQuery();
        tx.Commit();
        Verify(snapshot);
    }

    internal static SqliteConnection OpenDatabase(string path, SqliteOpenMode mode)
    {
        var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path, Mode = mode, Pooling = false }.ToString());
        try { db.Open(); return db; }
        catch { db.Dispose(); throw; }
    }

    internal static void Verify(SqliteConnection db)
    {
        using var check = db.CreateCommand();
        check.CommandText = "PRAGMA quick_check";
        if (!Equals(check.ExecuteScalar(), "ok")) throw new IOException("SQLite 完整性检查失败。");
        check.CommandText = "PRAGMA foreign_key_check";
        if (check.ExecuteScalar() != null) throw new IOException("SQLite 引用完整性检查失败。");
    }

    private void Update(StorageState state)
    {
        var temp = Path.Combine(anchor, $"storage-{Guid.NewGuid():N}.tmp");
        using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        {
            SafeMediaFiles.ValidateHandle(anchor, stream.SafeFileHandle);
            JsonSerializer.Serialize(stream, state);
            stream.Flush(flushToDisk: true);
        }
        File.Move(temp, Settings, overwrite: true);
        State = state;
    }
}
