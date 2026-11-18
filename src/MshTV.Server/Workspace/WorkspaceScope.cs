using Microsoft.EntityFrameworkCore;
using MshTV.Infrastructure;

namespace MshTV.Server.Workspace;

public sealed record WorkspaceScope(string BoardId, string LibraryId)
{
    private static readonly object ItemKey = new();

    public static IQueryable<BoardRow> LiveBoards(CanvasDatabase db) =>
        db.Boards.Where(board => board.DeletedAt == null &&
            db.MaterialLibraries.Any(library => library.Id == board.LibraryId && !library.Archived) &&
            (board.GroupId == null || db.WorkspaceGroups.Any(group => group.Id == board.GroupId && group.DeletedAt == null)));

    public static WorkspaceScope Get(HttpContext context) => (WorkspaceScope)context.Items[ItemKey]!;

    public Task<bool> IsCurrent(CanvasDatabase db, CancellationToken ct = default) =>
        LiveBoards(db).AnyAsync(board => board.Id == BoardId && board.LibraryId == LibraryId, ct);

    public static IResult Changed() => Results.Problem(statusCode: 409, title: "画布或素材库归属已经变化，请返回工作空间重新打开。");

    public static void Install(WebApplication app)
    {
        app.Use(async (context, next) =>
        {
            var path = context.Request.Path;
            if (path.StartsWithSegments("/api/v1/assets") || path.StartsWithSegments("/api/v1/media") ||
                path.StartsWithSegments("/api/v1/library") || path.StartsWithSegments("/api/v1/clipboard") ||
                path.StartsWithSegments("/api/v1/exports") || path.StartsWithSegments("/api/v1/events"))
            {
                var id = context.Request.Query.TryGetValue("boardId", out var value) ? value.ToString() : "main";
                var db = context.RequestServices.GetRequiredService<CanvasDatabase>();
                var scope = await LiveBoards(db).AsNoTracking().Where(board => board.Id == id)
                    .Select(board => new WorkspaceScope(board.Id, board.LibraryId)).SingleOrDefaultAsync(context.RequestAborted);
                if (scope == null) { context.Response.StatusCode = 404; return; }
                context.Items[ItemKey] = scope;
            }
            await next();
        });
    }
}
