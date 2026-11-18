using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using MshTV.Core;

namespace MshTV.Infrastructure;

public sealed partial class BoardRow
{
    public string LibraryId { get; set; } = "main";
    public string? GroupId { get; set; }
    public string Name { get; set; } = "自由画布";
    public long CreatedAt { get; set; }
    public long ModifiedAt { get; set; }
    public long? DeletedAt { get; set; }
    public bool Pinned { get; set; }
}

public sealed class WorkspaceGroupRow
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public long Revision { get; set; }
    public long CreatedAt { get; set; }
    public long? DeletedAt { get; set; }
}

public sealed class MaterialLibraryRow
{
    public string Id { get; set; } = "";
    public bool Archived { get; set; }
}

public sealed class LibraryMember
{
    public string LibraryId { get; set; } = "";
    public string AssetId { get; set; } = "";
    public string? RootId { get; set; }
    public bool Removed { get; set; }
    public bool Missing { get; set; }
    public long Revision { get; set; }
    public string SeenScan { get; set; } = "";
}

public sealed partial class CanvasDatabase
{
    public DbSet<WorkspaceGroupRow> WorkspaceGroups => Set<WorkspaceGroupRow>();
    public DbSet<MaterialLibraryRow> MaterialLibraries => Set<MaterialLibraryRow>();
    public DbSet<LibraryMember> LibraryMembers => Set<LibraryMember>();

    private static void ConfigureWorkspace(ModelBuilder model)
    {
        model.Entity<WorkspaceGroupRow>().HasKey(x => x.Id);
        model.Entity<WorkspaceGroupRow>().HasOne<MaterialLibraryRow>().WithOne().HasForeignKey<WorkspaceGroupRow>(x => x.Id).OnDelete(DeleteBehavior.Restrict);
        model.Entity<MaterialLibraryRow>().HasKey(x => x.Id);
        model.Entity<BoardRow>().HasIndex(x => x.GroupId);
        model.Entity<LibraryAsset>().Property(x => x.PhysicalPath).UseCollation("NOCASE");
        model.Entity<LibraryAsset>().HasIndex(x => x.PhysicalPath);
        model.Entity<LibraryMember>().HasKey(x => new { x.LibraryId, x.AssetId });
        model.Entity<LibraryMember>().HasIndex(x => x.AssetId);
        model.Entity<LibraryMember>().HasIndex(x => new { x.RootId, x.AssetId });
        model.Entity<LibraryMember>().HasOne<MaterialLibraryRow>().WithMany().HasForeignKey(x => x.LibraryId).OnDelete(DeleteBehavior.Restrict);
        model.Entity<LibraryMember>().HasOne<LibraryAsset>().WithMany().HasForeignKey(x => x.AssetId).OnDelete(DeleteBehavior.Restrict);
        model.Entity<LibraryMember>().HasOne<LibraryRoot>().WithMany().HasForeignKey(x => x.RootId).OnDelete(DeleteBehavior.Restrict);
    }
}

[DbContext(typeof(CanvasDatabase))]
[Migration("202611150011_Workspace")]
public sealed class AddWorkspace : Migration
{
    protected override void Up(MigrationBuilder m) => m.Sql("""
        CREATE TABLE MaterialLibraries (Id TEXT NOT NULL PRIMARY KEY, Archived INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE WorkspaceGroups (Id TEXT NOT NULL PRIMARY KEY REFERENCES MaterialLibraries(Id),
          Name TEXT NOT NULL, Revision INTEGER NOT NULL, CreatedAt INTEGER NOT NULL, DeletedAt INTEGER NULL);
        ALTER TABLE Boards ADD COLUMN LibraryId TEXT NOT NULL DEFAULT 'main';
        ALTER TABLE Boards ADD COLUMN GroupId TEXT NULL;
        ALTER TABLE Boards ADD COLUMN Name TEXT NOT NULL DEFAULT '自由画布';
        ALTER TABLE Boards ADD COLUMN CreatedAt INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE Boards ADD COLUMN ModifiedAt INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE Boards ADD COLUMN DeletedAt INTEGER NULL;
        ALTER TABLE Boards ADD COLUMN Pinned INTEGER NOT NULL DEFAULT 0;
        CREATE INDEX IX_Boards_GroupId ON Boards(GroupId);
        INSERT INTO MaterialLibraries (Id) VALUES ('main');
        INSERT INTO MaterialLibraries (Id) SELECT Id FROM Boards WHERE Id != 'main';
        UPDATE Boards SET LibraryId = Id, Name = COALESCE(NULLIF(json_extract(DocumentJson, '$.name'), ''), '自由画布'),
          CreatedAt = unixepoch() * 1000, ModifiedAt = unixepoch() * 1000;
        ALTER TABLE LibraryRoots ADD COLUMN LibraryId TEXT NOT NULL DEFAULT 'main';
        DROP INDEX IX_LibraryRoots_Path;
        CREATE UNIQUE INDEX IX_LibraryRoots_LibraryId_Path ON LibraryRoots(LibraryId, Path);
        ALTER TABLE LibraryAssets ADD COLUMN PhysicalPath TEXT COLLATE NOCASE NOT NULL DEFAULT '';
        UPDATE LibraryAssets SET PhysicalPath = (SELECT rtrim(Path, '\\/') FROM LibraryRoots WHERE Id = LibraryAssets.RootId)
          || '\' || RelativePath;
        CREATE INDEX IX_LibraryAssets_PhysicalPath ON LibraryAssets(PhysicalPath);
        CREATE TABLE LibraryMembers (LibraryId TEXT NOT NULL REFERENCES MaterialLibraries(Id),
          AssetId TEXT NOT NULL REFERENCES LibraryAssets(Id), RootId TEXT NULL REFERENCES LibraryRoots(Id),
          Removed INTEGER NOT NULL, Missing INTEGER NOT NULL, Revision INTEGER NOT NULL, SeenScan TEXT NOT NULL,
          PRIMARY KEY (LibraryId, AssetId));
        CREATE INDEX IX_LibraryMembers_AssetId ON LibraryMembers(AssetId);
        CREATE INDEX IX_LibraryMembers_RootId_AssetId ON LibraryMembers(RootId, AssetId);
        INSERT INTO LibraryMembers (LibraryId, AssetId, RootId, Removed, Missing, Revision, SeenScan)
          SELECT 'main', Id, RootId, Removed, Status = 'missing', 0, SeenScan FROM LibraryAssets;
        INSERT OR IGNORE INTO LibraryMembers (LibraryId, AssetId, RootId, Removed, Missing, Revision, SeenScan)
          SELECT b.LibraryId, a.Id, NULL, a.Removed, a.Status = 'missing', 0, a.SeenScan
          FROM Boards b, json_each(b.DocumentJson, '$.items') i
          JOIN LibraryAssets a ON a.Id = json_extract(i.value, '$.assetId') WHERE b.Id != 'main';
        UPDATE LibraryAssets SET Removed = 0 WHERE Removed = 1;
        """);

    protected override void Down(MigrationBuilder m) =>
        throw new NotSupportedException("Restore the pre-workspace backup to return to the single-canvas database.");
}
