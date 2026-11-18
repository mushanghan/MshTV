using System.Security.Cryptography;
using System.Text;
using MshTV.Launcher;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        var identity = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(AppContext.BaseDirectory.ToUpperInvariant())))[..24];
        var name = "Local\\MshTV.Launcher." + identity;
        using var show = new EventWaitHandle(false, EventResetMode.AutoReset, name + ".show");
        using var exit = new EventWaitHandle(false, EventResetMode.AutoReset, name + ".exit");
        using var instance = new Mutex(false, name);
        if (args is ["--close-for-setup"])
        {
            if (!Acquire(instance, 0))
            {
                exit.Set();
                if (!Acquire(instance, 25000)) return 2;
            }
            instance.ReleaseMutex();
            return 0;
        }
        if (args is ["--configure-data", var anchor])
        {
            try { Installation.Configure(anchor); return 0; }
            catch (Exception e) when (Installation.Expected(e)) { return 3; }
        }
        if (args is ["--self-check"])
        {
            try { Installation.VerifyPayload(); Installation.CheckStorage(); }
            catch (Exception e) when (Installation.Expected(e)) { return 4; }
            try { Backend.CheckPort(); return 0; }
            catch (IOException) { return 5; }
        }
        if (!Acquire(instance, 0)) { show.Set(); return 0; }
        try
        {
            ApplicationConfiguration.Initialize();
            using var window = new LauncherWindow();
            _ = window.Handle;
            var openListener = ThreadPool.RegisterWaitForSingleObject(show, (_, _) => Signal(window, window.Reveal), null, -1, false);
            var exitListener = ThreadPool.RegisterWaitForSingleObject(exit, (_, _) => Signal(window, () => window.ExitForSetup()), null, -1, false);
            try { Application.Run(window); }
            finally { openListener.Unregister(null); exitListener.Unregister(null); }
            return 0;
        }
        finally { instance.ReleaseMutex(); }
    }

    private static bool Acquire(Mutex mutex, int milliseconds)
    {
        try { return mutex.WaitOne(milliseconds); }
        catch (AbandonedMutexException) { return true; }
    }

    private static void Signal(Form window, Action action)
    {
        try { window.BeginInvoke(action); }
        catch (InvalidOperationException) { }
    }
}
