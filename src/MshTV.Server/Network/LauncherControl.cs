using System.IO.Pipes;
using System.Text;

namespace MshTV.Server.Network;

internal sealed class LauncherControl(string address, IHostApplicationLifetime lifetime) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!OperatingSystem.IsWindows() || !address.StartsWith("MshTV-", StringComparison.Ordinal) ||
            !Guid.TryParseExact(address.AsSpan(6), "N", out _)) return;
        while (!stoppingToken.IsCancellationRequested)
        {
            using var pipe = new NamedPipeServerStream(address, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
                PipeOptions.CurrentUserOnly | PipeOptions.Asynchronous);
            try
            {
                await pipe.WaitForConnectionAsync(stoppingToken);
                using var window = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
                window.CancelAfter(TimeSpan.FromSeconds(2));
                var command = new byte[1];
                if (await pipe.ReadAsync(command, window.Token) == 0) continue;
                var reply = command[0] switch
                {
                    (byte)'?' => lifetime.ApplicationStarted.IsCancellationRequested ? "ready" : "starting",
                    (byte)'!' => "stopping",
                    _ => "invalid"
                };
                await pipe.WriteAsync(Encoding.ASCII.GetBytes(reply), window.Token);
                await pipe.FlushAsync(window.Token);
                if (command[0] == (byte)'!') { lifetime.StopApplication(); return; }
            }
            catch (IOException) { }
            catch (OperationCanceledException) when (!stoppingToken.IsCancellationRequested) { }
        }
    }
}
