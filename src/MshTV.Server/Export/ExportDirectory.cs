using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using MshTV.Infrastructure;

namespace MshTV.Server.Export;

internal sealed class ExportDirectory : IDisposable
{
    private readonly List<SafeFileHandle> handles = [];

    public static string ValidateParent(string? input, string data, IEnumerable<string> sources)
    {
        var path = input?.Trim().Replace('/', '\\');
        if (path == null || path.Length < 4 || path.Length > 1024 || !char.IsAsciiLetter(path[0]) ||
            path[1] != ':' || path[2] != '\\')
            throw new ArgumentException("请输入 Windows 后端上已存在的本地绝对目录。");
        path = path.TrimEnd('\\');
        if (path.Length < 4 || path[3..].Split('\\').Any(part => !ValidName(part)))
            throw new ArgumentException("导出路径包含不支持的目录名或路径段。");
        path = Path.GetFullPath(path);
        if (SafeMediaFiles.Within(data, path) || sources.Any(source => SafeMediaFiles.Within(source, path)))
            throw new ArgumentException("请将导出目录放在应用数据和素材来源文件夹之外。");
        if (!Directory.Exists(path)) throw new ArgumentException("导出目标目录不存在或无法访问。");
        SafeMediaFiles.CheckComponents(path);
        if (new DriveInfo(Path.GetPathRoot(path)!).DriveType is not (DriveType.Fixed or DriveType.Removable))
            throw new ArgumentException("请选择 Windows 后端的本地磁盘。");
        return path;
    }

    public static bool ValidName(string value) =>
        value.Length > 0 && value.Length <= 255 && !value.EndsWith(' ') && !value.EndsWith('.') &&
        !value.Any(character => character < 32 || "<>:\"/\\|?*".Contains(character)) && !Reserved(value);

    private static bool Reserved(string value)
    {
        var stem = value.Split('.', 2)[0].TrimEnd().ToUpperInvariant();
        return stem is "CON" or "PRN" or "AUX" or "NUL" or "CONIN$" or "CONOUT$" ||
            stem.Length == 4 && (stem.StartsWith("COM") || stem.StartsWith("LPT")) && "123456789¹²³".Contains(stem[3]);
    }

    public static string CleanName(string value, string fallback, int limit = 160)
    {
        var name = string.Concat(value.EnumerateRunes().Select(rune =>
            rune.Value < 32 || rune.IsAscii && "<>:\"/\\|?*".Contains((char)rune.Value) ? "_" : rune.ToString()));
        name = name.Trim().TrimEnd('.', ' ');
        if (name.Length > limit)
        {
            var length = char.IsHighSurrogate(name[limit - 1]) ? limit - 1 : limit;
            name = name[..length].TrimEnd('.', ' ');
        }
        if (name.Length == 0) return fallback;
        return Reserved(name) ? "_" + name : name;
    }

    public static string CreateUnique(string parent, string name)
    {
        for (var suffix = 1; suffix <= 10000; suffix++)
        {
            var candidate = Path.Combine(parent, suffix == 1 ? name : $"{name} ({suffix})");
            if (CreateDirectory(candidate, IntPtr.Zero)) return candidate;
            if (Marshal.GetLastWin32Error() is not (80 or 183))
                throw new IOException("无法创建导出目录，请检查 Windows 写入权限。");
        }
        throw new IOException("同名目录过多，请更换导出名称。");
    }

    public void PinParent(string path)
    {
        var drive = Path.GetPathRoot(path)!;
        var directory = drive;
        foreach (var segment in path[drive.Length..].Split('\\'))
        {
            directory = Path.Combine(directory, segment);
            Pin(directory);
        }
    }

    public void Pin(string path)
    {
        const uint readAttributes = 0x80, shareReadWrite = 3, openExisting = 3;
        const uint directoryNoFollow = 0x02200000;
        var handle = CreateFile(path, readAttributes, shareReadWrite, IntPtr.Zero, openExisting, directoryNoFollow, IntPtr.Zero);
        try
        {
            if (handle.IsInvalid || !Directory.Exists(path)) throw new IOException("导出目录无法访问。");
            var resolved = SafeMediaFiles.FinalPath(handle);
            if (!string.Equals(path, resolved, StringComparison.OrdinalIgnoreCase))
                throw new IOException("请选择导出目录的实际路径。");
            SafeMediaFiles.CheckComponents(resolved);
            handles.Add(handle);
        }
        catch { handle.Dispose(); throw; }
    }

    public void Dispose()
    {
        for (var i = handles.Count - 1; i >= 0; i--) handles[i].Dispose();
    }

    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);

    [DllImport("kernel32.dll", EntryPoint = "CreateDirectoryW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateDirectory(string path, IntPtr security);
}
