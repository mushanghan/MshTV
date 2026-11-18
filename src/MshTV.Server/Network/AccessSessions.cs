using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace MshTV.Server.Network;

internal sealed class AccessSessions(LanHost host, RememberedLanDevices remembered)
{
    private const string LocalCookie = "mshtv-session";
    private const string RemoteCookie = "__Host-mshtv-lan";
    private const int MaxDevices = 32;
    private static readonly TimeSpan RememberFor = TimeSpan.FromDays(365);
    private readonly ConcurrentDictionary<string, Session> sessions = new();
    private readonly object pairGate = new();
    private string? code;
    private DateTimeOffset codeExpires;
    private int attempts;

    private sealed record Session(string Id, DateTimeOffset? Expires, bool Remote, string Name, string Address)
    {
        private readonly CancellationTokenSource revoked = new();
        public CancellationToken Revoked => revoked.Token;
        public bool Valid => !Revoked.IsCancellationRequested && (Expires == null || Expires > DateTimeOffset.UtcNow);
        public void Revoke() => revoked.Cancel();
    }

    public void Load(ILogger logger)
    {
        if (!host.Desired.Enabled) return;
        try
        {
            foreach (var device in remembered.Load(host.Desired.AccessGeneration).Take(MaxDevices))
                sessions[device.TokenHash] = new(device.Id, null, true, device.Name, device.Address);
        }
        catch (FileNotFoundException) { }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException)
        { logger.LogWarning("无法载入已记住的局域网设备，需要重新配对。"); }
    }

    internal static bool IsRemote(HttpContext context) => context.Request.IsHttps;
    internal static bool DirectLocal(HttpContext context) => !IsRemote(context) &&
        context.Connection.RemoteIpAddress is { } remote && IPAddress.IsLoopback(remote) &&
        context.Request.Host.Port == context.Connection.LocalPort &&
        !context.Request.Headers.Keys.Any(key => key.Equals("Forwarded", StringComparison.OrdinalIgnoreCase) ||
            key.Equals("Via", StringComparison.OrdinalIgnoreCase) || key.Equals("X-Real-IP", StringComparison.OrdinalIgnoreCase) ||
            key.StartsWith("X-Forwarded-", StringComparison.OrdinalIgnoreCase));

    public async Task Enforce(HttpContext context, RequestDelegate next)
    {
        var request = context.Request;
        var path = request.Path;
        var remote = IsRemote(context);
        if (remote)
        {
            var active = host.Listening;
            if (!host.Accepting || active == null || context.Connection.LocalPort != active.Port ||
                context.Connection.RemoteIpAddress is not { } client || !LanHost.IsPrivate(client) ||
                request.Host.Host != active.Address || request.Host.Port != active.Port)
            { context.Response.StatusCode = 403; return; }
        }
        else if (context.Connection.RemoteIpAddress is not { } client || !IPAddress.IsLoopback(client) ||
            !(request.Host.Host == "127.0.0.1" || request.Host.Host == "[::1]" || request.Host.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase)))
        { context.Response.StatusCode = 403; return; }

        context.Response.Headers["X-Content-Type-Options"] = "nosniff";
        context.Response.Headers["Referrer-Policy"] = "same-origin";
        context.Response.Headers["X-Frame-Options"] = "DENY";
        if (!path.StartsWithSegments("/api")) { await next(context); return; }
        context.Response.Headers.CacheControl = "no-store";
        var write = request.Method is not ("GET" or "HEAD");
        var eventStream = path.StartsWithSegments("/api/v1/events");
        var origin = request.Headers.Origin.ToString();
        var expected = $"{request.Scheme}://{request.Host}";
        if ((write || eventStream && (remote || origin.Length > 0)) && origin != expected)
        { await OnError(context, 403, "请求来源无效。"); return; }

        if (path == "/api/v1/health" || path == "/api/v1/session" || path == "/api/v1/lan/pair")
        { await next(context); return; }
        var session = Find(context, out var token);
        if (session == null)
        { await OnError(context, 401, remote ? "设备尚未配对或会话已过期。" : "本机会话已过期。"); return; }
        if (write && request.Headers["X-CSRF-Token"] != Csrf(token!))
        { await OnError(context, 403, "缺少安全令牌。"); return; }
        if (remote && (path.StartsWithSegments("/api/v1/storage") || path.StartsWithSegments("/api/v1/exports") ||
            path.StartsWithSegments("/api/v1/system") || path.StartsWithSegments("/api/v1/clipboard") ||
            path.StartsWithSegments("/api/v1/lan") && path != "/api/v1/lan/logout" ||
            write && (path.StartsWithSegments("/api/v1/library/roots") || path.StartsWithSegments("/api/v1/settings"))))
        { await OnError(context, 403, "这项操作请在 Windows 主机本机完成。"); return; }
        if (!remote || path == "/api/v1/lan/logout") { await next(context); return; }
        // Cancel already authorized requests, including WebSockets and media streams, on revocation.
        using var registration = session.Revoked.Register(context.Abort);
        await next(context);
    }

    public IResult Bootstrap(HttpContext context)
    {
        if (context.Request.Headers["X-MshTV-Bootstrap"] != "1") return Results.StatusCode(403);
        var session = Find(context, out var token);
        if (session != null)
        {
            if (session.Remote) SetCookie(context, true, token!, RememberFor);
            return Results.Ok(new { csrf = Csrf(token!) });
        }
        if (IsRemote(context)) return Results.Problem(statusCode: 401, title: "请输入 Windows 主机显示的配对码。");
        Prune();
        var localToken = Secret();
        var duration = TimeSpan.FromDays(1);
        sessions[localToken] = new("", DateTimeOffset.UtcNow.Add(duration), false, "", "");
        SetCookie(context, false, localToken, duration);
        return Results.Ok(new { csrf = Csrf(localToken) });
    }

    public object NewCode()
    {
        lock (pairGate)
        {
            code = RandomNumberGenerator.GetInt32(10000000, 100000000).ToString(System.Globalization.CultureInfo.InvariantCulture);
            codeExpires = DateTimeOffset.UtcNow.AddMinutes(5);
            attempts = 0;
            return new { code, expires = codeExpires };
        }
    }

    public IResult Pair(HttpContext context, string? entered, string? device)
    {
        if (!IsRemote(context)) return Results.NotFound();
        lock (pairGate)
        {
            if (!host.Accepting || code == null || codeExpires <= DateTimeOffset.UtcNow)
                return Results.Problem(statusCode: 401, title: "配对码已用过或已过期，请在主机生成新的配对码。");
            if (attempts >= 8) return Results.Problem(statusCode: 429, title: "尝试次数过多，请在主机生成新的配对码。");
            attempts++;
            if (entered is not { Length: 8 } || !CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(entered), Encoding.UTF8.GetBytes(code)))
                return Results.Problem(statusCode: 401, title: "配对码不正确。");
            var devices = Snapshot();
            if (devices.Length >= MaxDevices)
                return Results.Problem(statusCode: 409, title: "配对设备已达上限，请先在主机撤销一个旧设备。");
            var name = device?.Trim();
            if (name is not { Length: > 0 and <= 60 } || name.Any(char.IsControl))
                return Results.Problem(statusCode: 400, title: "请输入 1–60 个字符的设备名称。");
            var token = Secret();
            var deviceRecord = new RememberedLanDevice(TokenHash(token), Guid.NewGuid().ToString(), name,
                context.Connection.RemoteIpAddress?.ToString() ?? "");
            try { remembered.Save(host.Desired.AccessGeneration, [.. devices, deviceRecord]); }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return StorageError(); }
            sessions[deviceRecord.TokenHash] = new(deviceRecord.Id, null, true, name, deviceRecord.Address);
            code = null;
            SetCookie(context, true, token, RememberFor);
            return Results.Ok(new { csrf = Csrf(token) });
        }
    }

    public IResult LogOut(HttpContext context)
    {
        if (!IsRemote(context) || Find(context, out _) is not { } session) return Results.NotFound();
        return RemoveDevice(session.Id, () =>
        {
            context.Response.Cookies.Delete(RemoteCookie, Options(true));
            return Results.Ok(new { loggedOut = true });
        });
    }

    public IEnumerable<object> Devices() => sessions.Values.Where(s => s.Remote && s.Valid)
        .Select(s => new { s.Id, s.Name, s.Address });

    public IResult Revoke(string id) => RemoveDevice(id, () => Results.Ok(new { revoked = true }));

    private IResult RemoveDevice(string id, Func<IResult> success)
    {
        lock (pairGate)
        {
            var devices = Snapshot();
            var device = devices.FirstOrDefault(s => s.Id == id);
            if (device == null) return Results.NotFound();
            try { remembered.Save(host.Desired.AccessGeneration, devices.Where(s => s.Id != id).ToArray()); }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return StorageError(); }
            if (sessions.TryRemove(device.TokenHash, out var removed)) removed.Revoke();
            return success();
        }
    }

    public (bool Changed, string? Error) SaveSettings(LanOptions options)
    {
        lock (pairGate)
        {
            var result = host.Save(options);
            if (!result.Changed) return result;
            code = null;
            // The newly committed settings generation also invalidates the disk snapshot after restart.
            foreach (var pair in sessions)
                if (pair.Value.Remote && sessions.TryRemove(pair.Key, out var removed)) removed.Revoke();
            return result;
        }
    }

    private RememberedLanDevice[] Snapshot() => sessions.Where(pair => pair.Value.Remote)
        .Select(pair => new RememberedLanDevice(pair.Key, pair.Value.Id, pair.Value.Name, pair.Value.Address)).ToArray();

    private static void SetCookie(HttpContext context, bool remote, string token, TimeSpan duration)
    {
        var options = Options(remote);
        options.MaxAge = duration;
        context.Response.Cookies.Append(remote ? RemoteCookie : LocalCookie, token, options);
    }

    private Session? Find(HttpContext context, out string? token)
    {
        var remote = IsRemote(context);
        token = context.Request.Cookies[remote ? RemoteCookie : LocalCookie];
        return token is { Length: 64 } && sessions.TryGetValue(remote ? TokenHash(token) : token, out var s) &&
            s.Remote == remote && s.Valid ? s : null;
    }

    private void Prune()
    {
        foreach (var pair in sessions)
            if (!pair.Value.Valid && sessions.TryRemove(pair.Key, out var removed)) removed.Revoke();
    }

    private static CookieOptions Options(bool remote) => new()
    {
        HttpOnly = true, Secure = remote, SameSite = SameSiteMode.Strict, Path = "/", IsEssential = true,
    };
    private static string Secret() => Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
    private static string TokenHash(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));
    // The persisted hash cannot be used as a cookie or used to reconstruct a CSRF token.
    private static string Csrf(string token) => TokenHash("csrf:" + token);
    private static IResult StorageError() => Results.Problem(statusCode: 409,
        title: "无法保存局域网设备记录，请检查 Windows 主机的数据目录后重试。");
    private static Task OnError(HttpContext context, int status, string title) => Results.Problem(statusCode: status, title: title).ExecuteAsync(context);
}
