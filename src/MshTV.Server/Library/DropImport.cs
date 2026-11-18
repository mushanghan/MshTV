using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.EntityFrameworkCore;
using MshTV.Core;
using MshTV.Infrastructure;
using MshTV.Server.Workspace;

namespace MshTV.Server.Library;

internal static class DropImport
{
    private const long MaxBytes = 32L * 1024 * 1024 * 1024;
    private const long DiskReserve = 5L * 1024 * 1024 * 1024;
    private static readonly SemaphoreSlim UploadSlot = new(1, 1);

    public static async Task<IResult> Save(string name, HttpContext context, LibraryPaths paths,
        CanvasDatabase db, DatabaseWriteGate gate, LibraryWorker worker, CancellationToken aborted)
    {
        if (string.IsNullOrWhiteSpace(name) || name.Length > 255 || name.IndexOfAny(['/', '\\', ':', '\0']) >= 0
            || name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
            return Results.Problem(statusCode: 400, title: "拖入的文件名无效。");

        var extension = Path.GetExtension(name).ToLowerInvariant();
        var kind = LibraryTypes.Kind(extension);
        if (kind == null || context.Request.ContentLength is not long size || size <= 0 || size > MaxBytes)
            return Results.Problem(statusCode: 400, title: "请拖入支持的图片、视频或音频。单文件需大于 0 字节且不超过 32 GiB。");
        if (!string.Equals(context.Request.ContentType, "application/octet-stream", StringComparison.OrdinalIgnoreCase))
            return Results.Problem(statusCode: 415, title: "请通过页面拖入文件。");
        if (context.Features.Get<IHttpMaxRequestBodySizeFeature>() is not { IsReadOnly: false } limit)
            return Results.Problem(statusCode: 503, title: "当前后端无法接收导入文件。");
        if (!UploadSlot.Wait(0))
            return Results.Problem(statusCode: 429, title: "后端正在导入另一个文件，请稍后再拖入。");

        string? temporaryName = null;
        try
        {
            limit.MaxRequestBodySize = size;
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(aborted);
            timeout.CancelAfter(TimeSpan.FromMinutes(15));
            var ct = timeout.Token;
            SafeMediaFiles.CheckComponents(paths.Data);
            Directory.CreateDirectory(paths.Imports);
            SafeMediaFiles.CheckComponents(paths.Imports);
            if (new DriveInfo(Path.GetPathRoot(paths.Imports)!).AvailableFreeSpace - size < DiskReserve)
                return Results.Problem(statusCode: 507, title: "本机磁盘空间不足，导入后需保留至少 5 GiB 空闲空间。");

            var staging = $".part-{Guid.NewGuid():N}";
            string storedName;
            await using (var output = new FileStream(Path.Combine(paths.Imports, staging), FileMode.CreateNew,
                FileAccess.Write, FileShare.None, 65536, FileOptions.Asynchronous | FileOptions.SequentialScan))
            {
                temporaryName = staging;
                SafeMediaFiles.ValidateHandle(paths.Imports, output.SafeFileHandle);
                using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                hash.AppendData(Encoding.UTF8.GetBytes(name));
                hash.AppendData([0]);
                var buffer = new byte[65536];
                for (long remaining = size; remaining > 0;)
                {
                    var read = await context.Request.Body.ReadAsync(buffer.AsMemory(0, (int)Math.Min(remaining, buffer.Length)), ct);
                    if (read == 0) return Results.Problem(statusCode: 400, title: "文件未完整传入，请重新拖入。");
                    await output.WriteAsync(buffer.AsMemory(0, read), ct);
                    hash.AppendData(buffer.AsSpan(0, read));
                    remaining -= read;
                }
                output.Flush(flushToDisk: true);
                storedName = Convert.ToHexString(hash.GetHashAndReset()) + extension;
            }

            var scope = WorkspaceScope.Get(context);
            var asset = await RegisterCopy(db, gate, paths, scope, staging, storedName, name, kind, extension, size, ct);
            if (asset == null) return WorkspaceScope.Changed();
            await worker.Notify(asset.Id, allAssets: true, libraryId: scope.LibraryId);
            return Results.Ok(asset);
        }
        catch (BadHttpRequestException e) { return Results.Problem(statusCode: e.StatusCode, title: "文件未完整传入，请重新拖入。"); }
        catch (OperationCanceledException) when (!aborted.IsCancellationRequested)
        { return Results.Problem(statusCode: 408, title: "导入超时，请重新拖入文件。"); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        { return Results.Problem(statusCode: 503, title: "无法在本机保存导入文件，请检查应用数据目录和磁盘空间。"); }
        finally
        {
            if (temporaryName != null)
            {
                try { File.Delete(SafeMediaFiles.Resolve(paths.Imports, temporaryName)); }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
            }
            UploadSlot.Release();
        }
    }

    private static async Task<AssetDto?> RegisterCopy(CanvasDatabase db, DatabaseWriteGate gate, LibraryPaths paths, WorkspaceScope scope,
        string staging, string storedName, string name, string kind, string extension, long size, CancellationToken ct)
    {
        await gate.Semaphore.WaitAsync(ct);
        try
        {
            if (!await scope.IsCurrent(db, ct)) return null;
            var root = await db.LibraryRoots.FindAsync([LibraryRoot.ImportedRootId], ct);
            if (root == null)
            {
                root = new LibraryRoot { Id = LibraryRoot.ImportedRootId, Path = paths.Imports, Enabled = false, IncludeSubdirectories = false };
                db.LibraryRoots.Add(root);
            }
            if (!string.Equals(root.Path, paths.Imports, StringComparison.OrdinalIgnoreCase))
                throw new IOException("保存位置已改变。");

            var pathKey = OperatingSystem.IsWindows() ? storedName.ToUpperInvariant() : storedName;
            var asset = await db.LibraryAssets.SingleOrDefaultAsync(a => a.RootId == root.Id && a.PathKey == pathKey, ct);
            var destination = Path.Combine(paths.Imports, storedName);
            var reuse = asset != null && CopyMatches(root.Path, asset);
            if (reuse && asset is { Status: "ready" or "pending" })
            {
                var link = await Link(db, scope, asset.Id, ct);
                await db.SaveChangesAsync(ct);
                return new ScopedAsset { Asset = asset, Member = link, PhysicalRoot = root, Source = root }.Dto();
            }

            ct.ThrowIfCancellationRequested();
            if (!reuse)
            {
                SafeMediaFiles.CheckComponents(paths.Imports);
                if (File.Exists(destination)) SafeMediaFiles.CheckComponents(destination);
                // Publish the flushed copy before its row. A retry can replace an unregistered copy at this same managed location.
                File.Move(SafeMediaFiles.Resolve(paths.Imports, staging), destination, overwrite: true);
            }
            using var source = SafeMediaFiles.Open(paths.Imports, storedName);
            if (asset == null)
            {
                asset = new LibraryAsset { RootId = root.Id, RelativePath = storedName, PathKey = pathKey, Name = name, Kind = kind, Extension = extension };
                db.LibraryAssets.Add(asset);
            }
            else { asset.Version++; asset.Revision++; }
            asset.Size = size;
            asset.PhysicalPath = destination;
            asset.ModifiedAt = ModifiedAt(source);
            asset.FileKey = SafeMediaFiles.Identity(source);
            asset.Removed = false;
            asset.Status = "pending";
            asset.StableSince = 0;
            asset.LeaseUntil = 0;
            asset.RetryAt = 0;
            asset.HasThumbnail = false;
            asset.HasPreview = false;
            asset.Width = null;
            asset.Height = null;
            asset.Duration = null;
            asset.Error = null;
            var member = await Link(db, scope, asset.Id, CancellationToken.None);
            await db.SaveChangesAsync(CancellationToken.None);
            return new ScopedAsset { Asset = asset, Member = member, PhysicalRoot = root, Source = root }.Dto();
        }
        finally { gate.Semaphore.Release(); }
    }

    private static async Task<LibraryMember> Link(CanvasDatabase db, WorkspaceScope scope, string assetId, CancellationToken ct)
    {
        var member = await db.LibraryMembers.FindAsync([scope.LibraryId, assetId], ct);
        if (member == null)
        {
            member = new LibraryMember { LibraryId = scope.LibraryId, AssetId = assetId, RootId = LibraryRoot.ImportedRootId };
            db.LibraryMembers.Add(member);
        }
        else if (member.Removed || member.Missing)
        {
            member.Removed = false; member.Missing = false; member.Revision++;
        }
        return member;
    }

    private static bool CopyMatches(string root, LibraryAsset asset)
    {
        try
        {
            using var source = SafeMediaFiles.Open(root, asset.RelativePath);
            return source.Length == asset.Size && ModifiedAt(source) == asset.ModifiedAt
                && (asset.FileKey == null || SafeMediaFiles.Identity(source) == asset.FileKey);
        }
        catch (FileNotFoundException) { return false; }
    }

    private static long ModifiedAt(FileStream source) => new DateTimeOffset(File.GetLastWriteTimeUtc(source.SafeFileHandle)).ToUnixTimeMilliseconds();
}
