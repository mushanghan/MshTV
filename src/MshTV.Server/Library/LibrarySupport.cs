using Microsoft.AspNetCore.SignalR;
using System.Text.RegularExpressions;
using MshTV.Core;
using MshTV.Server.Workspace;

namespace MshTV.Server.Library;

public sealed class DatabaseWriteGate { public SemaphoreSlim Semaphore { get; } = new(1, 1); }
public sealed record LibraryPaths(string Data, string Cache)
{
    public string Imports => Path.Combine(Data, "imports");
}
public sealed class LibraryHub : Hub
{
    public override Task OnConnectedAsync() =>
        Groups.AddToGroupAsync(Context.ConnectionId, WorkspaceScope.Get(Context.GetHttpContext()!).LibraryId);
}
public static partial class LibraryTypes
{
    public static string? Kind(string extension) => extension.ToLowerInvariant() switch
    {
        ".jpg" or ".jpeg" or ".png" or ".webp" or ".gif" or ".bmp" or ".avif" or ".tif" or ".tiff" or ".heic" => "image",
        ".mp4" or ".mov" or ".m4v" or ".mkv" or ".webm" or ".avi" or ".mpg" or ".mpeg" or ".ts" => "video",
        ".mp3" or ".wav" or ".flac" or ".aac" or ".m4a" or ".ogg" or ".opus" or ".wma" => "audio", _ => null
    };
    public static string Mime(string extension) => extension.ToLowerInvariant() switch
    {
        ".jpg" or ".jpeg" => "image/jpeg", ".png" => "image/png", ".webp" => "image/webp", ".gif" => "image/gif", ".bmp" => "image/bmp", ".avif" => "image/avif",
        ".mp4" or ".m4v" => "video/mp4", ".mov" => "video/quicktime", ".webm" => "video/webm", ".mkv" => "video/x-matroska", ".avi" => "video/x-msvideo",
        ".mp3" => "audio/mpeg", ".wav" => "audio/wav", ".m4a" => "audio/mp4", ".flac" => "audio/flac", ".ogg" or ".opus" => "audio/ogg", ".aac" => "audio/aac", _ => "application/octet-stream"
    };
    public static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    public static string CachePath(LibraryPaths paths, LibraryAsset asset, string variant) =>
        Path.Combine(paths.Cache, $"{asset.Id}-{asset.Version}-v1-{variant}.{(variant == "waveform" ? "json" : "webp")}");
    public static bool IsDerivedCacheFile(string name) =>
        DerivedName().IsMatch(name) && Guid.TryParseExact(name.AsSpan(0, 36), "D", out _);

    [GeneratedRegex(@"\A[0-9a-fA-F-]{36}-[0-9]+-v1-(?:(?:thumb|preview)\.webp|waveform\.json)\z", RegexOptions.CultureInvariant)]
    private static partial Regex DerivedName();
}
