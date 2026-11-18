using System.Buffers.Binary;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using MshTV.Core;
using MshTV.Infrastructure;
using MshTV.Server.Workspace;

namespace MshTV.Server.Library;

public sealed class AudioWaveforms(LibraryPaths paths, DatabaseWriteGate gate)
{
    private const int SampleRate = 8000;
    private const int MaxSeconds = 2 * 60 * 60;
    private readonly SemaphoreSlim slot = new(1, 1);

    public async Task<IResult> Get(string id, long? version, WorkspaceScope scope, CanvasDatabase db, CancellationToken stopping, CancellationToken request)
    {
        using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(stopping, request);
        var ct = cancellation.Token;
        var scoped = ScopedAsset.Query(db, scope.LibraryId);
        var entry = await scoped.SingleOrDefaultAsync(row => row.Asset.Id == id, ct);
        if (entry == null || entry.Asset.Kind != "audio") return Results.NotFound();
        if (entry.Status is "removed" or "sourceRemoved") return Results.StatusCode(410);
        if (entry.Status is "missing" or "offline") return Results.NotFound();
        var asset = entry.Asset;
        var root = entry.PhysicalRoot;
        if (version != null && asset.Version != version) return Results.Problem(statusCode: 409, title: "音频已更新。");
        if (entry.Status != "ready") return Results.Problem(statusCode: 409, title: "音频尚未就绪。");
        var cache = LibraryTypes.CachePath(paths, asset, "waveform");
        try
        {
            await using var source = SafeMediaFiles.Open(root.Path, asset.RelativePath);
            if (!Matches(source, asset)) return Results.Problem(statusCode: 409, title: "音频已更新。");
            var cached = ReadCache(cache);
            if (cached != null) return cached;

            if (asset.Duration > MaxSeconds) return Results.Problem(statusCode: 422, title: "音频超过两小时，无法生成波形。");
            var ffmpeg = MediaProcessor.Tool("ffmpeg");
            if (ffmpeg == null) return Results.Problem(statusCode: 503, title: "未找到媒体工具，无法生成波形。");
            if (new DriveInfo(Path.GetPathRoot(paths.Cache)!).AvailableFreeSpace < 5L * 1024 * 1024 * 1024)
                return Results.Problem(statusCode: 503, title: "空闲磁盘不足 5GiB，已暂停波形生成。");
            if (!await slot.WaitAsync(0, ct)) return Results.Problem(statusCode: 429, title: "正在生成另一段波形，请稍后重试。");
            try
            {
                cached = ReadCache(cache);
                if (cached != null) return cached;
                var path = SafeMediaFiles.Resolve(root.Path, asset.RelativePath);
                var waveform = await MediaProcessor.Run(ffmpeg,
                    ["-nostdin", "-v", "error", "-max_alloc", "134217728", "-threads", "1", "-filter_threads", "1",
                     "-protocol_whitelist", "file", "-format_whitelist", MediaProcessor.Formats, "-i", path,
                     "-map", "0:a:0", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"],
                    (process, token) => ReadPeaks(process.StandardOutput.BaseStream, token), ct);
                await gate.Semaphore.WaitAsync(ct);
                try
                {
                    var current = await scoped.SingleOrDefaultAsync(row => row.Asset.Id == id &&
                        row.Asset.Version == asset.Version && row.Asset.RelativePath == asset.RelativePath && row.Asset.RootId == asset.RootId, ct);
                    if (current?.Status != "ready" || !await scope.IsCurrent(db, ct) || !Matches(source, asset))
                        return Results.Problem(statusCode: 409, title: "音频已更新。");
                    SafeMediaFiles.CheckComponents(paths.Cache);
                    var temporary = cache + $".{Guid.NewGuid():N}.tmp";
                    try
                    {
                        await using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                            await JsonSerializer.SerializeAsync(output, waveform, cancellationToken: ct);
                        File.Move(temporary, cache, overwrite: true);
                    }
                    finally { File.Delete(temporary); }
                    return Results.Ok(waveform);
                }
                finally { gate.Semaphore.Release(); }
            }
            finally { slot.Release(); }
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        { return Results.Problem(statusCode: 422, title: "生成音频波形超时。"); }
        catch (FormatException)
        { return Results.Problem(statusCode: 422, title: "无法为此音频生成波形。"); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        { return Results.Problem(statusCode: 503, title: "暂时无法读取音频或保存波形。"); }
    }

    private IResult? ReadCache(string cache)
    {
        if (!File.Exists(cache)) return null;
        try
        {
            var stream = SafeMediaFiles.Open(paths.Cache, Path.GetFileName(cache));
            try
            {
                if (File.GetLastAccessTimeUtc(cache) < DateTime.UtcNow.AddMinutes(-1)) File.SetLastAccessTimeUtc(cache, DateTime.UtcNow);
                return Results.Stream(stream, "application/json");
            }
            catch { stream.Dispose(); throw; }
        }
        catch (FileNotFoundException) { return null; } // Cache eviction can race a request.
    }

    private static bool Matches(FileStream stream, LibraryAsset asset) =>
        stream.Length == asset.Size &&
        new DateTimeOffset(File.GetLastWriteTimeUtc(stream.SafeFileHandle)).ToUnixTimeMilliseconds() == asset.ModifiedAt &&
        (asset.FileKey == null || SafeMediaFiles.Identity(stream) == asset.FileKey);

    private static async Task<Waveform> ReadPeaks(Stream source, CancellationToken ct)
    {
        var buffer = new byte[8192];
        var peaks = new int[512];
        var count = 0;
        var samplesPerPeak = 64;
        int bytes;
        while ((bytes = await source.ReadAtLeastAsync(buffer, buffer.Length, false, ct)) > 0)
        {
            if ((bytes & 1) != 0 || count + bytes / 2 > MaxSeconds * SampleRate) throw new FormatException();
            for (var offset = 0; offset < bytes; offset += 2)
            {
                if (count / samplesPerPeak == peaks.Length)
                {
                    for (var i = 0; i < peaks.Length / 2; i++) peaks[i] = Math.Max(peaks[2 * i], peaks[2 * i + 1]);
                    Array.Clear(peaks, peaks.Length / 2, peaks.Length / 2);
                    samplesPerPeak *= 2;
                }
                var index = count++ / samplesPerPeak;
                var peak = Math.Abs((int)BinaryPrimitives.ReadInt16LittleEndian(buffer.AsSpan(offset, 2)));
                peaks[index] = Math.Max(peaks[index], peak);
            }
        }
        if (count == 0) throw new FormatException();
        var bins = (count + samplesPerPeak - 1) / samplesPerPeak;
        return new Waveform(peaks.Take(bins).Select(peak => peak * 255 / 32768).ToArray());
    }

    private sealed record Waveform([property: System.Text.Json.Serialization.JsonPropertyName("peaks")] int[] Peaks);
}
