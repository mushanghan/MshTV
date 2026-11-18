using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using MshTV.Core;

namespace MshTV.Infrastructure;

public sealed partial class BoardRow
{
    public string Id { get; set; } = "main";
    public long Revision { get; set; }
    public string DocumentJson { get; set; } = "";
}
public sealed class ReceiptRow
{
    public string Key { get; set; } = "";
    public string Hash { get; set; } = "";
    public long Revision { get; set; }
}
public sealed class PerformanceModeRow
{
    public int Id { get; set; }
    public bool Enabled { get; set; }
    public long Revision { get; set; }
}
public sealed partial class CanvasDatabase(DbContextOptions<CanvasDatabase> options) : DbContext(options)
{
    public DbSet<BoardRow> Boards => Set<BoardRow>();
    public DbSet<ReceiptRow> Receipts => Set<ReceiptRow>();
    public DbSet<PerformanceModeRow> PerformanceMode => Set<PerformanceModeRow>();
    public DbSet<LibraryRoot> LibraryRoots => Set<LibraryRoot>();
    public DbSet<LibraryAsset> LibraryAssets => Set<LibraryAsset>();
    public DbSet<LibraryIgnoredFile> LibraryIgnoredFiles => Set<LibraryIgnoredFile>();
    protected override void OnModelCreating(ModelBuilder model)
    {
        model.Entity<BoardRow>().HasKey(x => x.Id);
        model.Entity<ReceiptRow>().HasKey(x => x.Key);
        model.Entity<PerformanceModeRow>().HasKey(x => x.Id);
        model.Entity<LibraryRoot>().HasKey(x => x.Id);
        model.Entity<LibraryRoot>().HasIndex(x => new { x.LibraryId, x.Path }).IsUnique();
        model.Entity<LibraryAsset>().HasKey(x => x.Id);
        model.Entity<LibraryAsset>().HasIndex(x => new { x.RootId, x.PathKey }).IsUnique();
        model.Entity<LibraryAsset>().HasIndex(x => x.FileKey);
        model.Entity<LibraryAsset>().HasIndex(x => new { x.Name, x.Size });
        model.Entity<LibraryAsset>().HasIndex(x => new { x.Status, x.RetryAt, x.LeaseUntil });
        model.Entity<LibraryAsset>().HasIndex(x => new { x.AddedAt, x.Id });
        model.Entity<LibraryAsset>().HasIndex(x => new { x.ModifiedAt, x.Id });
        model.Entity<LibraryAsset>().HasOne<LibraryRoot>().WithMany().HasForeignKey(x => x.RootId).OnDelete(DeleteBehavior.Restrict);
        model.Entity<LibraryIgnoredFile>().HasKey(x => new { x.RootId, x.PathKey });
        model.Entity<LibraryIgnoredFile>().HasIndex(x => new { x.RootId, x.FileKey });
        model.Entity<LibraryIgnoredFile>().HasOne<LibraryRoot>().WithMany().HasForeignKey(x => x.RootId).OnDelete(DeleteBehavior.Restrict);
        ConfigureWorkspace(model);
    }
}

[DbContext(typeof(CanvasDatabase))]
[Migration("202611080002_Library")]
public sealed class AddLibrary : Migration
{
    protected override void Up(MigrationBuilder m)
    {
        m.Sql("""
        CREATE TABLE LibraryRoots (Id TEXT NOT NULL PRIMARY KEY, Path TEXT NOT NULL, Enabled INTEGER NOT NULL, Removed INTEGER NOT NULL,
          Online INTEGER NOT NULL, LastScanAt INTEGER NOT NULL, Error TEXT NULL);
        CREATE UNIQUE INDEX IX_LibraryRoots_Path ON LibraryRoots(Path);
        CREATE TABLE LibraryAssets (Id TEXT NOT NULL PRIMARY KEY, RootId TEXT NOT NULL REFERENCES LibraryRoots(Id), RelativePath TEXT NOT NULL,
          PathKey TEXT NOT NULL, FileKey TEXT NULL, Name TEXT NOT NULL, Kind TEXT NOT NULL, Extension TEXT NOT NULL,
          Size INTEGER NOT NULL, ModifiedAt INTEGER NOT NULL, AddedAt INTEGER NOT NULL, StableSince INTEGER NOT NULL,
          RetryAt INTEGER NOT NULL, LeaseUntil INTEGER NOT NULL, Version INTEGER NOT NULL, Status TEXT NOT NULL, SeenScan TEXT NOT NULL,
          Width INTEGER NULL, Height INTEGER NULL, Duration REAL NULL, HasThumbnail INTEGER NOT NULL, HasPreview INTEGER NOT NULL, Error TEXT NULL);
        CREATE UNIQUE INDEX IX_LibraryAssets_RootId_PathKey ON LibraryAssets(RootId,PathKey);
        CREATE INDEX IX_LibraryAssets_FileKey ON LibraryAssets(FileKey);
        CREATE INDEX IX_LibraryAssets_Status_RetryAt_LeaseUntil ON LibraryAssets(Status,RetryAt,LeaseUntil);
        CREATE INDEX IX_LibraryAssets_AddedAt_Id ON LibraryAssets(AddedAt,Id);
        CREATE INDEX IX_LibraryAssets_ModifiedAt_Id ON LibraryAssets(ModifiedAt,Id);
        """);
    }
    protected override void Down(MigrationBuilder m) { m.DropTable("LibraryAssets"); m.DropTable("LibraryRoots"); }
}

[DbContext(typeof(CanvasDatabase))]
[Migration("202611080003_RootRevision")]
public sealed class AddRootRevision : Migration
{
    protected override void Up(MigrationBuilder m) => m.AddColumn<long>("Revision", "LibraryRoots", nullable: false, defaultValue: 1L);
    protected override void Down(MigrationBuilder m) => m.DropColumn("Revision", "LibraryRoots");
}

[DbContext(typeof(CanvasDatabase))]
[Migration("202611090004_MonitorOptions")]
public sealed class AddMonitorOptions : Migration
{
    protected override void Up(MigrationBuilder m)
    {
        m.AddColumn<bool>("IncludeSubdirectories", "LibraryRoots", nullable: false, defaultValue: true);
        m.AddColumn<bool>("NewFilesOnly", "LibraryRoots", nullable: false, defaultValue: false);
        m.AddColumn<bool>("BaselinePending", "LibraryRoots", nullable: false, defaultValue: false);
        m.Sql("""
        CREATE TABLE LibraryIgnoredFiles (RootId TEXT NOT NULL REFERENCES LibraryRoots(Id), PathKey TEXT NOT NULL,
          RelativePath TEXT NOT NULL, FileKey TEXT NULL, PRIMARY KEY (RootId,PathKey));
        CREATE INDEX IX_LibraryIgnoredFiles_RootId_FileKey ON LibraryIgnoredFiles(RootId,FileKey);
        """);
    }
    protected override void Down(MigrationBuilder m)
    {
        m.DropTable("LibraryIgnoredFiles");
        m.DropColumn("IncludeSubdirectories", "LibraryRoots"); m.DropColumn("NewFilesOnly", "LibraryRoots"); m.DropColumn("BaselinePending", "LibraryRoots");
    }
}

[DbContext(typeof(CanvasDatabase))]
[Migration("202611090005_LibraryRemoval")]
public sealed class AddLibraryRemoval : Migration
{
    protected override void Up(MigrationBuilder m)
    {
        m.AddColumn<bool>("Removed", "LibraryAssets", nullable: false, defaultValue: false);
        m.AddColumn<long>("Revision", "LibraryAssets", nullable: false, defaultValue: 1L);
    }
    protected override void Down(MigrationBuilder m) { m.DropColumn("Removed", "LibraryAssets"); m.DropColumn("Revision", "LibraryAssets"); }
}

[DbContext(typeof(CanvasDatabase))]
[Migration("202611110006_DropLookup")]
public sealed class AddDropLookup : Migration
{
    protected override void Up(MigrationBuilder m) => m.CreateIndex("IX_LibraryAssets_Name_Size", "LibraryAssets", new[] { "Name", "Size" });
    protected override void Down(MigrationBuilder m) => m.DropIndex("IX_LibraryAssets_Name_Size", "LibraryAssets");
}

[DbContext(typeof(CanvasDatabase))]
[Migration("202611110007_RetryImagePreviews")]
public sealed class RetryImagePreviews : Migration
{
    protected override void Up(MigrationBuilder m) => m.Sql("""
        UPDATE LibraryAssets
        SET Status = 'pending', RetryAt = 0, LeaseUntil = 0, HasThumbnail = 0, HasPreview = 0,
            Error = NULL, Version = Version + 1, Revision = Revision + 1
        WHERE Kind = 'image' AND Status = 'ready' AND Removed = 0 AND (HasThumbnail = 0 OR HasPreview = 0)
          AND COALESCE(Width, 0) * COALESCE(Height, 0) <= 100000000
          AND RootId IN (SELECT Id FROM LibraryRoots WHERE Removed = 0);
        """);
    protected override void Down(MigrationBuilder m) { } // Derived previews can be regenerated by either version.
}

[DbContext(typeof(CanvasDatabase))]
[Migration("202611110008_RetryJpegPreviews")]
public sealed class RetryJpegPreviews : Migration
{
    protected override void Up(MigrationBuilder m) => m.Sql("""
        UPDATE LibraryAssets
        SET Status = 'pending', RetryAt = 0, LeaseUntil = 0, HasThumbnail = 0, HasPreview = 0,
            Error = NULL, Version = Version + 1, Revision = Revision + 1
        WHERE Kind = 'image' AND Extension IN ('.jpg', '.jpeg') AND Status = 'ready' AND Removed = 0
          AND (HasThumbnail = 0 OR HasPreview = 0)
          AND COALESCE(Width, 0) * COALESCE(Height, 0) <= 100000000
          AND RootId IN (SELECT Id FROM LibraryRoots WHERE Removed = 0);
        """);
    protected override void Down(MigrationBuilder m) { } // No schema changes.
}

[DbContext(typeof(CanvasDatabase))]
[Migration("202611110009_VideoCovers")]
public sealed class AddVideoCovers : Migration
{
    protected override void Up(MigrationBuilder m) => m.Sql("""
        UPDATE LibraryAssets
        SET Status = 'pending', RetryAt = 0, LeaseUntil = 0, Revision = Revision + 1
        WHERE Kind = 'video' AND Status = 'ready' AND Removed = 0 AND HasThumbnail = 1 AND HasPreview = 0
          AND RootId IN (SELECT Id FROM LibraryRoots WHERE Removed = 0);
        """);
    protected override void Down(MigrationBuilder m) { } // No schema changes.
}

[DbContext(typeof(CanvasDatabase))]
[Migration("202611150010_PerformanceMode")]
public sealed class AddPerformanceMode : Migration
{
    protected override void Up(MigrationBuilder m) => m.Sql("""
        CREATE TABLE PerformanceMode (
          Id INTEGER NOT NULL PRIMARY KEY CHECK (Id = 1),
          Enabled INTEGER NOT NULL CHECK (Enabled IN (0, 1)),
          Revision INTEGER NOT NULL CHECK (Revision >= 1)
        );
        INSERT INTO PerformanceMode (Id, Enabled, Revision) VALUES (1, 0, 1);
        """);

    protected override void Down(MigrationBuilder m) => m.DropTable("PerformanceMode");
}

// Boards retain their versioned MVP document; new library references do not change existing element IDs.
[DbContext(typeof(CanvasDatabase))]
[Migration("202611070001_InitialCanvas")]
public sealed class InitialCanvas : Migration
{
    protected override void Up(MigrationBuilder m)
    {
        m.Sql("CREATE TABLE Boards (Id TEXT NOT NULL PRIMARY KEY, Revision INTEGER NOT NULL, DocumentJson TEXT NOT NULL)");
        m.Sql("CREATE TABLE Receipts (Key TEXT NOT NULL PRIMARY KEY, Hash TEXT NOT NULL, Revision INTEGER NOT NULL)");
    }
    protected override void Down(MigrationBuilder m)
    {
        m.DropTable("Receipts"); m.DropTable("Boards");
    }
}
