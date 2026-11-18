using Microsoft.EntityFrameworkCore;
using MshTV.Infrastructure;

namespace MshTV.Server.Library;

public sealed record MediaModeSnapshot(bool Enabled, long Revision)
{
    public int AnalysisLimit => Enabled ? 2 : MediaProcessingMode.MaximumAnalysisJobs;
}

public sealed class MediaProcessingMode
{
    public const int MaximumAnalysisJobs = 6;
    private readonly object sync = new();
    private MediaModeSnapshot current = new(false, 1);
    private int active;

    public MediaModeSnapshot Current => Volatile.Read(ref current);

    public void Apply(MediaModeSnapshot next)
    {
        lock (sync) Volatile.Write(ref current, next);
    }

    public bool HasCapacity
    {
        get { lock (sync) return active < current.AnalysisLimit; }
    }

    public bool TryStart()
    {
        lock (sync)
        {
            if (active >= current.AnalysisLimit) return false;
            active++;
            return true;
        }
    }

    public void Finish()
    {
        lock (sync) active--;
    }
}

internal sealed record SetMediaMode(bool? Enabled, long? Revision);

internal static class MediaModeEndpoints
{
    public static void MapMediaMode(this WebApplication app)
    {
        app.MapGet("/api/v1/settings/performance", (MediaProcessingMode mode) => Results.Ok(mode.Current));
        app.MapPut("/api/v1/settings/performance", Update);
    }

    private static async Task<IResult> Update(SetMediaMode request, CanvasDatabase db,
        DatabaseWriteGate gate, MediaProcessingMode mode, CancellationToken ct)
    {
        if (request.Enabled is not bool enabled || request.Revision is not > 0)
            return Results.Problem(statusCode: 400, title: "性能模式设置无效。");

        await gate.Semaphore.WaitAsync(ct);
        try
        {
            var row = await db.PerformanceMode.SingleAsync(ct);
            if (row.Revision != request.Revision)
                return Results.Problem(statusCode: 409, title: "性能模式已在另一个页面修改，请重试。");
            if (row.Enabled != enabled)
            {
                row.Enabled = enabled;
                row.Revision++;
                // Complete persistence and update the running scheduler together even if the browser disconnects.
                await db.SaveChangesAsync(CancellationToken.None);
                mode.Apply(new(row.Enabled, row.Revision));
            }
            return Results.Ok(mode.Current);
        }
        finally { gate.Semaphore.Release(); }
    }
}
