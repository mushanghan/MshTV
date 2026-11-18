namespace MshTV.Launcher;

internal sealed partial class LauncherWindow : Form
{
    private readonly Backend backend = new();
    private readonly NotifyIcon tray;
    private readonly Icon? applicationIcon;
    private readonly Icon trayIcon;
    private readonly System.Windows.Forms.Timer monitor = new() { Interval = 1200 };
    private readonly Label state = Caption("○ 后端已停止", 10);
    private readonly Label network = Caption("未监听", 10);
    private readonly Label detail = Caption("启动后可在默认浏览器中打开工作空间。", 10);
    private readonly Label dataPath = Caption("正在读取…", 9);
    private readonly Label cachePath = Caption("正在读取…", 9);
    private readonly Label used = Caption("检查环境后显示项目与缓存大小", 9);
    private readonly Label media = Caption("正在检测媒体组件…", 9);
    private readonly Button primary = MakeButton("启动 MshTV", ButtonKind.Primary);
    private readonly Button stop = MakeButton("停止服务");
    private readonly Button restart = MakeButton("重启服务");
    private readonly Button lan = MakeButton("局域网与设备");
    private readonly Button storage = MakeButton("备份与迁移");
    private readonly Button clear = MakeButton("清理预览缓存");
    private readonly Button check = MakeButton("检查环境");
    private readonly Button repair = MakeButton("修复运行目录");
    private readonly Button selectMedia = MakeButton("选择 FFmpeg 文件夹");
    private readonly CheckBox closeToTray = new() { Text = "关闭窗口时保留在托盘", AutoSize = true, Checked = true, FlatStyle = FlatStyle.Flat };
    private Preferences preferences = new();
    private string? activeData;
    private bool busy, exiting, initialized, setupExit, detailError;
    private int statusTicks;

    public LauncherWindow()
    {
        SuspendLayout();
        Text = "MshTV 启动管理中心";
        applicationIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        Icon = applicationIcon;
        StartPosition = FormStartPosition.Manual;
        FormBorderStyle = FormBorderStyle.None;
        MaximizeBox = false;
        AutoScaleDimensions = new SizeF(96, 96);
        AutoScaleMode = AutoScaleMode.Dpi;
        ClientSize = new Size(WindowWidth, WindowHeight);
        Font = new("Microsoft YaHei UI", 10);
        BuildLayout();
        ResumeLayout(performLayout: false);

        using var trayResource = typeof(LauncherWindow).Assembly.GetManifestResourceStream("MshTV.Tray.ico")!;
        trayIcon = new Icon(trayResource);
        tray = new NotifyIcon { Icon = trayIcon, Text = "MshTV · 后端已停止", ContextMenuStrip = BuildTrayMenu(), Visible = true };
        tray.DoubleClick += (_, _) => Reveal();
        ApplyTheme();

        primary.Click += (_, _) => OpenOrStart();
        stop.Click += (_, _) => _ = StopWithConfirm(false);
        restart.Click += (_, _) => _ = StopWithConfirm(true);
        lan.Click += (_, _) => Open(Backend.Url + "/?settings=lan");
        storage.Click += (_, _) => Open(Backend.Url + "/?settings=storage");
        clear.Click += (_, _) => _ = Clear();
        check.Click += (_, _) => _ = Run(Check);
        repair.Click += (_, _) => _ = Run(Repair);
        selectMedia.Click += (_, _) => _ = SelectMedia();
        closeToTray.CheckedChanged += (_, _) =>
        {
            if (!initialized) return;
            Try(() =>
            {
                var changed = preferences with { CloseToTray = closeToTray.Checked };
                Installation.SavePreferences(changed);
                preferences = changed;
            });
        };

        Shown += (_, _) => _ = Run(Initialize);
        FormClosing += (_, e) =>
        {
            if (exiting) return;
            if (e.CloseReason == CloseReason.WindowsShutDown) return;
            e.Cancel = true;
            if (preferences.CloseToTray) Hide();
            else _ = Exit(confirm: true);
        };
        monitor.Tick += (_, _) =>
        {
            if (busy) return;
            var ready = backend.Ready;
            backend.ObserveExit();
            if (ready && !backend.Ready)
            {
                SetDetail("后端已停止。可以再次启动。");
                network.Text = "未监听";
            }
            UpdateButtons();
            if (backend.Ready && ++statusTicks % 8 == 0) _ = Run(RefreshNetwork, updateButtons: false);
        };
        monitor.Start();
        UpdateButtons();
    }

    private async Task Initialize()
    {
        try { preferences = await Task.Run(Installation.LoadPreferences); }
        finally
        {
            closeToTray.Checked = preferences.CloseToTray;
            initialized = true;
            ApplyTheme();
        }
        await RefreshStorage();
        await RefreshMedia();
    }

    public void Reveal()
    {
        Show();
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Activate();
    }

    public void ExitForSetup()
    {
        if (busy) setupExit = true;
        else _ = Exit(confirm: false);
    }

    private void OpenOrStart()
    {
        if (backend.Ready) Open(Backend.Url);
        else _ = Run(() => Start(true));
    }

    private async Task Start(bool openBrowser, bool refreshUsage = true)
    {
        SetDetail("正在检查运行环境");
        await Task.Run(Installation.VerifyPayload);
        SetDetail("正在检查项目数据");
        SetPaths(await Task.Run(() => Installation.CheckStorage(true)));
        var mediaDirectory = await RefreshMedia();
        await backend.Start(message => { SetDetail(message); return Task.CompletedTask; }, mediaDirectory);
        if (openBrowser)
        {
            SetDetail("后端已就绪，正在打开浏览器");
            Open(Backend.Url);
        }
        SetDetail("后端已就绪。关闭浏览器后，后台监控会继续运行。");
        await RefreshStorage();
        await RefreshNetwork();
        if (refreshUsage) _ = LoadUsage();
    }

    private async Task Check()
    {
        SetDetail("正在校验安装文件与项目数据");
        await Task.Run(Installation.VerifyPayload);
        _ = await Task.Run(Installation.LoadPreferences);
        SetPaths(await Task.Run(() => Installation.CheckStorage(true)));
        await RefreshMedia();
        if (!backend.Running) await Start(openBrowser: false, refreshUsage: false);
        var result = await backend.CheckData();
        if (!result.Sqlite) throw new IOException("数据库完整性检查失败。请保留数据并从备份恢复。");
        ShowUsage(result);
        SetDetail($"检查通过。后端已就绪，{result.Boards} 张画布，{result.Missing} 份缺失素材，{result.Offline} 个离线目录，{result.Broken} 个断开引用。");
    }

    private async Task Repair()
    {
        await Task.Run(Installation.RepairDirectories);
        await RefreshStorage();
        SetDetail("运行目录已检查。缺失的预览缓存目录已补建。安装文件损坏时可用安装包重装修复。");
    }

    private async Task Clear()
    {
        if (MessageBox.Show(this, "清理图片缩略图、视频封面和音频波形。之后会按需重新生成。项目和原始素材会保留。",
                "清理预览缓存", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) != DialogResult.OK) return;
        await Run(async () =>
        {
            var result = await backend.ClearCache();
            SetDetail($"已清理 {result.Removed} 个缓存文件，{result.Skipped} 个暂无法清理。");
            await LoadUsage();
        });
    }

    private async Task SelectMedia()
    {
        using var dialog = new FolderBrowserDialog { Description = "选择同时包含 ffmpeg.exe 和 ffprobe.exe 的文件夹", UseDescriptionForTitle = true };
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        await Run(async () =>
        {
            var changed = preferences with { MediaDirectory = dialog.SelectedPath };
            if (await Task.Run(() => Installation.MediaDirectory(changed)) == null)
                throw new IOException("版本或校验值不匹配。请选择本版本支持的 FFmpeg 文件夹。");
            Installation.SavePreferences(changed);
            preferences = changed;
            await RefreshMedia();
            SetDetail(backend.Ready ? "媒体组件已设置，重启后端后生效。" : "媒体组件已设置，下次启动时生效。");
        });
    }

    private async Task StopWithConfirm(bool startAgain)
    {
        if (busy || !ConfirmStop(startAgain ? "重启 MshTV" : "停止服务")) return;
        await Run(async () =>
        {
            SetDetail("正在等待后端停止");
            await backend.Stop();
            network.Text = "未监听";
            if (startAgain) await Start(false);
            else SetDetail("后端已停止。");
        });
    }

    private bool ConfirmStop(string title) => !backend.Running || MessageBox.Show(this,
        "请先保存所有设备上打开的画布。停止后，素材监控和局域网连接会暂停。",
        title, MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) == DialogResult.OK;

    private async Task Exit(bool confirm)
    {
        if (busy || (confirm && !ConfirmStop("完全退出 MshTV"))) return;
        await Run(async () => { await backend.Stop(); exiting = true; Close(); });
    }

    private async Task RefreshNetwork()
    {
        var status = await backend.GetNetwork();
        network.Text = status.Accepting ? status.ActiveUrl :
            status.Enabled ? status.Error ?? "已启用，等待监听" : "已关闭";
        hints.SetToolTip(network, network.Text);
    }

    private async Task RefreshStorage() => SetPaths(await Task.Run(() => Installation.CurrentDirectory(Installation.Anchor)));

    private void SetPaths(string path)
    {
        activeData = path;
        dataPath.Text = path;
        cachePath.Text = Path.Combine(path, "media-cache");
        hints.SetToolTip(dataPath, dataPath.Text);
        hints.SetToolTip(cachePath, cachePath.Text);
    }

    private async Task<string?> RefreshMedia()
    {
        var path = await Task.Run(() => Installation.MediaDirectory(preferences));
        media.Text = path == null ? "FFmpeg 未就绪 · 视频封面、波形和部分缩略图需要配置此组件" : "FFmpeg / ffprobe 校验通过";
        return path;
    }

    private async Task LoadUsage()
    {
        try { ShowUsage(await backend.CheckData()); }
        catch (Exception e) when (Installation.Expected(e) || e is OperationCanceledException) { }
    }

    private void ShowUsage(StorageCheck result)
    {
        var s = result.Space;
        used.Text = $"应用数据 {SizeText(s.Database + s.Imports + s.Backups)}  ·  缓存 {SizeText(s.Cache)}";
    }

    private static string SizeText(long bytes) => bytes >= 1L << 30 ? $"{bytes / (double)(1L << 30):0.##} GB" : $"{bytes / (double)(1L << 20):0.##} MB";

    private async Task Run(Func<Task> action, bool updateButtons = true)
    {
        if (busy) return;
        busy = true;
        if (updateButtons) UpdateButtons();
        try { await action(); }
        catch (Exception e) when (Installation.Expected(e) || e is OperationCanceledException)
        {
            SetDetail(e is OperationCanceledException ? "等待操作超时，请检查后端或稍后重试。" : e.Message, true);
        }
        finally
        {
            busy = false;
            if (!IsDisposed)
            {
                UpdateButtons();
                if (setupExit) { setupExit = false; ExitForSetup(); }
            }
        }
    }

    private void UpdateButtons()
    {
        var running = backend.Running;
        var ready = backend.Ready && running;
        var label = ready ? "后端已就绪" : running ? "后端进程运行中" : "后端已停止";
        state.Text = (ready ? "● " : "○ ") + label;
        state.ForeColor = ready ? palette.Accent : palette.Muted;
        primary.Text = ready ? "打开工作空间" : "启动 MshTV";
        primary.Enabled = !busy && (!running || ready);
        stop.Enabled = !busy && running;
        restart.Enabled = !busy && ready;
        lan.Enabled = storage.Enabled = clear.Enabled = !busy && ready;
        check.Enabled = repair.Enabled = selectMedia.Enabled = closeToTray.Enabled = !busy;
        themeToggle.Enabled = initialized && !busy;
        UpdateTray(label, running, ready);
    }

    private void SetDetail(string text, bool error = false)
    {
        detail.Text = text;
        detailError = error;
        detail.ForeColor = error ? palette.Warning : palette.Muted;
        hints.SetToolTip(detail, text);
    }

    private void Open(string target) => Try(() => Installation.Open(target));
    private void Try(Action action)
    {
        try { action(); }
        catch (Exception e) when (Installation.Expected(e)) { SetDetail(e.Message, true); }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            monitor.Dispose();
            tray.Visible = false;
            tray.ContextMenuStrip?.Dispose();
            tray.Dispose();
            trayIcon.Dispose();
            hints.Dispose();
            backend.Dispose();
        }
        base.Dispose(disposing);
        if (disposing) applicationIcon?.Dispose();
    }
}
