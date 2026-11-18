using System.Net;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using MshTV.Core;
using MshTV.Infrastructure;
using MshTV.Server.Library;
using MshTV.Server.Export;
using MshTV.Server.Clipboard;
using MshTV.Server.Workspace;
using MshTV.Server.Storage;
using MshTV.Server.Network;

if (args.Length > 0 && args[0] == FolderPicker.Command)
{
    Environment.ExitCode = OperatingSystem.IsWindows() ? FolderPicker.RunDialog(args.ElementAtOrDefault(1)) : 1;
    return;
}

var builder = WebApplication.CreateBuilder(args);
var port = int.Parse(Environment.GetEnvironmentVariable("MSHTV_PORT") ?? "5188");
var dataDirectory = Environment.GetEnvironmentVariable("MSHTV_DATA_DIR") ??
    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MshTV", "data");
var anchor = Path.GetFullPath(dataDirectory);
var storage = new StorageLocation(anchor);
using var storageLock = storage.Lock();
storage.Start();
dataDirectory = storage.Current;
var workspaceVersion = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(dataDirectory)));
using var lan = new LanHost(anchor, port);
lan.Load();
var sessions = new AccessSessions(lan, new RememberedLanDevices(anchor));
builder.Configuration["AllowedHosts"] = "localhost;127.0.0.1;[::1]" + (lan.Listening is { } configured ? ";" + configured.Address : "");
builder.WebHost.ConfigureKestrel(options =>
{
    options.Limits.MaxRequestBodySize = 1024 * 1024;
    options.Listen(IPAddress.Loopback, port);
    if (lan.Listening is { } active)
        options.Listen(IPAddress.Parse(active.Address!), active.Port, endpoint => endpoint.UseHttps(tls =>
        {
            tls.ServerCertificate = lan.Certificate;
            tls.SslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13;
        }));
});
builder.Services.AddSingleton(lan);
builder.Services.AddSingleton(sessions);
builder.Services.AddSingleton(storage);
builder.Services.AddDbContext<CanvasDatabase>(o => o.UseSqlite(new SqliteConnectionStringBuilder
    { DataSource = Path.Combine(dataDirectory, "canvas.db"), DefaultTimeout = 5 }.ToString()));
builder.Services.AddProblemDetails();
builder.Services.AddSingleton(new LibraryPaths(dataDirectory, Path.Combine(dataDirectory, "media-cache")));
builder.Services.AddSingleton<DatabaseWriteGate>();
builder.Services.AddSingleton<MediaProcessingMode>();
builder.Services.AddSignalR();
builder.Services.AddSingleton<MediaProcessor>();
builder.Services.AddSingleton<AudioWaveforms>();
builder.Services.AddSingleton<LibraryWorker>();
builder.Services.AddHostedService(provider => provider.GetRequiredService<LibraryWorker>());
builder.Services.AddSingleton<BoardExport>();
builder.Services.AddHostedService(provider => provider.GetRequiredService<BoardExport>());
if (Environment.GetEnvironmentVariable("MSHTV_LAUNCHER_PIPE") is { } launcherPipe)
    builder.Services.AddHostedService(provider => new LauncherControl(launcherPipe, provider.GetRequiredService<IHostApplicationLifetime>()));
var app = builder.Build();
sessions.Load(app.Logger);
var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<CanvasDatabase>();
    await db.Database.OpenConnectionAsync();
    var connection = (SqliteConnection)db.Database.GetDbConnection();
    if (Version.Parse(connection.ServerVersion) < new Version(3, 51, 3))
        throw new InvalidOperationException($"SQLite {connection.ServerVersion} is older than required 3.51.3.");
    await db.Database.ExecuteSqlRawAsync("PRAGMA journal_mode=WAL;");
    await db.Database.ExecuteSqlRawAsync("PRAGMA synchronous=FULL;");
    // SQLite Backup API keeps migration backup consistent even with a WAL file.
    var migrations = (await db.Database.GetPendingMigrationsAsync()).ToArray();
    using var inspect = connection.CreateCommand();
    inspect.CommandText = "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*')";
    if (migrations.Length > 0 && (long)inspect.ExecuteScalar()! != 0)
    {
        var name = migrations.Contains("202611150011_Workspace")
            ? $"before-workspace-{DateTime.UtcNow:yyyyMMdd-HHmmss}-{Guid.NewGuid():N}.db" : "before-migration.db";
        using var backup = new SqliteConnection(new SqliteConnectionStringBuilder
            { DataSource = Path.Combine(dataDirectory, name), Pooling = false }.ToString());
        backup.Open();
        connection.BackupDatabase(backup);
        using var check = backup.CreateCommand();
        check.CommandText = "PRAGMA journal_mode=DELETE";
        if (!string.Equals(check.ExecuteScalar() as string, "delete", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Migration backup could not be verified as a standalone SQLite file.");
        check.CommandText = "PRAGMA quick_check";
        if (!string.Equals(check.ExecuteScalar() as string, "ok", StringComparison.Ordinal))
            throw new InvalidOperationException("Migration backup did not pass the SQLite integrity check.");
    }
    await db.Database.MigrateAsync();
    var mode = await db.PerformanceMode.AsNoTracking().SingleAsync();
    app.Services.GetRequiredService<MediaProcessingMode>().Apply(new(mode.Enabled, mode.Revision));
    // The migration creates the initial library. Empty workspaces with retained library history are intentional.
    if (!await db.Boards.AnyAsync() && !await db.MaterialLibraries.AnyAsync(row => row.Id != "main" || row.Archived))
    {
        var now = LibraryTypes.Now;
        db.Boards.Add(new BoardRow { CreatedAt = now, ModifiedAt = now,
            DocumentJson = JsonSerializer.Serialize(new BoardDocument(1, "自由画布", [], []), json) });
        await db.SaveChangesAsync();
    }
}

var writeGate = app.Services.GetRequiredService<DatabaseWriteGate>().Semaphore;
app.UseExceptionHandler();
app.Use(sessions.Enforce);
WorkspaceScope.Install(app);

app.MapGet("/api/v1/health", () => Results.Ok(new { name = "MshTV", status = "ok", monitorOptionsVersion = 1 }));
app.MapPost("/api/v1/session", sessions.Bootstrap);
app.MapGet("/api/v1/boards/{boardId}", async (string boardId, CanvasDatabase db, CancellationToken ct) =>
{
    var board = await WorkspaceScope.LiveBoards(db).AsNoTracking().SingleOrDefaultAsync(x => x.Id == boardId, ct);
    if (board == null) return Results.NotFound();
    return Results.Ok(new
    {
        board.Id, board.Revision, workspaceVersion,
        Document = BoardRules.Normalize(JsonSerializer.Deserialize<BoardDocument>(board.DocumentJson, json)!)
    });
});
app.MapPost("/api/v1/boards/{boardId}/mutations", async (string boardId, MutationRequest request, CanvasDatabase db, HttpContext context, CancellationToken ct) =>
{
    var workspace = context.Request.Headers["X-MshTV-Workspace"].ToString();
    if ((workspace.Length > 0 || AccessSessions.IsRemote(context)) && workspace != workspaceVersion)
        return Results.Problem(statusCode: 409, title: "工作目录已切换，请先核对当前修改，再重新打开画布。");
    if (request == null || !Guid.TryParse(request.ClientId, out _) || !Guid.TryParse(request.MutationId, out _) || request.Operations == null)
        return Results.Problem(statusCode: 400, title: "无效的提交标识");
    await writeGate.WaitAsync();
    try
    {
        await using var tx = await db.Database.BeginTransactionAsync();
        var board = await WorkspaceScope.LiveBoards(db).SingleOrDefaultAsync(x => x.Id == boardId, ct);
        if (board == null) return Results.NotFound();
        var key = $"{boardId}:{request.ClientId}:{request.MutationId}";
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(request, json))));
        var receipt = await db.Receipts.FindAsync(key);
        if (receipt != null) return receipt.Hash == hash ? Results.Ok(new MutationResult(receipt.Revision)) : Results.Problem(statusCode: 400, title: "提交标识被重复用于不同内容");
        if (request.BaseRevision != board.Revision)
            return Results.Problem(statusCode: 409, title: "画布已在另一个页面修改，请重新加载。", extensions: new Dictionary<string, object?> { ["revision"] = board.Revision });
        var current = JsonSerializer.Deserialize<BoardDocument>(board.DocumentJson, json)!;
        BoardDocument next;
        try { next = BoardRules.Apply(current, request.Operations); }
        catch (ArgumentException e) { return Results.Problem(statusCode: 400, title: e.Message); }
        var assetIds = next.Items.Where(i => i.AssetId != null && Guid.TryParse(i.AssetId, out _)).Select(i => i.AssetId!).Distinct().ToList();
        var assets = await (from member in db.LibraryMembers
                            join asset in db.LibraryAssets on member.AssetId equals asset.Id
                            where member.LibraryId == board.LibraryId && assetIds.Contains(asset.Id)
                            select new { asset.Id, asset.Kind }).ToDictionaryAsync(a => a.Id, a => a.Kind, ct);
        if (next.Items.Any(i => i.AssetId != null && Guid.TryParse(i.AssetId, out _) && (!assets.TryGetValue(i.AssetId, out var kind) || kind != i.Type)))
            return Results.Problem(statusCode: 400, title: "素材引用不存在或类型不匹配。");
        board.DocumentJson = JsonSerializer.Serialize(next, json);
        board.Revision++;
        board.ModifiedAt = LibraryTypes.Now;
        db.Receipts.Add(new ReceiptRow { Key = key, Hash = hash, Revision = board.Revision });
        await db.SaveChangesAsync();
        await tx.CommitAsync();
        return Results.Ok(new MutationResult(board.Revision));
    }
    finally { writeGate.Release(); }
});
app.MapLibrary();
app.MapLan();
app.MapWorkspace();
app.MapStorage();
app.MapMediaMode();
app.MapFileClipboard();
var exports = app.MapGroup("/api/v1/exports");
exports.MapPost("/pick-folder", FolderPicker.Pick);
exports.MapPost("/", (ExportRequest request, BoardExport worker, CanvasDatabase db, HttpContext context, CancellationToken ct) =>
    worker.Start(request, context.Request.Cookies["mshtv-session"]!, WorkspaceScope.Get(context), db, ct));
exports.MapGet("/active", (BoardExport worker, HttpContext context) =>
    worker.Active(context.Request.Cookies["mshtv-session"]!, WorkspaceScope.Get(context).BoardId));
exports.MapGet("/{id:guid}", (Guid id, BoardExport worker, HttpContext context) =>
    worker.Status(id, context.Request.Cookies["mshtv-session"]!, WorkspaceScope.Get(context).BoardId));
exports.MapPost("/{id:guid}/cancel", (Guid id, BoardExport worker, HttpContext context) =>
    worker.Cancel(id, context.Request.Cookies["mshtv-session"]!, WorkspaceScope.Get(context).BoardId));
exports.MapPost("/{id:guid}/open", (Guid id, BoardExport worker, HttpContext context) =>
    worker.Open(id, context.Request.Cookies["mshtv-session"]!, WorkspaceScope.Get(context).BoardId));
app.MapPost("/api/v1/system/shutdown", (HttpContext context, IHostApplicationLifetime lifetime) =>
{
    // Stop only after the authenticated response has reached the browser; the host cancels workers and drains requests.
    context.Response.OnCompleted(() => { lifetime.StopApplication(); return Task.CompletedTask; });
    return Results.Ok(new { status = "stopping" });
});
app.Map("/api/{**path}", () => Results.NotFound());
app.UseDefaultFiles();
app.UseStaticFiles();
app.MapFallbackToFile("index.html");
await app.RunAsync();
