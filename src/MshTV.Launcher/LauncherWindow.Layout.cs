using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using MshTV.Infrastructure;

namespace MshTV.Launcher;

internal sealed partial class LauncherWindow
{
    private const int WindowWidth = 880;
    private const int WindowHeight = 550;
    private const int BodyWidth = 832;
    private const int BodyHeight = 402;
    private readonly ToolTip hints = new();
    private readonly Panel header = new() { Dock = DockStyle.Top, Width = WindowWidth, Height = 58 };
    private readonly Panel footer = new() { Dock = DockStyle.Bottom, Width = WindowWidth, Height = 58 };
    private readonly LauncherButton themeToggle = MakeButton("", ButtonKind.Theme);

    private void BuildLayout()
    {
        SuspendLayout();
        var viewport = new Panel { Dock = DockStyle.Fill, AutoScroll = true };
        var body = new Panel { Size = new Size(BodyWidth, BodyHeight), Location = new Point(24, 16) };
        viewport.Controls.Add(body);
        Controls.AddRange([viewport, footer, header]);

        var mark = new PictureBox { Image = applicationIcon?.ToBitmap(), SizeMode = PictureBoxSizeMode.Zoom };
        mark.Disposed += (_, _) => mark.Image?.Dispose();
        Place(header, mark, 24, 14, 31, 31);
        var wordmark = Caption("MshTV", 17, true);
        Place(header, wordmark, 66, 11, 100, 35);
        foreach (var surface in new Control[] { header, mark, wordmark }) surface.MouseDown += MoveWindow;

        var overviewTab = MakeButton("总览", ButtonKind.Tab);
        var maintenanceTab = MakeButton("维护", ButtonKind.Tab);
        Place(header, overviewTab, 186, 13, 74, 32);
        Place(header, maintenanceTab, 268, 13, 74, 32);
        themeToggle.Click += (_, _) => ToggleTheme();
        Place(header, themeToggle, 674, 12, 92, 34);
        var minimize = ChromeButton("—", "最小化", () => WindowState = FormWindowState.Minimized);
        var close = ChromeButton("×", "关闭窗口", Close);
        Place(header, minimize, 780, 12, 36, 34);
        Place(header, close, 822, 12, 36, 34);
        themeToggle.Anchor = minimize.Anchor = close.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        header.Paint += (_, e) => DrawRule(e.Graphics, new Rectangle(0, header.Height - 1, header.Width, 1));

        var overview = new Panel { Dock = DockStyle.Fill };
        var maintenance = new Panel { Dock = DockStyle.Fill, Visible = false };
        body.Controls.AddRange([overview, maintenance]);
        BuildOverview(overview);
        BuildMaintenance(maintenance);
        void Navigate(bool showMaintenance)
        {
            overview.Visible = !showMaintenance;
            maintenance.Visible = showMaintenance;
            overviewTab.SelectTab(!showMaintenance);
            maintenanceTab.SelectTab(showMaintenance);
            viewport.AutoScrollPosition = Point.Empty;
        }
        overviewTab.Click += (_, _) => Navigate(false);
        maintenanceTab.Click += (_, _) => Navigate(true);
        Navigate(false);

        Place(footer, detail, 24, 8, 735, 42);
        detail.Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top;
        var version = MutedCaption("v" + Installation.Version, 9);
        version.TextAlign = ContentAlignment.MiddleRight;
        Place(footer, version, 766, 8, 90, 42);
        version.Anchor = AnchorStyles.Right | AnchorStyles.Top;
        footer.Paint += (_, e) => DrawRule(e.Graphics, new Rectangle(0, 0, footer.Width, 1));
        ResumeLayout();
    }

    private void BuildOverview(Panel overview)
    {
        var hero = Card(overview, 0, 0, 522, BodyHeight);
        hero.Paint += PaintCanvasMotif;
        state.TextAlign = ContentAlignment.MiddleCenter;
        Place(hero, state, 28, 27, 152, 32);
        Place(hero, Caption("工作空间", 29, true), 27, 100, 275, 62);
        Place(hero, MutedCaption("在浏览器中管理画布和素材。", 10), 29, 175, 240, 48);
        Place(hero, primary, 28, 238, 202, 52);
        Place(hero, stop, 28, 336, 97, 37);
        Place(hero, restart, 135, 336, 97, 37);
        hero.Paint += (_, e) => DrawRule(e.Graphics, Rectangle.FromLTRB(
            hero.LogicalToDeviceUnits(28), hero.LogicalToDeviceUnits(316),
            hero.Width - hero.LogicalToDeviceUnits(28), hero.LogicalToDeviceUnits(316) + 1));

        var links = Card(overview, 538, 0, 294, 248);
        Place(links, Caption("连接", 16, true), 22, 16, 230, 38);
        Place(links, MutedCaption("本机", 9), 22, 65, 230, 23);
        Place(links, Caption(Backend.Url, 11), 22, 87, 250, 30);
        Place(links, MutedCaption("局域网", 9), 22, 126, 230, 23);
        Place(links, network, 22, 149, 250, 34);
        Place(links, lan, 22, 194, 133, 34);

        var codecs = Card(overview, 538, 264, 294, 138);
        Place(codecs, Caption("媒体组件", 14, true), 22, 14, 230, 38);
        Place(codecs, media, 22, 54, 250, 61);
    }

    private void BuildMaintenance(Panel maintenance)
    {
        var disks = Card(maintenance, 0, 0, 522, BodyHeight);
        Place(disks, Caption("存储", 17, true), 24, 16, 450, 38);
        var installPath = MutedCaption(Installation.Root, 9);
        PathRow(disks, 70, "安装目录", installPath, () => Installation.Root);
        PathRow(disks, 144, "项目数据", dataPath, () => activeData);
        PathRow(disks, 218, "预览缓存", cachePath, () => activeData == null ? null : Path.Combine(activeData, "media-cache"));
        Place(disks, used, 24, 294, 460, 26);
        Place(disks, storage, 24, 342, 141, 36);
        Place(disks, clear, 175, 342, 141, 36);

        var tools = Card(maintenance, 538, 0, 294, 253);
        Place(tools, Caption("环境工具", 16, true), 22, 16, 250, 38);
        Place(tools, check, 22, 68, 250, 37);
        Place(tools, repair, 22, 118, 250, 37);
        Place(tools, selectMedia, 22, 168, 250, 37);

        var settings = Card(maintenance, 538, 269, 294, 133);
        Place(settings, Caption("窗口行为", 14, true), 22, 15, 250, 37);
        closeToTray.AutoSize = false;
        Place(settings, closeToTray, 22, 60, 250, 35);
    }

    private void PathRow(Panel parent, int top, string name, Label path, Func<string?> directory)
    {
        Place(parent, Caption(name, 10, true), 24, top, 360, 27);
        Place(parent, path, 24, top + 27, 377, 30);
        hints.SetToolTip(path, path.Text);
        var open = MakeButton("打开");
        open.AccessibleName = "打开" + name;
        open.Click += (_, _) =>
        {
            if (directory() is not { } dir || !Directory.Exists(dir)) { SetDetail("该目录将在初次使用时建立。"); return; }
            Try(() => { SafeMediaFiles.CheckComponents(dir); Installation.Open(dir); });
        };
        Place(parent, open, 428, top + 13, 68, 33);
    }

    private Panel Card(Control parent, int x, int y, int width, int height)
    {
        var card = new LauncherCard();
        cards.Add(card);
        card.Paint += (_, e) =>
        {
            var bounds = new Rectangle(0, 0, card.Width - 1, card.Height - 1);
            var corner = card.LogicalToDeviceUnits(11);
            e.Graphics.Clear(palette.Background);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using var fill = new SolidBrush(palette.Card);
            using var pen = new Pen(palette.Border);
            e.Graphics.FillRoundedRectangle(fill, bounds, new Size(corner, corner));
            e.Graphics.DrawRoundedRectangle(pen, bounds, new Size(corner, corner));
        };
        Place(parent, card, x, y, width, height);
        return card;
    }

    private void PaintCanvasMotif(object? sender, PaintEventArgs e)
    {
        if (sender is not Panel panel) return;
        var graphics = e.Graphics;
        var saved = graphics.Save();
        var scale = panel.DeviceDpi / 96f;
        graphics.ScaleTransform(scale, scale);
        graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using var grid = new SolidBrush(palette.Border);
        for (var y = 72; y < 292; y += 15)
            for (var x = 301; x < 490; x += 15)
                graphics.FillEllipse(grid, x, y, 2, 2);
        using var secondary = new SolidBrush(palette.Control);
        using var front = new SolidBrush(palette.Card);
        using var stroke = new Pen(palette.Accent);
        using var soft = new Pen(palette.Border);
        var corner = new Size(11, 11);
        Rectangle[] behind = [new(326, 92, 84, 63), new(392, 210, 75, 58)];
        foreach (var card in behind)
        {
            graphics.FillRoundedRectangle(secondary, card, corner);
            graphics.DrawRoundedRectangle(soft, card, corner);
        }
        var focused = new Rectangle(351, 126, 126, 92);
        graphics.FillRoundedRectangle(front, focused, corner);
        graphics.DrawRoundedRectangle(soft, focused, corner);
        graphics.DrawLine(soft, 365, 149, 463, 149);
        graphics.DrawLines(stroke, [new Point(367, 193), new(394, 169), new(415, 185), new(434, 163), new(459, 194)]);
        graphics.Restore(saved);
    }

    private LauncherButton ChromeButton(string glyph, string name, Action action)
    {
        var button = MakeButton(glyph, ButtonKind.Chrome);
        button.Font = new Font("Segoe UI", 15);
        button.AccessibleName = name;
        hints.SetToolTip(button, name);
        button.Click += (_, _) => action();
        return button;
    }

    private static void Place(Control parent, Control item, int x, int y, int width, int height)
    {
        item.Bounds = new Rectangle(x, y, width, height);
        parent.Controls.Add(item);
    }

    private void DrawRule(Graphics graphics, Rectangle bounds)
    {
        using var fill = new SolidBrush(palette.Border);
        graphics.FillRectangle(fill, bounds);
    }

    private static Label Caption(string text, float size, bool bold = false) => new()
    {
        Text = text, BackColor = Color.Transparent, TextAlign = ContentAlignment.MiddleLeft,
        AutoEllipsis = true, Font = new("Microsoft YaHei UI", size, bold ? FontStyle.Bold : FontStyle.Regular),
    };

    private static LauncherButton MakeButton(string text, ButtonKind kind = ButtonKind.Standard) =>
        new(kind)
        {
            Text = text, FlatStyle = FlatStyle.Flat, Cursor = Cursors.Hand,
            Font = new("Microsoft YaHei UI", kind == ButtonKind.Primary ? 13 : kind == ButtonKind.Theme ? 10 : 9,
                kind == ButtonKind.Primary ? FontStyle.Bold : FontStyle.Regular),
        };

    protected override void OnLoad(EventArgs e)
    {
        PerformAutoScale();
        FitWindow(Screen.FromPoint(Cursor.Position).WorkingArea, center: true);
        base.OnLoad(e);
    }

    protected override void OnDpiChanged(DpiChangedEventArgs e)
    {
        base.OnDpiChanged(e);
        if (WindowState == FormWindowState.Normal) FitWindow(Screen.FromRectangle(e.SuggestedRectangle).WorkingArea, center: false);
    }

    private void FitWindow(Rectangle area, bool center)
    {
        // Clamp to whole 16:10 units so rounding and display changes keep the aspect ratio.
        var unit = Math.Min(LogicalToDeviceUnits(WindowWidth / 16), Math.Min((area.Width - 16) / 16, (area.Height - 16) / 10));
        ClientSize = new Size(unit * 16, unit * 10);
        Location = center ? new(area.Left + (area.Width - Width) / 2, area.Top + (area.Height - Height) / 2) :
            new(Math.Clamp(Left, area.Left, area.Right - Width), Math.Clamp(Top, area.Top, area.Bottom - Height));
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        if (OperatingSystem.IsWindowsVersionAtLeast(10, 0, 22000))
        {
            const int cornerPreference = 33;
            var rounded = 2;
            _ = DwmSetWindowAttribute(Handle, cornerPreference, ref rounded, sizeof(int));
        }
    }

    private void MoveWindow(object? sender, MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Left) return;
        var point = Cursor.Position;
        var screenPoint = ((point.Y & 0xffff) << 16) | (point.X & 0xffff);
        _ = ReleaseCapture();
        _ = SendMessage(Handle, 0x00A1, 2, screenPoint); // WM_NCLBUTTONDOWN, HTCAPTION
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll", EntryPoint = "SendMessageW")]
    private static extern nint SendMessage(nint window, uint message, nint wParam, nint lParam);

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(nint window, int attribute, ref int value, int size);
}
