using Microsoft.EntityFrameworkCore;
using MshTV.Core;
using MshTV.Infrastructure;

namespace MshTV.Server.Library;

internal sealed class ScopedAsset
{
    public required LibraryAsset Asset { get; init; }
    public required LibraryMember Member { get; init; }
    public required LibraryRoot PhysicalRoot { get; init; }
    public LibraryRoot? Source { get; init; }

    public string Status => Member.Removed ? "removed" : Source?.Removed == true ? "sourceRemoved" :
        Source?.Online == false ? "offline" :
        Member.Missing || Source != null && !SafeMediaFiles.Within(Source.Path, Asset.PhysicalPath) ? "missing" : Asset.Status;

    public long Revision => Member.Revision + Asset.Revision;

    public AssetDto Dto() => new(Asset.Id, Member.RootId ?? "", Asset.Name, Asset.Kind, Asset.Extension, Asset.Size,
        Asset.ModifiedAt, Asset.AddedAt, Status, Asset.Version, Asset.Width, Asset.Height, Asset.Duration,
        Asset.HasThumbnail, Asset.HasPreview, Asset.Error, Revision,
        Path.GetDirectoryName(Source == null || Source.Id == PhysicalRoot.Id
            ? Asset.RelativePath : Path.GetRelativePath(Source.Path, Asset.PhysicalPath)) ?? "");

    public static IQueryable<ScopedAsset> Query(CanvasDatabase db, string libraryId) =>
        from member in db.LibraryMembers.AsNoTracking()
        where member.LibraryId == libraryId
        join asset in db.LibraryAssets.AsNoTracking() on member.AssetId equals asset.Id
        join physical in db.LibraryRoots.AsNoTracking() on asset.RootId equals physical.Id
        join watch in db.LibraryRoots.AsNoTracking() on member.RootId equals watch.Id into sources
        from source in sources.DefaultIfEmpty()
        select new ScopedAsset { Asset = asset, Member = member, PhysicalRoot = physical, Source = source };

    public static IQueryable<ScopedAsset> Available(IQueryable<ScopedAsset> query) =>
        query.Where(row => !row.Member.Removed && !row.Member.Missing &&
            (row.Source == null || !row.Source.Removed && row.Source.Online));
}
