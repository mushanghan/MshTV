using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using MshTV.Infrastructure;

namespace MshTV.Server.Network;

internal sealed record LanConfig(bool Enabled = false, string? Address = null, int Port = 5443, byte[]? Authority = null,
    byte[]? ProtectedKey = null, string? AccessGeneration = null);
internal sealed record LanOptions(bool Enabled, string? Address, int Port, bool RenewCertificate = false);
internal sealed record LanAddress(string Address, string Name, int Prefix);

internal sealed class LanHost(string anchor, int localPort) : IDisposable
{
    private readonly object gate = new();
    private readonly string settings = Path.Combine(anchor, "lan-settings.json");
    private volatile LanConfig desired = new();
    public LanConfig Desired => desired;
    public LanConfig? Listening { get; private set; }
    public X509Certificate2? Certificate { get; private set; }
    public string? Error { get; private set; }
    public bool Accepting => Listening != null && ReferenceEquals(Listening, Desired);
    public string? ActiveUrl => Listening is { } active ? $"https://{active.Address}:{active.Port}" : null;

    public void Load()
    {
        try
        {
            if (!File.Exists(settings)) return;
            using var input = SafeMediaFiles.Open(anchor, Path.GetFileName(settings));
            desired = JsonSerializer.Deserialize<LanConfig>(input) ?? new();
            if (!desired.Enabled) return;
            if (!OperatingSystem.IsWindows() || desired.ProtectedKey == null || desired.Authority == null ||
                !Addresses().Any(ip => ip.Address == desired.Address) || !ValidPort(desired.Port))
            {
                Error = "原网卡地址不可用，请在 Windows 本机重新选择局域网地址。";
                return;
            }
            var ip = IPAddress.Parse(desired.Address!);
            if (!CanBind(ip, desired.Port))
            {
                Error = $"局域网端口 {desired.Port} 被占用或不可监听，请更换端口。本机可继续使用。";
                return;
            }
            Certificate = LanCertificates.Load(desired.ProtectedKey);
            if (Certificate.NotAfter.ToUniversalTime() <= DateTime.UtcNow) { Error = "HTTPS 证书已过期，请更新证书。"; return; }
            Listening = desired;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException or CryptographicException or NetworkInformationException)
        {
            Error = "无法载入局域网设置或 HTTPS 证书。本机仍可使用，请检查设置或更新证书。";
        }
    }

    public (bool Changed, string? Error) Save(LanOptions options)
    {
        lock (gate)
        {
            var config = desired;
            if (!options.Enabled) config = config with { Enabled = false };
            else
            {
                if (!OperatingSystem.IsWindows()) return (false, "请在 Windows 主机上启用局域网。");
                if (!ValidPort(options.Port)) return (false, "请选择 1024–65535 之间、与本机端口不同的端口。");
                if (!Addresses().Any(ip => ip.Address == options.Address)) return (false, "请选择当前 Windows 网卡的私网 IPv4 地址。");
                if ((Listening?.Address != options.Address || Listening?.Port != options.Port) &&
                    !CanBind(IPAddress.Parse(options.Address!), options.Port))
                    return (false, "端口已占用或不可监听，请更换端口。");
                if (config.Authority == null || config.Address != options.Address || options.RenewCertificate)
                {
                    var (authority, key) = LanCertificates.Create(IPAddress.Parse(options.Address!));
                    config = config with { Authority = authority, ProtectedKey = key };
                }
                config = config with { Enabled = true, Address = options.Address, Port = options.Port };
            }
            if (config == desired) return (false, null);
            config = config with { AccessGeneration = Guid.NewGuid().ToString("N") };
            var temp = Path.Combine(anchor, $"lan-{Guid.NewGuid():N}.tmp");
            using (var output = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                SafeMediaFiles.ValidateHandle(anchor, output.SafeFileHandle);
                JsonSerializer.Serialize(output, config);
                output.Flush(flushToDisk: true);
            }
            File.Move(temp, settings, overwrite: true);
            desired = config;
            return (true, null);
        }
    }

    public static IReadOnlyList<LanAddress> Addresses() => NetworkInterface.GetAllNetworkInterfaces()
        .Where(nic => nic.OperationalStatus == OperationalStatus.Up && nic.NetworkInterfaceType != NetworkInterfaceType.Loopback)
        .SelectMany(nic => nic.GetIPProperties().UnicastAddresses
            .Where(ip => ip.PrefixLength is > 0 and <= 30 && IsPrivate(ip.Address))
            .Select(ip => new LanAddress(ip.Address.ToString(), nic.Name, ip.PrefixLength)))
        .DistinctBy(ip => ip.Address).ToList();

    public static bool IsPrivate(IPAddress address)
    {
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        if (address.AddressFamily != AddressFamily.InterNetwork) return false;
        var bytes = address.GetAddressBytes();
        return bytes[0] == 10 || bytes[0] == 172 && bytes[1] is >= 16 and <= 31 || bytes[0] == 192 && bytes[1] == 168;
    }

    private bool ValidPort(int port) => port is >= 1024 and <= 65535 && port != localPort;
    private static bool CanBind(IPAddress address, int port)
    {
        using var probe = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp) { ExclusiveAddressUse = true };
        try { probe.Bind(new IPEndPoint(address, port)); return true; }
        catch (SocketException) { return false; }
    }

    public void Dispose() => Certificate?.Dispose();
}
