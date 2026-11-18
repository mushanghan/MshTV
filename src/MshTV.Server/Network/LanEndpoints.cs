using System.Net.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace MshTV.Server.Network;

internal sealed record PairRequest(string? Code, string? Device);

internal static class LanEndpoints
{
    public static void MapLan(this WebApplication app)
    {
        var routes = app.MapGroup("/api/v1/lan");
        routes.MapPost("/pair", (HttpContext context, PairRequest request, AccessSessions sessions) => sessions.Pair(context, request.Code, request.Device));
        routes.MapPost("/logout", (HttpContext context, AccessSessions sessions) => sessions.LogOut(context));
        var local = routes.MapGroup("").AddEndpointFilter((invocation, next) => AccessSessions.DirectLocal(invocation.HttpContext)
            ? next(invocation) : ValueTask.FromResult<object?>(Results.Problem(statusCode: 403, title: "请直接在 Windows 主机上打开 MshTV。")));
        local.MapGet("/status", (LanHost lan, AccessSessions sessions) => Results.Ok(new
        {
            lan.Desired.Enabled, lan.Desired.Address, lan.Desired.Port, lan.ActiveUrl, lan.Error, lan.Accepting,
            restartRequired = lan.Desired.Enabled ? !lan.Accepting : lan.Listening != null,
            fingerprint = lan.Desired.Authority is { } bytes ? Convert.ToHexString(SHA256.HashData(bytes)) : null,
            addresses = LanHost.Addresses(), devices = sessions.Devices(),
        }));
        local.MapPost("/settings", Save);
        local.MapPost("/code", (LanHost host, AccessSessions sessions) => host.Accepting
            ? Results.Ok(sessions.NewCode()) : Results.Problem(statusCode: 409, title: "请先启用局域网并重启后端。"));
        local.MapDelete("/devices/{id}", (string id, AccessSessions sessions) => sessions.Revoke(id));
        local.MapGet("/certificate", (LanHost host) => host.Desired.Authority is { } bytes
            ? Results.File(bytes, "application/pkix-cert", "MshTV-LAN.cer") : Results.NotFound());
        local.MapPost("/test", Test);
    }

    private static IResult Save(LanOptions options, AccessSessions sessions)
    {
        try
        {
            var (changed, error) = sessions.SaveSettings(options);
            if (error != null) return Results.Problem(statusCode: 400, title: error);
            return Results.Ok(new { changed });
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or CryptographicException)
        { return Results.Problem(statusCode: 409, title: "无法保存设置或生成 HTTPS 证书。请检查 Windows 用户配置和数据目录权限。"); }
    }

    private static async Task<IResult> Test(LanHost host, CancellationToken ct)
    {
        if (!host.Accepting || host.ActiveUrl == null || host.Listening?.Authority is not { } raw)
            return Results.Problem(statusCode: 409, title: "HTTPS 监听尚未启用，请检查设置并重启。");
        using var root = X509CertificateLoader.LoadCertificate(raw);
        using var handler = new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false };
        handler.ServerCertificateCustomValidationCallback = (_, certificate, _, errors) =>
        {
            if (certificate == null || (errors & (SslPolicyErrors.RemoteCertificateNameMismatch | SslPolicyErrors.RemoteCertificateNotAvailable)) != 0) return false;
            using var chain = new X509Chain();
            chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
            chain.ChainPolicy.CustomTrustStore.Add(root);
            chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
            return chain.Build(certificate);
        };
        using var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(4) };
        try
        {
            using var response = await client.GetAsync(host.ActiveUrl + "/api/v1/health", ct);
            if (response.IsSuccessStatusCode) return Results.Ok(new { reachable = true });
        }
        catch (Exception e) when (e is HttpRequestException || e is OperationCanceledException && !ct.IsCancellationRequested) { }
        return Results.Problem(statusCode: 503, title: "主机无法通过局域网地址连到 HTTPS。请检查网卡地址、端口和 Windows 防火墙。");
    }
}
