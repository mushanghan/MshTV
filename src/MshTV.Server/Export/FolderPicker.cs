using System.ComponentModel;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;
using Microsoft.EntityFrameworkCore;
using MshTV.Infrastructure;
using MshTV.Server.Library;

namespace MshTV.Server.Export;

internal sealed record PickFolderRequest(string? InitialDirectory);

internal static class FolderPicker
{
    internal const string Command = "--pick-export-folder";
    private static readonly SemaphoreSlim Slot = new(1);

    public static async Task<IResult> Pick(PickFolderRequest request, CanvasDatabase db, LibraryPaths paths,
        IHostApplicationLifetime host, CancellationToken aborted)
    {
        if (!OperatingSystem.IsWindows() || !Environment.UserInteractive)
            return Results.Problem(statusCode: 501, title: "请在运行 MshTV 的 Windows 桌面上选择文件夹。");
        if (!await Slot.WaitAsync(0, aborted))
            return Results.Problem(statusCode: 409, title: "文件夹选择窗口已打开，请先完成或取消选择。");

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(aborted, host.ApplicationStopping);
        timeout.CancelAfter(TimeSpan.FromMinutes(10));
        var ct = timeout.Token;
        try
        {
            var sources = await db.LibraryRoots.AsNoTracking().Select(root => root.Path).ToListAsync(ct);
            string? initial = null;
            if (!string.IsNullOrWhiteSpace(request.InitialDirectory))
            {
                try { initial = ExportDirectory.ValidateParent(request.InitialDirectory, paths.Data, sources); }
                catch (Exception e) when (e is ArgumentException or IOException or UnauthorizedAccessException) { }
            }
            var start = new ProcessStartInfo(Environment.ProcessPath!)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                StandardOutputEncoding = Encoding.UTF8,
            };
            if (string.Equals(Path.GetFileNameWithoutExtension(start.FileName), "dotnet", StringComparison.OrdinalIgnoreCase))
                start.ArgumentList.Add(Assembly.GetExecutingAssembly().Location);
            start.ArgumentList.Add(Command);
            if (initial != null) start.ArgumentList.Add(initial);
            using var picker = Process.Start(start) ?? throw new InvalidOperationException();
            string selected;
            try
            {
                selected = await picker.StandardOutput.ReadToEndAsync(ct);
                await picker.WaitForExitAsync(ct);
            }
            finally
            {
                if (!picker.HasExited) { picker.Kill(); await picker.WaitForExitAsync(); }
            }
            if (picker.ExitCode != 0)
                return Results.Problem(statusCode: 503, title: "无法打开 Windows 文件夹选择器，请在 Windows 桌面运行 MshTV 后重试。");
            if (selected.Length == 0) return Results.Json(new { path = (string?)null });
            sources = await db.LibraryRoots.AsNoTracking().Select(root => root.Path).ToListAsync(ct);
            return Results.Json(new { path = ExportDirectory.ValidateParent(selected, paths.Data, sources) });
        }
        catch (OperationCanceledException) when (!aborted.IsCancellationRequested && !host.ApplicationStopping.IsCancellationRequested)
        { return Results.Problem(statusCode: 408, title: "文件夹选择已超时，请重新选择。"); }
        catch (ArgumentException e) { return Results.Problem(statusCode: 400, title: e.Message); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or Win32Exception or InvalidOperationException)
        { return Results.Problem(statusCode: 400, title: "无法访问所选目录或打开 Windows 文件夹选择器。"); }
        finally { Slot.Release(); }
    }

    [SupportedOSPlatform("windows")]
    public static int RunDialog(string? initial)
    {
        var result = 1;
        var thread = new Thread(() =>
        {
            try
            {
                var path = Show(initial);
                if (path != null)
                {
                    Console.OutputEncoding = new UTF8Encoding(false);
                    Console.Write(path);
                }
                result = 0;
            }
            catch (COMException) { }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        return result;
    }

    [SupportedOSPlatform("windows")]
    private static string? Show(string? initial)
    {
        var dialogClass = Type.GetTypeFromCLSID(new("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7"), throwOnError: true)!;
        var dialog = (IFileDialog)Activator.CreateInstance(dialogClass)!;
        try
        {
            const uint noChangeDirectory = 0x8, pickFolders = 0x20, fileSystemOnly = 0x40, pathMustExist = 0x800;
            dialog.GetOptions(out var options);
            dialog.SetOptions(options | noChangeDirectory | pickFolders | fileSystemOnly | pathMustExist);
            dialog.SetTitle("MshTV · 选择导出目标文件夹");
            if (initial != null && SHCreateItemFromParsingName(initial, IntPtr.Zero, typeof(IShellItem).GUID, out var folder) == 0)
            {
                try { dialog.SetFolder(folder); }
                finally { Marshal.ReleaseComObject(folder); }
            }
            var code = dialog.Show(IntPtr.Zero);
            if (code == unchecked((int)0x800704C7)) return null;
            Marshal.ThrowExceptionForHR(code);
            dialog.GetResult(out var selected);
            try
            {
                const uint fileSystemPath = 0x80058000;
                selected.GetDisplayName(fileSystemPath, out var path);
                try { return Marshal.PtrToStringUni(path); }
                finally { Marshal.FreeCoTaskMem(path); }
            }
            finally { Marshal.ReleaseComObject(selected); }
        }
        finally { Marshal.ReleaseComObject(dialog); }
    }

    // COM interface members must remain in Windows SDK vtable order.
    [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileDialog
    {
        [PreserveSig] int Show(IntPtr owner);
        void SetFileTypes(uint count, IntPtr filters);
        void SetFileTypeIndex(uint index);
        void GetFileTypeIndex(out uint index);
        void Advise(IntPtr events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(uint options);
        void GetOptions(out uint options);
        void SetDefaultFolder(IShellItem folder);
        void SetFolder(IShellItem folder);
        void GetFolder(out IShellItem folder);
        void GetCurrentSelection(out IShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName(out IntPtr name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out IShellItem item);
    }

    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        void BindToHandler(IntPtr context, in Guid handler, in Guid iid, out IntPtr result);
        void GetParent(out IShellItem parent);
        void GetDisplayName(uint format, out IntPtr name);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int SHCreateItemFromParsingName(string path, IntPtr context, in Guid iid, out IShellItem item);
}
