using System.Drawing.Drawing2D;

namespace MshTV.Launcher;

internal sealed partial class LauncherWindow
{
    private readonly List<LauncherCard> cards = [];
    private readonly List<Label> mutedLabels = [];
    private Palette palette = Palette.Light;

    private void ToggleTheme() => Try(() =>
    {
        var changed = preferences with { DarkTheme = !preferences.DarkTheme };
        Installation.SavePreferences(changed);
        preferences = changed;
        ApplyTheme();
    });

    private void ApplyTheme()
    {
        palette = trayHighContrast ? Palette.HighContrast : preferences.DarkTheme ? Palette.Dark : Palette.Light;
        BackColor = palette.Background;
        ForeColor = palette.Text;
        header.BackColor = footer.BackColor = palette.Bar;
        foreach (var card in cards) card.BackColor = palette.Card;
        foreach (var label in mutedLabels) label.ForeColor = palette.Muted;
        network.ForeColor = media.ForeColor = dataPath.ForeColor = cachePath.ForeColor = used.ForeColor = closeToTray.ForeColor = palette.Muted;
        closeToTray.FlatAppearance.CheckedBackColor = palette.Selected;
        closeToTray.FlatAppearance.MouseOverBackColor = palette.Card;
        closeToTray.FlatAppearance.MouseDownBackColor = palette.Card;
        detail.ForeColor = detailError ? palette.Warning : palette.Muted;
        state.BackColor = palette.Selected;
        state.ForeColor = backend.Ready ? palette.Accent : palette.Muted;
        themeToggle.Text = preferences.DarkTheme ? "浅色" : "深色";
        themeToggle.AccessibleName = preferences.DarkTheme ? "切换到浅色主题" : "切换到深色主题";
        hints.SetToolTip(themeToggle, themeToggle.AccessibleName);
        ApplyTrayTheme();
        Invalidate(invalidateChildren: true);
    }

    private Label MutedCaption(string text, float size)
    {
        var label = Caption(text, size);
        mutedLabels.Add(label);
        return label;
    }

    private sealed record Palette(Color Background, Color Bar, Color Card, Color Border, Color Control,
        Color Selected, Color Text, Color Muted, Color Accent, Color Primary, Color PrimaryText, Color Warning, Color HoverAccent)
    {
        public static readonly Palette Light = new(
            Rgb(0xe4e4e6), Rgb(0xf1f1f1), Rgb(0xf5f5f6), Rgb(0xcdd1d7), Rgb(0xeff0f2),
            Rgb(0xdfe1e5), Rgb(0x202124), Rgb(0x545964), Rgb(0x444b56), Rgb(0x282b32), Rgb(0xfafafa),
            Rgb(0x8e3738), Rgb(0xf4ac32));

        public static readonly Palette Dark = new(
            Rgb(0x141619), Rgb(0x1b1d21), Rgb(0x23272b), Rgb(0x3a3f44), Rgb(0x2d3337),
            Rgb(0x324238), Rgb(0xe1e4e5), Rgb(0xa5b2ad), Rgb(0xa7c4b1), Rgb(0x3d5547), Rgb(0xe5f0e9),
            Rgb(0xefb48b), Rgb(0xffca5e));

        public static Palette HighContrast => new(
            SystemColors.Window, SystemColors.Control, SystemColors.Window, SystemColors.WindowText, SystemColors.Control,
            SystemColors.Window, SystemColors.WindowText, SystemColors.WindowText, SystemColors.WindowText,
            SystemColors.Highlight, SystemColors.HighlightText, SystemColors.WindowText, Color.Transparent);

        private static Color Rgb(int value) => Color.FromArgb(unchecked((int)0xff000000) | value);
    }

    private static void PaintHoverAccent(Graphics graphics, Rectangle surface, Color color, int width, int thickness)
    {
        if (color.A == 0) return;
        width = Math.Min(width, surface.Width);
        var line = new Rectangle(surface.X + (surface.Width - width) / 2, surface.Bottom + thickness, width, thickness);
        using var fill = new SolidBrush(color);
        graphics.FillRoundedRectangle(fill, line, new Size(thickness, thickness));
    }

    private sealed class LauncherCard : Panel
    {
        public LauncherCard() => DoubleBuffered = true;
    }

    private enum ButtonKind { Standard, Primary, Tab, Chrome, Theme }

    private sealed class LauncherButton : Button
    {
        private readonly ButtonKind kind;
        private readonly System.Windows.Forms.Timer animation = new() { Interval = 16 };
        private float liftProgress;
        private bool hovered, pressed, selected;

        public LauncherButton(ButtonKind kind)
        {
            this.kind = kind;
            DoubleBuffered = true;
            animation.Tick += (_, _) =>
            {
                var target = IsHighlighted ? 1f : 0f;
                liftProgress += (target - liftProgress) * .32f;
                if (Math.Abs(liftProgress - target) < .04f)
                {
                    liftProgress = target;
                    animation.Stop();
                }
                Invalidate();
            };
        }

        private bool IsHighlighted => Enabled && Visible && (hovered || Focused && ShowFocusCues);

        public void SelectTab(bool active)
        {
            selected = active;
            Invalidate();
        }

        private void UpdateLift()
        {
            if (Disposing || IsDisposed) return;
            if (!Enabled || !Visible || !SystemInformation.UIEffectsEnabled || SystemInformation.HighContrast)
            {
                animation.Stop();
                liftProgress = 0;
            }
            else if (liftProgress != (IsHighlighted ? 1 : 0)) animation.Start();
            Invalidate();
        }

        protected override void OnMouseEnter(EventArgs e) { base.OnMouseEnter(e); hovered = true; UpdateLift(); }
        protected override void OnMouseLeave(EventArgs e) { base.OnMouseLeave(e); hovered = pressed = false; UpdateLift(); }
        protected override void OnMouseDown(MouseEventArgs e) { base.OnMouseDown(e); pressed = e.Button == MouseButtons.Left; Invalidate(); }
        protected override void OnMouseUp(MouseEventArgs e) { base.OnMouseUp(e); pressed = false; Invalidate(); }
        protected override void OnMouseCaptureChanged(EventArgs e) { base.OnMouseCaptureChanged(e); if (!Capture) { pressed = false; Invalidate(); } }
        protected override void OnGotFocus(EventArgs e) { base.OnGotFocus(e); UpdateLift(); }
        protected override void OnLostFocus(EventArgs e) { base.OnLostFocus(e); UpdateLift(); }
        protected override void OnChangeUICues(UICuesEventArgs e) { base.OnChangeUICues(e); UpdateLift(); }
        protected override void OnEnabledChanged(EventArgs e) { base.OnEnabledChanged(e); if (!Enabled) pressed = hovered = false; UpdateLift(); }
        protected override void OnVisibleChanged(EventArgs e) { base.OnVisibleChanged(e); if (!Visible) pressed = hovered = false; UpdateLift(); }

        protected override void OnPaint(PaintEventArgs e)
        {
            if (SystemInformation.HighContrast) { base.OnPaint(e); return; }
            var window = FindForm() as LauncherWindow;
            var colors = window?.palette ?? Palette.Light;
            var graphics = e.Graphics;
            graphics.Clear(Parent?.BackColor ?? colors.Card);
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            var lift = !pressed && SystemInformation.UIEffectsEnabled ? (int)Math.Round(LogicalToDeviceUnits(2) * liftProgress) : 0;
            var surface = new Rectangle(LogicalToDeviceUnits(2), LogicalToDeviceUnits(4) - lift,
                Width - LogicalToDeviceUnits(4), Height - LogicalToDeviceUnits(11));
            if (surface.Width <= 0 || surface.Height <= 0) return;
            if (IsHighlighted && !pressed)
                PaintHoverAccent(graphics, surface, colors.HoverAccent, LogicalToDeviceUnits(kind == ButtonKind.Primary ? 32 : 22), LogicalToDeviceUnits(2));

            var primary = kind == ButtonKind.Primary && Enabled;
            var fill = primary ? colors.Primary : selected ? colors.Selected : colors.Control;
            var ink = primary ? colors.PrimaryText : Enabled && kind is not ButtonKind.Chrome ? colors.Text : colors.Muted;
            var radius = new Size(LogicalToDeviceUnits(6), LogicalToDeviceUnits(6));
            if (kind is ButtonKind.Standard or ButtonKind.Primary || selected)
            {
                using var brush = new SolidBrush(fill);
                using var border = new Pen(primary ? fill : colors.Border);
                graphics.FillRoundedRectangle(brush, surface, radius);
                graphics.DrawRoundedRectangle(border, surface, radius);
            }
            if (Focused && ShowFocusCues)
            {
                using var focus = new Pen(ink) { DashStyle = DashStyle.Dot };
                graphics.DrawRoundedRectangle(focus, Rectangle.Inflate(surface, -2, -2), radius);
            }
            if (kind == ButtonKind.Theme) surface = PaintThemeIcon(graphics, surface, ink, window?.preferences.DarkTheme == true);
            TextRenderer.DrawText(graphics, Text, Font, surface, ink,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis);
        }

        private Rectangle PaintThemeIcon(Graphics graphics, Rectangle surface, Color ink, bool sun)
        {
            var iconSize = LogicalToDeviceUnits(14);
            var gap = LogicalToDeviceUnits(7);
            var textWidth = TextRenderer.MeasureText(graphics, Text, Font, surface.Size, TextFormatFlags.SingleLine).Width;
            var left = surface.Left + (surface.Width - iconSize - gap - textWidth) / 2;
            var top = surface.Top + (surface.Height - iconSize) / 2;
            var saved = graphics.Save();
            graphics.TranslateTransform(left, top);
            graphics.ScaleTransform(iconSize / 16f, iconSize / 16f);
            using var stroke = new Pen(ink, 1.4f) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round };
            if (sun)
            {
                graphics.DrawEllipse(stroke, 5, 5, 6, 6);
                for (var ray = 0; ray < 8; ray++)
                {
                    var angle = ray * MathF.PI / 4;
                    var x = MathF.Cos(angle);
                    var y = MathF.Sin(angle);
                    graphics.DrawLine(stroke, 8 + x * 5.5f, 8 + y * 5.5f, 8 + x * 7, 8 + y * 7);
                }
            }
            else
            {
                using var moon = new GraphicsPath();
                moon.AddBezier(14, 9, 9, 12, 3.6f, 7, 7, 2);
                moon.AddBezier(7, 2, 2.8f, 2.8f, 1, 6.9f, 2.7f, 10.3f);
                moon.AddBezier(2.7f, 10.3f, 5, 15.5f, 12, 15.2f, 14, 9);
                graphics.DrawPath(stroke, moon);
            }
            graphics.Restore(saved);
            return new Rectangle(left + iconSize + gap, surface.Top, textWidth, surface.Height);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) animation.Dispose();
            base.Dispose(disposing);
        }
    }
}
