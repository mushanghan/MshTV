using System.Diagnostics;
using System.Globalization;
using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using MshTV.Core;
using MshTV.Infrastructure;

namespace MshTV.Server.Library;

public sealed class MediaProcessor(LibraryPaths paths)
{
    internal const string Formats = "mov,matroska,webm,avi,mpeg,mpegts,png_pipe,jpeg_pipe,webp_pipe,gif,bmp_pipe,tiff_pipe,avif,mp3,wav,flac,aac,ogg,asf";
    private const long MaxImagePixels = 100_000_000;
    private static readonly ConcurrentDictionary<string, Lazy<string?>> Tools = new();
    public static string? Tool(string name) => Tools.GetOrAdd(name, key => new Lazy<string?>(() => FindTool(key))).Value;
    private static string? FindTool(string name)
    {
        if (!OperatingSystem.IsWindows()) return null; // Other platforms need their own reviewed binary hashes.
        using var manifest = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "media-tools.lock.json")));
        if (!manifest.RootElement.GetProperty("sha256").TryGetProperty(name, out var expected)) return null;
        var executable = name + (OperatingSystem.IsWindows() ? ".exe" : "");
        var directories = new[] { Environment.GetEnvironmentVariable("MSHTV_FFMPEG_DIR"), Path.Combine(AppContext.BaseDirectory, "media-tools") }
            .Concat((Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator));
        foreach (var directory in directories.Where(d => !string.IsNullOrWhiteSpace(d)))
        {
            try
            {
                var candidate = Path.Combine(directory!, executable);
                if (!File.Exists(candidate)) continue;
                using var file = File.OpenRead(candidate);
                if (Convert.ToHexString(SHA256.HashData(file)) == expected.GetString()) return candidate;
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException) { }
        }
        return null;
    }
    private static async Task<string> ReadBounded(StreamReader reader, int limit, CancellationToken ct)
    {
        var text = new StringBuilder(); var buffer = new char[4096]; int length;
        while ((length = await reader.ReadAsync(buffer.AsMemory(), ct)) > 0) if (text.Length < limit) text.Append(buffer, 0, Math.Min(length, limit - text.Length));
        return text.ToString();
    }
    private static Task<string> Run(string executable, IEnumerable<string> args, CancellationToken cancellation) =>
        Run(executable, args, (process, ct) => ReadBounded(process.StandardOutput, 262144, ct), cancellation);

    internal static async Task<T> Run<T>(string executable, IEnumerable<string> args, Func<Process, CancellationToken, Task<T>> read, CancellationToken cancellation)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation); timeout.CancelAfter(TimeSpan.FromSeconds(25));
        using var process = new Process { StartInfo = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true } };
        foreach (var arg in args) process.StartInfo.ArgumentList.Add(arg);
        process.Start();
        try
        {
            var error = ReadBounded(process.StandardError, 8192, timeout.Token);
            var output = await read(process, timeout.Token);
            await process.WaitForExitAsync(timeout.Token); await error;
            if (process.ExitCode != 0) throw new FormatException("媒体工具无法解码此文件。");
            return output;
        }
        finally { if (!process.HasExited) { process.Kill(true); await process.WaitForExitAsync(CancellationToken.None); } }
    }
    public async Task Process(LibraryAsset asset, LibraryRoot root, CancellationToken ct)
    {
        // Keep a validated read handle open throughout analysis. On Windows this excludes active writers and replacement.
        await using var held = SafeMediaFiles.Open(root.Path, asset.RelativePath);
        var path = SafeMediaFiles.Resolve(root.Path, asset.RelativePath);
        var info = new FileInfo(path);
        if (info.Length != asset.Size || new DateTimeOffset(info.LastWriteTimeUtc).ToUnixTimeMilliseconds() != asset.ModifiedAt) throw new IOException("文件仍在变化。");
        var probe = Tool("ffprobe"); var ffmpeg = Tool("ffmpeg");
        if (probe == null) { asset.Error = "未找到 ffprobe；可尝试浏览器原生预览。"; return; }
        var isImage = asset.Kind == "image";
        var jpeg = false;
        if (isImage)
        {
            // JPEG auto-detection can fall back to image2, whose filename patterns are intentionally disallowed.
            var header = new byte[3];
            jpeg = await held.ReadAtLeastAsync(header, header.Length, false, ct) == header.Length
                && header is [0xff, 0xd8, 0xff];
        }
        var probeArgs = new List<string> { "-v", "error", "-max_alloc", "134217728", "-protocol_whitelist", "file", "-format_whitelist", Formats };
        if (isImage) probeArgs.AddRange(["-threads", "1", "-max_pixels", MaxImagePixels.ToString(CultureInfo.InvariantCulture)]);
        if (jpeg) probeArgs.AddRange(["-f", "jpeg_pipe"]);
        probeArgs.AddRange(["-show_entries", "format=duration:stream=codec_type,width,height,duration", "-of", "json", "-i", path]);
        using var data = JsonDocument.Parse(await Run(probe, probeArgs, ct));
        if (data.RootElement.TryGetProperty("streams", out var streams)) foreach (var stream in streams.EnumerateArray())
        {
            if (stream.TryGetProperty("width", out var width)) asset.Width = width.GetInt32();
            if (stream.TryGetProperty("height", out var height)) asset.Height = height.GetInt32();
            if (asset.Duration == null && stream.TryGetProperty("duration", out var d) && double.TryParse(d.GetString(), CultureInfo.InvariantCulture, out var duration) && double.IsFinite(duration)) asset.Duration = duration;
        }
        if (data.RootElement.TryGetProperty("format", out var format) && format.TryGetProperty("duration", out var value) && double.TryParse(value.GetString(), CultureInfo.InvariantCulture, out var total) && double.IsFinite(total)) asset.Duration = total;
        if (ffmpeg == null || asset.Kind == "audio") return;
        SafeMediaFiles.CheckComponents(paths.Cache);
        var pixels = (long)(asset.Width ?? 0) * (asset.Height ?? 0);
        if (pixels > MaxImagePixels) { asset.Error = "图片或画面超过 100MP，未自动解码。"; return; }
        var drive = new DriveInfo(Path.GetPathRoot(paths.Cache)!);
        if (drive.AvailableFreeSpace < 5L * 1024 * 1024 * 1024) { asset.Error = "空闲磁盘不足 5GiB，已暂停缓存生成。"; return; }
        foreach (var variant in new[] { "thumb", "preview" })
        {
            var destination = LibraryTypes.CachePath(paths, asset, variant); var temp = destination + ".tmp.webp";
            try
            {
                var edge = variant == "thumb" ? 256 : isImage ? 2048 : 1024;
                // A 100MP 8-bit RGBA frame needs about 382MiB before stride alignment.
                var allocation = isImage && pixels > 12_000_000 ? "536870912" : "134217728";
                var args = new List<string> { "-nostdin", "-v", "error", "-y", "-max_alloc", allocation, "-threads", "1", "-filter_threads", "1", "-protocol_whitelist", "file", "-format_whitelist", Formats };
                if (isImage) args.AddRange(["-max_pixels", MaxImagePixels.ToString(CultureInfo.InvariantCulture)]);
                if (jpeg) args.AddRange(["-f", "jpeg_pipe"]);
                if (asset.Kind == "video") args.AddRange(["-ss", Math.Min(1, (asset.Duration ?? 0) / 3).ToString(CultureInfo.InvariantCulture)]);
                var scale = isImage || variant == "preview"
                    ? $"scale=w='min(iw,{edge})':h='min(ih,{edge})':force_original_aspect_ratio=decrease:flags=lanczos"
                    : $"scale={edge}:{edge}:force_original_aspect_ratio=decrease";
                args.AddRange(["-i", path, "-frames:v", "1", "-an", "-vf", scale, "-c:v", "libwebp", "-quality", isImage ? "90" : variant == "preview" ? "86" : "78", "-threads", "1", "-f", "webp", temp]);
                await Run(ffmpeg, args, ct);
                if (new FileInfo(temp).Length == 0) throw new IOException("空缩略图。");
                File.Move(temp, destination, true);
                if (variant == "thumb") asset.HasThumbnail = true; else asset.HasPreview = true;
            }
            finally { if (File.Exists(temp)) File.Delete(temp); }
        }
        info.Refresh();
        if (info.Length != asset.Size || new DateTimeOffset(info.LastWriteTimeUtc).ToUnixTimeMilliseconds() != asset.ModifiedAt) throw new IOException("源文件在处理期间改变。");
    }
    public void TrimCache()
    {
        SafeMediaFiles.CheckComponents(paths.Cache);
        var candidates = new PriorityQueue<FileInfo, long>(); long total = 0;
        foreach (var file in new DirectoryInfo(paths.Cache).EnumerateFiles("*", new EnumerationOptions { AttributesToSkip = FileAttributes.ReparsePoint }))
        {
            if (!LibraryTypes.IsDerivedCacheFile(file.Name)) continue;
            total += file.Length;
            if (file.LastWriteTimeUtc > DateTime.UtcNow.AddMinutes(-2)) continue;
            candidates.Enqueue(file, -file.LastAccessTimeUtc.Ticks);
            if (candidates.Count > 1024) candidates.Dequeue();
        }
        if (total <= 20L * 1024 * 1024 * 1024) return;
        foreach (var file in candidates.UnorderedItems.Select(x => x.Element).OrderBy(x => x.LastAccessTimeUtc))
        {
            if (total <= 16L * 1024 * 1024 * 1024) break;
            try
            {
                var path = SafeMediaFiles.Resolve(paths.Cache, file.Name);
                var length = file.Length;
                File.Delete(path);
                total -= length;
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
        }
    }
}
