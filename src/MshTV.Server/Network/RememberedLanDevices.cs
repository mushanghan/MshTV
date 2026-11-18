using System.Text.Json;
using MshTV.Infrastructure;

namespace MshTV.Server.Network;

internal sealed record RememberedLanDevice(string TokenHash, string Id, string Name, string Address);

internal sealed class RememberedLanDevices(string anchor)
{
    private const string FileName = "lan-devices.json";
    private sealed record DeviceFile(string? Generation, RememberedLanDevice[] Devices);

    public RememberedLanDevice[] Load(string? generation)
    {
        using var input = SafeMediaFiles.Open(anchor, FileName);
        if (input.Length > 64 * 1024) throw new JsonException("Invalid LAN device file size.");
        var file = JsonSerializer.Deserialize<DeviceFile>(input);
        if (file == null || file.Generation != generation) return [];
        if (file.Devices == null || file.Devices.Any(device => device?.TokenHash is not { Length: 64 } ||
                !Guid.TryParse(device.Id, out _) || string.IsNullOrWhiteSpace(device.Name)))
            throw new JsonException("Invalid LAN device record.");
        return file.Devices;
    }

    public void Save(string? generation, RememberedLanDevice[] devices)
    {
        var temp = Path.Combine(anchor, $"lan-devices-{Guid.NewGuid():N}.tmp");
        using (var output = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        {
            SafeMediaFiles.ValidateHandle(anchor, output.SafeFileHandle);
            JsonSerializer.Serialize(output, new DeviceFile(generation, devices));
            output.Flush(flushToDisk: true);
        }
        File.Move(temp, Path.Combine(anchor, FileName), overwrite: true);
    }
}
