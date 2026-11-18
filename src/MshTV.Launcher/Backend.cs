using System.ComponentModel;
using System.Diagnostics;
using System.IO.Pipes;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace MshTV.Launcher;

internal sealed record NetworkStatus(bool Enabled, bool Accepting, string? ActiveUrl, string? Error);
internal sealed record CacheResult(int Removed, int Skipped);
internal sealed record StorageSpace(long Database, long Cache, long Imports, long Backups);
internal sealed record StorageCheck(bool Sqlite, int Boards, int Missing, int Offline, int Broken, StorageSpace Space);

internal sealed class Backend : IDisposable
{
    public const int Port = 5188;
    public const string Url = "http://127.0.0.1:5188";
    private readonly HttpClient http = new(new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(25) };
    private readonly ChildJob job = new();
    private Process? process;
    private volatile string? startupError;
    private string pipe = "";
    public bool Running => process is { HasExited: false };
    public bool Ready { get; private set; }

    public static void CheckPort()
    {
        using var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp) { ExclusiveAddressUse = true };
        try { socket.Bind(new IPEndPoint(IPAddress.Loopback, Port)); }
        catch (SocketException) { throw new IOException("本机端口 5188 已占用。请保存工作后关闭旧版 MshTV 或使用该端口的程序。"); }
    }

    public async Task Start(Func<string, Task> progress, string? mediaDirectory)
    {
        if (Running) throw new IOException("后端进程已在运行，请先停止。");
        process?.Dispose();
        Ready = false;
        startupError = null;
        CheckPort();
        pipe = "MshTV-" + Guid.NewGuid().ToString("N");
        var info = new ProcessStartInfo(Installation.Server)
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
            WorkingDirectory = Path.GetDirectoryName(Installation.Server)!
        };
        foreach (var key in info.Environment.Keys.Where(key => key.StartsWith("ASPNETCORE_", StringComparison.OrdinalIgnoreCase) ||
                     key.StartsWith("DOTNET_", StringComparison.OrdinalIgnoreCase) || key.StartsWith("MSHTV_", StringComparison.OrdinalIgnoreCase)).ToArray())
            info.Environment.Remove(key);
        info.Environment["MSHTV_PORT"] = Port.ToString();
        info.Environment["MSHTV_DATA_DIR"] = Installation.Anchor;
        info.Environment["MSHTV_LAUNCHER_PIPE"] = pipe;
        if (mediaDirectory != null) info.Environment["MSHTV_FFMPEG_DIR"] = mediaDirectory;
        info.ArgumentList.Add("--webroot");
        info.ArgumentList.Add(Path.Combine(info.WorkingDirectory, "wwwroot"));
        await progress("正在启动后端");
        var child = Process.Start(info) ?? throw new IOException("Windows 无法启动 MshTV 后端。");
        process = child;
        try
        {
            job.Attach(child);
            child.ErrorDataReceived += (_, e) => Capture(e.Data);
            child.OutputDataReceived += (_, e) => Capture(e.Data);
            child.BeginErrorReadLine();
            child.BeginOutputReadLine();
            await progress("正在等待后端就绪");
            var deadline = DateTime.UtcNow.AddMinutes(5);
            while (DateTime.UtcNow < deadline)
            {
                if (child.HasExited)
                    throw new IOException(startupError ?? $"后端启动失败（退出码 {child.ExitCode}）。请运行环境检查，核对安装文件和数据目录。");
                if (await Control('?') == "ready")
                {
                    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                    try
                    {
                        using var health = await http.GetAsync(Url + "/api/v1/health", timeout.Token);
                        if (health.IsSuccessStatusCode && Running) { Ready = true; return; }
                    }
                    catch (Exception e) when (e is HttpRequestException or OperationCanceledException) { }
                }
                await Task.Delay(250);
            }
            throw new IOException("等待后端就绪超时。若正在迁移大量数据，请等待其完成，再点击停止或重新检查。");
        }
        catch
        {
            // A failed job assignment must not leave an unmanaged process running.
            if (!job.Attached && !child.HasExited) child.Kill(entireProcessTree: true);
            throw;
        }
    }

    public async Task Stop()
    {
        if (!Running) { Ready = false; return; }
        if (await Control('!') != "stopping" && Running)
            throw new IOException("后端正在处理数据或未响应。请等待当前操作完成后重试。");
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        try { await process!.WaitForExitAsync(timeout.Token); }
        catch (OperationCanceledException) { throw new IOException("后端还在结束后台任务，请稍后重试。"); }
        Ready = false;
    }

    public void ObserveExit()
    {
        if (!Running) Ready = false;
    }

    public async Task<NetworkStatus> GetNetwork() => await Read<NetworkStatus>("/lan/status");
    public async Task<StorageCheck> CheckData() => await Read<StorageCheck>("/storage/check", true);
    public async Task<CacheResult> ClearCache() => await Read<CacheResult>("/storage/clear-cache", true);

    private async Task<T> Read<T>(string path, bool write = false)
    {
        if (!Ready || !Running) throw new IOException("请先启动 MshTV 后端。");
        using var bootstrap = new HttpRequestMessage(HttpMethod.Post, Url + "/api/v1/session");
        bootstrap.Headers.Add("Origin", Url);
        bootstrap.Headers.Add("X-MshTV-Bootstrap", "1");
        using var session = await http.SendAsync(bootstrap);
        session.EnsureSuccessStatusCode();
        using var body = JsonDocument.Parse(await session.Content.ReadAsStreamAsync());
        using var request = new HttpRequestMessage(write ? HttpMethod.Post : HttpMethod.Get, Url + "/api/v1" + path);
        if (write)
        {
            request.Headers.Add("Origin", Url);
            request.Headers.Add("X-CSRF-Token", body.RootElement.GetProperty("csrf").GetString());
        }
        using var response = await http.SendAsync(request);
        response.EnsureSuccessStatusCode();
        return JsonSerializer.Deserialize<T>(await response.Content.ReadAsStreamAsync(),
            new JsonSerializerOptions(JsonSerializerDefaults.Web)) ?? throw new IOException("后端返回了空响应。");
    }

    private async Task<string?> Control(char command)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(1));
        using var channel = new NamedPipeClientStream(".", pipe, PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        try
        {
            await channel.ConnectAsync(timeout.Token);
            await channel.WriteAsync(new byte[] { (byte)command }, timeout.Token);
            using var reader = new StreamReader(channel, Encoding.ASCII);
            return await reader.ReadToEndAsync(timeout.Token);
        }
        catch (Exception e) when (e is OperationCanceledException or IOException) { return null; }
    }

    private void Capture(string? line)
    {
        if (line == null) return;
        if (line.Contains("already in use", StringComparison.OrdinalIgnoreCase)) startupError = "端口已占用，请关闭占用端口的程序后重试。";
        if (line.Contains("storage.lock", StringComparison.OrdinalIgnoreCase)) startupError = "另一个 MshTV 后端正在使用此数据目录，请先关闭旧版。";
        if (line.Contains("SqliteException", StringComparison.OrdinalIgnoreCase)) startupError = "后端无法打开数据库。请检查数据目录权限和已有备份。";
    }

    public void Dispose() { job.Dispose(); process?.Dispose(); http.Dispose(); }

    private sealed class ChildJob : IDisposable
    {
        private readonly SafeFileHandle handle = CreateJobObject(0, null);
        public bool Attached { get; private set; }

        public void Attach(Process child)
        {
            Attached = false;
            if (handle.IsInvalid) throw new Win32Exception();
            var limits = new ExtendedLimit { Basic = new BasicLimit { Flags = 0x2000 } };
            if (!SetInformationJobObject(handle, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimit>()) ||
                !AssignProcessToJobObject(handle, child.SafeHandle)) throw new Win32Exception();
            Attached = true;
        }

        public void Dispose() => handle.Dispose();

        [StructLayout(LayoutKind.Sequential)]
        private struct BasicLimit
        {
            public long PerProcessTime, PerJobTime;
            public uint Flags;
            public nuint MinWorkingSet, MaxWorkingSet;
            public uint ActiveProcesses;
            public nuint Affinity;
            public uint Priority, Scheduling;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ExtendedLimit
        {
            public BasicLimit Basic;
            public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
            public nuint ProcessMemory, JobMemory, PeakProcess, PeakJob;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateJobObject(nint attributes, string? name);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetInformationJobObject(SafeFileHandle handle, int kind, ref ExtendedLimit info, uint length);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AssignProcessToJobObject(SafeFileHandle job, SafeProcessHandle process);
    }
}
