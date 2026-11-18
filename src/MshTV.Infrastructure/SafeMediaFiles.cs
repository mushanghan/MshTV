using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace MshTV.Infrastructure;

public static class SafeMediaFiles
{
    public static string NormalizeRoot(string path, string dataDirectory)
    {
        if (string.IsNullOrWhiteSpace(path) || !System.IO.Path.IsPathFullyQualified(path) || path.StartsWith("\\") || path.StartsWith("//"))
            throw new ArgumentException("请输入 Windows 后端上的本地绝对目录路径，不支持网络共享。");
        var full = System.IO.Path.TrimEndingDirectorySeparator(System.IO.Path.GetFullPath(path));
        CheckComponents(full);
        if (!Directory.Exists(full)) throw new ArgumentException("后端无法访问此目录。");
        if (Within(full, dataDirectory) || Within(dataDirectory, full)) throw new ArgumentException("素材目录不能与应用数据目录重叠。");
        return full;
    }
    public static bool Within(string root, string file) =>
        string.Equals(root, file, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal) ||
        file.StartsWith(System.IO.Path.EndsInDirectorySeparator(root) ? root : root + System.IO.Path.DirectorySeparatorChar, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);

    public static void CheckComponents(string path)
    {
        var full = System.IO.Path.GetFullPath(path);
        var root = System.IO.Path.GetPathRoot(full)!;
        if (full[root.Length..].Contains(':')) throw new IOException("不允许设备路径或 ADS。");
        var current = root;
        foreach (var part in full[root.Length..].Split(System.IO.Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
        {
            current = System.IO.Path.Combine(current, part);
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new IOException("不允许符号链接或 junction。");
        }
    }
    public static string Resolve(string root, string relative)
    {
        if (System.IO.Path.IsPathRooted(relative) || relative.Contains(':')) throw new IOException("非法媒体位置。");
        var full = System.IO.Path.GetFullPath(System.IO.Path.Combine(root, relative));
        if (!Within(root, full)) throw new IOException("媒体位置越界。");
        CheckComponents(full);
        return full;
    }
    public static FileStream Open(string root, string relative, bool forIdentity = false)
    {
        var path = Resolve(root, relative);
        var stream = new FileStream(path, FileMode.Open, FileAccess.Read,
            forIdentity ? FileShare.ReadWrite | FileShare.Delete : FileShare.Read, 65536, FileOptions.Asynchronous | FileOptions.SequentialScan);
        try { ValidateHandle(root, stream.SafeFileHandle); return stream; }
        catch { stream.Dispose(); throw; }
    }
    public static void ValidateHandle(string root, SafeFileHandle handle)
    {
        if (!OperatingSystem.IsWindows()) return;
        var final = FinalPath(handle);
        if (!Within(root, final)) throw new IOException("媒体句柄越界。");
        CheckComponents(final);
    }
    public static string FinalPath(SafeFileHandle handle)
    {
        var buffer = new StringBuilder(32768);
        var length = GetFinalPathNameByHandle(handle, buffer, buffer.Capacity, 0);
        if (length == 0 || length >= buffer.Capacity) throw new IOException("无法验证媒体句柄。");
        var final = buffer.ToString();
        if (final.StartsWith("\\\\?\\")) final = final[4..];
        return final;
    }
    public static string? Identity(FileStream stream)
    {
        if (!OperatingSystem.IsWindows() || !GetFileInformationByHandle(stream.SafeFileHandle, out var info)) return null;
        return $"{info.VolumeSerialNumber:x8}:{info.FileIndexHigh:x8}{info.FileIndexLow:x8}";
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct FileInformation
    {
        public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        public uint VolumeSerialNumber, SizeHigh, SizeLow, Links, FileIndexHigh, FileIndexLow;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, int size, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation information);
}
