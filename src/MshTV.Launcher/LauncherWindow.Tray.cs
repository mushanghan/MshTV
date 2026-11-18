using System.Drawing.Drawing2D;

namespace MshTV.Launcher;

internal sealed partial class LauncherWindow
{
    private readonly ToolStripLabel trayStatus = new() { Padding = new Padding(12, 1, 12, 5) };
    private readonly ToolStripMenuItem trayOpen = TrayAction("启动 MshTV");
    private readonly ToolStripMenuItem trayStop = TrayAction("停止服务");
    private readonly ToolStripMenuItem trayRestart = TrayAction("重启服务");
    private readonly ToolStripMenuItem trayExit = TrayAction("退出 MshTV");
    private readonly ToolStripSeparator trayServiceRule = new();
    private readonly bool trayHighContrast = SystemInformation.HighContrast;

    private ContextMenuStrip BuildTrayMenu()
    {
        var menu = new ContextMenuStrip
        {
            AccessibleName = "MshTV 托盘菜单",
            Font = Font,
            MinimumSize = new Size(220, 0),
            Padding = new Padding(6, 6, 6, 6),
            ShowImageMargin = false,
            Renderer = trayHighContrast ? new ToolStripSystemRenderer() : new TrayMenuRenderer(this),
        };

        var titleFont = new Font(Font, FontStyle.Bold);
        var title = new ToolStripLabel("MshTV") { Font = titleFont, Padding = new Padding(12, 5, 12, 0) };
        menu.Disposed += (_, _) => titleFont.Dispose();
        var manager = TrayAction("打开启动管理中心");
        manager.Click += (_, _) => Reveal();
        trayOpen.Click += (_, _) => OpenOrStart();
        trayStop.Click += (_, _) => _ = StopWithConfirm(false);
        trayRestart.Click += (_, _) => _ = StopWithConfirm(true);
        trayExit.Click += (_, _) => _ = Exit(confirm: true);
        menu.Items.AddRange([title, trayStatus, new ToolStripSeparator(), trayOpen, manager,
            trayServiceRule, trayStop, trayRestart, new ToolStripSeparator(), trayExit]);
        return menu;
    }

    private void UpdateTray(string status, bool running, bool ready)
    {
        trayStatus.Text = (ready ? "●  " : "○  ") + status;
        trayStatus.ForeColor = trayHighContrast ? SystemColors.MenuText : ready ? palette.Accent : palette.Muted;
        tray.Text = "MshTV · " + status;
        trayOpen.Text = primary.Text;
        trayOpen.Enabled = primary.Enabled;
        trayServiceRule.Available = trayStop.Available = trayRestart.Available = running;
        trayStop.Enabled = stop.Enabled;
        trayRestart.Enabled = restart.Enabled;
        trayExit.Enabled = !busy;
    }

    private void ApplyTrayTheme()
    {
        if (trayHighContrast || tray.ContextMenuStrip is not { } menu) return;
        menu.ForeColor = palette.Text;
        trayStatus.ForeColor = backend.Ready && backend.Running ? palette.Accent : palette.Muted;
        menu.Invalidate();
    }

    private static ToolStripMenuItem TrayAction(string text) => new(text) { Padding = new Padding(10, 5, 10, 5) };

    private sealed class TrayMenuRenderer(LauncherWindow window) : ToolStripSystemRenderer
    {
        protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e) => e.Graphics.Clear(window.palette.Card);

        protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e)
        {
            using var pen = new Pen(window.palette.Border);
            e.Graphics.DrawRectangle(pen, 0, 0, e.ToolStrip.Width - 1, e.ToolStrip.Height - 1);
        }

        protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e)
        {
            if (!e.Item.Selected || !e.Item.Enabled) return;
            using var brush = new SolidBrush(window.palette.Control);
            var inset = e.Item.Owner?.LogicalToDeviceUnits(4) ?? 4;
            var mark = e.Item.Owner?.LogicalToDeviceUnits(new Size(24, 2)) ?? new Size(24, 2);
            var bounds = new Rectangle(inset, 1, e.Item.Width - 2 * inset, e.Item.Height - mark.Height * 2 - 2);
            var smoothing = e.Graphics.SmoothingMode;
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.FillRoundedRectangle(brush, bounds, new Size(inset + 2, inset + 2));
            PaintHoverAccent(e.Graphics, bounds, window.palette.HoverAccent, mark.Width, mark.Height);
            e.Graphics.SmoothingMode = smoothing;
        }

        protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e)
        {
            using var pen = new Pen(window.palette.Border);
            var y = e.Item.Height / 2;
            e.Graphics.DrawLine(pen, 10, y, e.Item.Width - 11, y);
        }

        protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
        {
            e.TextColor = e.Item.Enabled ? e.Item.ForeColor : window.palette.Muted;
            if (e.Item is ToolStripMenuItem)
            {
                var inset = e.Item.Owner?.LogicalToDeviceUnits(7) ?? 7;
                var text = e.TextRectangle;
                var lift = e.Item.Selected && e.Item.Enabled && SystemInformation.UIEffectsEnabled
                    ? e.Item.Owner?.LogicalToDeviceUnits(1) ?? 1 : 0;
                e.TextRectangle = new Rectangle(text.X + inset, text.Y - lift, text.Width - inset, text.Height);
            }
            base.OnRenderItemText(e);
        }
    }
}
