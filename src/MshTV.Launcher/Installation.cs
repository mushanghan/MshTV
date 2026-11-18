using System.ComponentModel;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using MshTV.Infrastructure;

namespace MshTV.Launcher;

internal sealed record Preferences(bool CloseToTray = true, string? MediaDirectory = null, bool DarkTheme = false);

internal static class Installation
{
    public static string Root => Path.TrimEndingDirectorySeparator(AppContext.BaseDirectory);
    public static string Server => Path.Combine(Root, "server", "MshTV.Server.exe");
    public static string Version => typeof(Installation).Assembly.GetName().Version!.ToString(3);
    private static string Pointer => Path.Combine(Root, "install-data.txt");
    public static string Anchor => Path.Exists(Pointer) ? ReadText(Root, "install-data.txt").Trim() :
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MshTV", "data");
    private const string PreferencesName = "launcher-settings.json";

    public static void Configure(string path)
    {
        path = ValidateAnchor(path);
        if (File.Exists(Pointer))
        {
            if (!string.Equals(Anchor, path, StringComparison.OrdinalIgnoreCase)) throw new IOException("请从存储设置迁移已有项目。");
            return;
        }
        CreateLocalDirectory(path);
        if (Directory.EnumerateFileSystemEntries(path).Any() &&
            !File.Exists(Path.Combine(path, "canvas.db")) && !File.Exists(Path.Combine(path, "storage-location.json")))
            throw new IOException("请选择空文件夹或已有 MshTV 数据文件夹。");
        using var output = new StreamWriter(new FileStream(Pointer, FileMode.CreateNew, FileAccess.Write, FileShare.None));
        output.Write(path);
    }

    public static void VerifyPayload()
    {
        var manifest = ReadText(Root, "payload.sha256").Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        if (manifest.Length == 0 || !File.Exists(Server)) throw new IOException("安装文件不完整，请用安装包重新安装。");
        foreach (var line in manifest)
        {
            if (line.Length < 67 || line[64..66] != "  ") throw new IOException("安装校验清单异常，请重新安装。");
            using var input = SafeMediaFiles.Open(Root, line[66..]);
            if (!Convert.ToHexString(SHA256.HashData(input)).Equals(line[..64], StringComparison.OrdinalIgnoreCase))
                throw new IOException($"安装文件已损坏：{line[66..]}。请用同版或新版安装包修复。");
        }
    }

    public static string CheckStorage(bool checkDatabase = false)
    {
        var anchor = ValidateAnchor(Anchor);
        CreateLocalDirectory(anchor);
        var current = CurrentDirectory(anchor);
        var database = Path.Combine(current, "canvas.db");
        if (checkDatabase && File.Exists(database))
        {
            using var guard = SafeMediaFiles.Open(current, "canvas.db", forIdentity: true);
            using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
            {
                DataSource = database, Mode = SqliteOpenMode.ReadOnly, Pooling = false, DefaultTimeout = 3
            }.ToString());
            connection.Open();
            using var inspect = connection.CreateCommand();
            inspect.CommandText = "PRAGMA quick_check";
            if (!Equals(inspect.ExecuteScalar(), "ok")) throw new IOException("数据库完整性检查失败。请保留原目录，从已有备份恢复。");
            inspect.CommandText = "SELECT 1 FROM sqlite_master WHERE name='Boards' AND type='table'";
            if (inspect.ExecuteScalar() == null) throw new IOException("所选目录中的 canvas.db 不是 MshTV 项目数据库。");
        }
        var probe = Path.Combine(current, $".mshtv-check-{Guid.NewGuid():N}.tmp");
        using var output = new FileStream(probe, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1, FileOptions.DeleteOnClose);
        SafeMediaFiles.ValidateHandle(current, output.SafeFileHandle);
        var cache = Path.Combine(current, "media-cache");
        if (Path.Exists(cache))
        {
            SafeMediaFiles.CheckComponents(cache);
            if (!Directory.Exists(cache)) throw new IOException("缓存目录不可用。请检查 media-cache 的类型及权限。");
        }
        return current;
    }

    public static void RepairDirectories()
    {
        var current = CheckStorage();
        CreateLocalDirectory(Path.Combine(current, "media-cache"));
    }

    public static string CurrentDirectory(string anchor)
    {
        if (!Path.Exists(Path.Combine(anchor, "storage-location.json"))) return anchor;
        using var data = SafeMediaFiles.Open(anchor, "storage-location.json");
        using var config = JsonDocument.Parse(data);
        if (!config.RootElement.TryGetProperty("Directory", out var directory)) throw new IOException("存储配置无法读取。");
        var configured = directory.GetString();
        if (configured == null) return anchor;
        var path = ValidateAnchor(configured);
        SafeMediaFiles.CheckComponents(path);
        if (!File.Exists(Path.Combine(path, "canvas.db"))) throw new IOException("已配置的数据目录找不到 canvas.db，请连接原磁盘或核对备份。");
        return path;
    }

    public static Preferences LoadPreferences()
    {
        var anchor = ValidateAnchor(Anchor);
        if (!Path.Exists(Path.Combine(anchor, PreferencesName))) return new();
        return JsonSerializer.Deserialize<Preferences>(ReadText(anchor, PreferencesName)) ?? throw new IOException("启动器设置无法读取。");
    }

    public static void SavePreferences(Preferences preferences)
    {
        var anchor = ValidateAnchor(Anchor);
        CreateLocalDirectory(anchor);
        var file = Path.Combine(anchor, "launcher-" + Guid.NewGuid().ToString("N") + ".tmp");
        using (var output = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        {
            SafeMediaFiles.ValidateHandle(anchor, output.SafeFileHandle);
            JsonSerializer.Serialize(output, preferences);
            output.Flush(true);
        }
        File.Move(file, Path.Combine(anchor, PreferencesName), overwrite: true);
    }

    public static string? MediaDirectory(Preferences preferences)
    {
        if (preferences.MediaDirectory is { } selected && MatchesMedia(selected)) return selected;
        var packaged = Path.Combine(Root, "server", "media-tools");
        if (Directory.Exists(packaged) && MatchesMedia(packaged)) return packaged;
        foreach (var path in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
            if (Path.IsPathFullyQualified(path) && MatchesMedia(path)) return path;
        return null;
    }

    private static bool MatchesMedia(string directory)
    {
        try
        {
            using var data = SafeMediaFiles.Open(Root, Path.Combine("server", "media-tools.lock.json"));
            using var manifest = JsonDocument.Parse(data);
            foreach (var tool in manifest.RootElement.GetProperty("sha256").EnumerateObject())
            {
                using var input = SafeMediaFiles.Open(directory, tool.Name + ".exe");
                if (Convert.ToHexString(SHA256.HashData(input)) != tool.Value.GetString()) return false;
            }
            return true;
        }
        catch (Exception e) when (Expected(e)) { return false; }
    }

    private static string ValidateAnchor(string path)
    {
        if (!Path.IsPathFullyQualified(path) || path.StartsWith("\\") || path.StartsWith('/') ||
            path.AsSpan(Path.GetPathRoot(path)!.Length).Contains(':')) throw new IOException("请选择 Windows 主机上的本地数据文件夹。");
        path = Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
        if (SafeMediaFiles.Within(Root, path) || SafeMediaFiles.Within(path, Root) || path == Path.GetPathRoot(path))
            throw new IOException("程序和项目数据必须保存在两个独立的文件夹。");
        return path;
    }

    private static void CreateLocalDirectory(string path)
    {
        var ancestor = path;
        while (!Directory.Exists(ancestor))
            ancestor = Path.GetDirectoryName(ancestor) ?? throw new IOException("数据磁盘不可用。");
        SafeMediaFiles.CheckComponents(ancestor);
        Directory.CreateDirectory(path);
        SafeMediaFiles.CheckComponents(path);
    }

    private static string ReadText(string root, string name)
    {
        using var input = SafeMediaFiles.Open(root, name);
        using var reader = new StreamReader(input);
        return reader.ReadToEnd();
    }

    public static void Open(string target) => Process.Start(new ProcessStartInfo(target) { UseShellExecute = true })?.Dispose();
    public static bool Expected(Exception e) => e is IOException or Win32Exception or UnauthorizedAccessException or ArgumentException
        or SqliteException or JsonException or InvalidOperationException or NotSupportedException or System.Net.Http.HttpRequestException;
}
