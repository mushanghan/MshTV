namespace MshTV.Core;

public sealed class LibraryRoot
{
    public const string ImportedRootId = "00000000-0000-0000-0000-000000000001";
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public string LibraryId { get; set; } = "main";
    public string Path { get; set; } = "";
    public bool Enabled { get; set; } = true;
    public bool Removed { get; set; }
    public bool Online { get; set; } = true;
    public bool IncludeSubdirectories { get; set; } = true;
    public bool NewFilesOnly { get; set; }
    public bool BaselinePending { get; set; }
    public long Revision { get; set; } = 1;
    public long LastScanAt { get; set; }
    public string? Error { get; set; }
}
// Files present when new-only monitoring starts are remembered without creating media assets or jobs.
public sealed class LibraryIgnoredFile
{
    public string RootId { get; set; } = "";
    public string PathKey { get; set; } = "";
    public string RelativePath { get; set; } = "";
    public string? FileKey { get; set; }
}
public sealed class LibraryAsset
{
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public string RootId { get; set; } = "";
    public bool Removed { get; set; }
    public long Revision { get; set; } = 1;
    public string RelativePath { get; set; } = "";
    public string PathKey { get; set; } = "";
    public string PhysicalPath { get; set; } = "";
    public string? FileKey { get; set; }
    public string Name { get; set; } = "";
    public string Kind { get; set; } = "";
    public string Extension { get; set; } = "";
    public long Size { get; set; }
    public long ModifiedAt { get; set; }
    public long AddedAt { get; set; } = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    public long StableSince { get; set; }
    public long RetryAt { get; set; }
    public long LeaseUntil { get; set; }
    public int Version { get; set; } = 1;
    public string Status { get; set; } = "pending";
    public string SeenScan { get; set; } = "";
    public int? Width { get; set; }
    public int? Height { get; set; }
    public double? Duration { get; set; }
    public bool HasThumbnail { get; set; }
    public bool HasPreview { get; set; }
    public string? Error { get; set; }
}
public record AssetDto(string Id, string RootId, string Name, string Kind, string Extension, long Size,
    long ModifiedAt, long AddedAt, string Status, int Version, int? Width, int? Height, double? Duration,
    bool HasThumbnail, bool HasPreview, string? Error, long Revision, string Folder);
public record RootRequest(string Path, bool IncludeSubdirectories = true, bool NewFilesOnly = false);
public record RootSettings(bool Enabled, long Revision, bool? IncludeSubdirectories = null, bool? NewFilesOnly = null);
public record RootDto(string Id, string Path, bool Enabled, bool Online, long LastScanAt, string? Error, long Revision,
    bool IncludeSubdirectories, bool NewFilesOnly, bool BaselinePending, bool Managed)
{
    public static RootDto From(LibraryRoot root) => new(root.Id, root.Path, root.Enabled, root.Online, root.LastScanAt, root.Error, root.Revision,
        root.IncludeSubdirectories, root.NewFilesOnly, root.BaselinePending, root.Id == LibraryRoot.ImportedRootId);
}
