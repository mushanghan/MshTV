using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using MshTV.Infrastructure;
using MshTV.Server.Workspace;

namespace MshTV.Server.Library;

internal static class DropCandidates
{
    private const int ChunkSize = 4 * 1024 * 1024;
    private const long MaxSize = 32L * 1024 * 1024 * 1024;
    private const int CandidateLimit = 4;
    private static readonly SemaphoreSlim ReadSlots = new(2, 2);

    public static async Task<IResult> Find(string name, long size, HttpContext context, CanvasDatabase db, CancellationToken aborted)
    {
        if (string.IsNullOrWhiteSpace(name) || name.Length > 255 || name.IndexOfAny(['/', '\\', ':', '\0']) >= 0)
            return Results.Problem(statusCode: 400, title: "拖入的文件名无效。");
        if (size <= 0 || size > MaxSize || LibraryTypes.Kind(Path.GetExtension(name)) == null)
            return Results.Problem(statusCode: 400, title: "请拖入支持的图片、视频或音频。单文件需大于 0 字节且不超过 32 GiB。");
        if (!ReadSlots.Wait(0))
            return Results.Problem(statusCode: 429, title: "正在核对其他拖入文件，请稍后再试。");

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(aborted);
        timeout.CancelAfter(TimeSpan.FromSeconds(75));
        var ct = timeout.Token;
        try
        {
            var scope = WorkspaceScope.Get(context);
            var available = ScopedAsset.Available(ScopedAsset.Query(db, scope.LibraryId));
            var candidates = await available.Where(row => row.Asset.Name == name && row.Asset.Size == size &&
                (row.Asset.Status == "ready" || row.Asset.Status == "pending")).Take(CandidateLimit + 1).ToListAsync(ct);
            candidates = candidates.Where(row => row.Status is "ready" or "pending").ToList();
            if (candidates.Count > CandidateLimit)
                return Results.Problem(statusCode: 409, title: "同名同大小的素材过多，请从素材库选择对应来源。");

            var matches = new List<object>(candidates.Count);
            if (candidates.Count == 0) return Results.Ok(matches);
            var buffer = new byte[ChunkSize];
            foreach (var candidate in candidates)
            {
                var asset = candidate.Asset;
                await using var source = SafeMediaFiles.Open(candidate.PhysicalRoot.Path, asset.RelativePath);
                var modifiedAt = new DateTimeOffset(File.GetLastWriteTimeUtc(source.SafeFileHandle)).ToUnixTimeMilliseconds();
                var fileKey = SafeMediaFiles.Identity(source);
                if (source.Length != asset.Size || modifiedAt != asset.ModifiedAt || (asset.FileKey != null && fileKey != asset.FileKey))
                    return Changed();

                // The browser hashes fixed-size chunks, then hashes their concatenated digests.
                using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                for (long remaining = size; remaining > 0;)
                {
                    var count = (int)Math.Min(remaining, buffer.Length);
                    await source.ReadExactlyAsync(buffer.AsMemory(0, count), ct);
                    digest.AppendData(SHA256.HashData(buffer.AsSpan(0, count)));
                    remaining -= count;
                }

                var current = await available.SingleOrDefaultAsync(row => row.Asset.Id == asset.Id &&
                    row.Asset.Version == asset.Version && row.Asset.RootId == asset.RootId &&
                    row.Asset.RelativePath == asset.RelativePath, ct);
                if (current == null || current.Status is not ("ready" or "pending") || !await scope.IsCurrent(db, ct))
                    return Changed();
                matches.Add(new { digest = Convert.ToHexString(digest.GetHashAndReset()), asset = current.Dto() });
            }
            return Results.Ok(matches);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return Changed(); }
        catch (OperationCanceledException) when (!aborted.IsCancellationRequested)
        {
            return Results.Problem(statusCode: 408, title: "文件核对超时，可以从素材库直接拖入这份素材。");
        }
        finally { ReadSlots.Release(); }
    }

    private static IResult Changed() => Results.Problem(statusCode: 409, title: "素材正在写入或来源已变化，请等待素材库更新后重试。");
}
