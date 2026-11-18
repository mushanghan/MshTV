using System.Buffers.Binary;
using System.Runtime.InteropServices;
using System.Text;

namespace MshTV.Server.Clipboard;

internal static class WindowsFileClipboard
{
    public const int MaxBytes = 8 * 1024 * 1024;
    private const uint FileDrop = 15;
    private const int DropFilesHeaderSize = 20;

    public static bool IsDesktopAvailable()
    {
        if (!OperatingSystem.IsWindows() || !Environment.UserInteractive) return false;
        if (!ProcessIdToSessionId((uint)Environment.ProcessId, out var session) || session == 0) return false;
        const int connectState = 8, active = 0;
        if (!WTSQuerySessionInformation(IntPtr.Zero, session, connectState, out var state, out var stateBytes)) return false;
        try { if (stateBytes < 4 || Marshal.ReadInt32(state) != active) return false; }
        finally { WTSFreeMemory(state); }

        const uint readObjects = 0x0001;
        var desktop = OpenInputDesktop(0, false, readObjects);
        if (desktop == IntPtr.Zero) return false;
        try
        {
            const int objectName = 2;
            var name = new StringBuilder(64);
            return GetUserObjectInformation(desktop, objectName, name, (uint)(name.Capacity * sizeof(char)), out _) &&
                name.ToString() == "Default";
        }
        finally { CloseDesktop(desktop); }
    }

    public static bool Write(IReadOnlyList<(string Path, string Name)> entries, CancellationToken ct)
    {
        var text = string.Join('\0', entries.Select(entry => entry.Path)) + "\0\0";
        var payload = new byte[DropFilesHeaderSize + Encoding.Unicode.GetByteCount(text)];
        BinaryPrimitives.WriteInt32LittleEndian(payload, DropFilesHeaderSize);
        BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(16), 1);
        Encoding.Unicode.GetBytes(text, payload.AsSpan(DropFilesHeaderSize));

        var effect = RegisterClipboardFormat("Preferred DropEffect");
        if (effect == 0) throw new IOException("无法注册剪贴板格式。");
        var needsNameMap = entries.Any(entry => entry.Name != Path.GetFileName(entry.Path));
        var filenameMap = needsNameMap ? RegisterClipboardFormat("FileNameMapW") : 0;
        if (needsNameMap && filenameMap == 0) throw new IOException("无法注册剪贴板文件名格式。");
        var files = IntPtr.Zero;
        var copy = IntPtr.Zero;
        var names = IntPtr.Zero;
        var owner = IntPtr.Zero;
        try
        {
            files = Allocate(payload);
            copy = Allocate([1, 0, 0, 0]); // DROPEFFECT_COPY
            if (needsNameMap)
                names = Allocate(Encoding.Unicode.GetBytes(string.Join('\0', entries.Select(entry => entry.Name)) + "\0\0"));
            var messageWindow = new IntPtr(-3); // HWND_MESSAGE
            owner = CreateWindowEx(0, "STATIC", null, 0, 0, 0, 0, 0, messageWindow, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
            if (owner == IntPtr.Zero) throw new IOException("无法创建剪贴板窗口。");

            for (var attempt = 0; attempt < 8; attempt++)
            {
                ct.ThrowIfCancellationRequested();
                if (!OpenClipboard(owner))
                {
                    if (attempt < 7) ct.WaitHandle.WaitOne(40);
                    continue;
                }
                try
                {
                    if (!EmptyClipboard() || SetClipboardData(effect, copy) == IntPtr.Zero)
                        throw new IOException("无法写入剪贴板。");
                    copy = IntPtr.Zero;
                    if (needsNameMap)
                    {
                        if (SetClipboardData(filenameMap, names) == IntPtr.Zero)
                        {
                            EmptyClipboard();
                            throw new IOException("无法写入剪贴板文件名。");
                        }
                        names = IntPtr.Zero;
                    }
                    if (SetClipboardData(FileDrop, files) == IntPtr.Zero)
                    {
                        EmptyClipboard();
                        throw new IOException("无法写入文件列表。");
                    }
                    files = IntPtr.Zero; // Windows owns published handles.
                    return true;
                }
                finally { CloseClipboard(); }
            }
            return false;
        }
        finally
        {
            if (owner != IntPtr.Zero) DestroyWindow(owner);
            if (files != IntPtr.Zero) GlobalFree(files);
            if (copy != IntPtr.Zero) GlobalFree(copy);
            if (names != IntPtr.Zero) GlobalFree(names);
        }
    }

    private static IntPtr Allocate(byte[] data)
    {
        const uint moveable = 2;
        var memory = GlobalAlloc(moveable, (nuint)data.Length);
        if (memory == IntPtr.Zero) throw new IOException("无法分配剪贴板缓冲区。");
        var target = GlobalLock(memory);
        if (target == IntPtr.Zero)
        {
            GlobalFree(memory);
            throw new IOException("无法打开剪贴板缓冲区。");
        }
        try { Marshal.Copy(data, 0, target, data.Length); }
        finally { GlobalUnlock(memory); }
        return memory;
    }

    [DllImport("kernel32.dll")]
    private static extern bool ProcessIdToSessionId(uint process, out uint session);
    [DllImport("wtsapi32.dll", EntryPoint = "WTSQuerySessionInformationW", ExactSpelling = true)]
    private static extern bool WTSQuerySessionInformation(IntPtr server, uint session, int info, out IntPtr buffer, out uint bytes);
    [DllImport("wtsapi32.dll")]
    private static extern void WTSFreeMemory(IntPtr buffer);
    [DllImport("user32.dll")]
    private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", EntryPoint = "GetUserObjectInformationW", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder name, uint length, out uint needed);
    [DllImport("user32.dll")]
    private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", EntryPoint = "CreateWindowExW", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern IntPtr CreateWindowEx(uint extendedStyle, string className, string? name, uint style, int x, int y,
        int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
    [DllImport("user32.dll")]
    private static extern bool DestroyWindow(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool OpenClipboard(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool CloseClipboard();
    [DllImport("user32.dll")]
    private static extern bool EmptyClipboard();
    [DllImport("user32.dll")]
    private static extern IntPtr SetClipboardData(uint format, IntPtr memory);
    [DllImport("user32.dll", EntryPoint = "RegisterClipboardFormatW", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern uint RegisterClipboardFormat(string format);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GlobalAlloc(uint flags, nuint bytes);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GlobalLock(IntPtr memory);
    [DllImport("kernel32.dll")]
    private static extern bool GlobalUnlock(IntPtr memory);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GlobalFree(IntPtr memory);
}
