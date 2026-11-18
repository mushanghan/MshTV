import { useEffect, useRef, type RefObject } from 'react';
import Konva from 'konva';
import { hdrBrightness, hdrDisplayQuery, useSelectionHdr } from '../selectionHdr';
import { useCanvas } from '../store';
import { useTheme } from '../theme';
import { selectionLightStrength } from './SelectionLight';
import { createHdrRenderer, type HdrShape } from './hdrRenderer';

function frameShapes(layer: Konva.Layer, width: number, height: number) {
  const shapes: HdrShape[] = [];
  const lights: HdrShape[] = [];
  for (const node of layer.getChildren()) {
    if (!node.visible() || node.opacity() <= 0) continue;
    const children = node instanceof Konva.Group ? node.getChildren() : [];
    const background = node instanceof Konva.Rect ? node : children.find(child =>
      child.hasName('card-background') || child.hasName('group-background'));
    if (!(background instanceof Konva.Rect)) continue;
    const light = children.find((child): child is Konva.Shape => child instanceof Konva.Shape && child.hasName('selection-light'));
    const strength = light && node instanceof Konva.Group ? selectionLightStrength(node, Boolean(light.getAttr('steadyLight'))) : 0;
    if (!strength && !lights.length) continue;

    const origin = background.getAbsolutePosition();
    const scale = background.getAbsoluteScale();
    const minScale = Math.min(Math.abs(scale.x), Math.abs(scale.y));
    const w = background.width() * scale.x, h = background.height() * scale.y;
    const x = origin.x, y = origin.y, spread = strength ? 14 * Math.min(1, 2 * minScale) : 0;
    if (w <= 0 || h <= 0 || x - spread >= width || y - spread >= height || x + w + spread <= 0 || y + h + spread <= 0) continue;
    const radius = Math.min(Number(background.cornerRadius()) * minScale, w / 2, h / 2);
    const shape = { x, y, width: w, height: h, radius, strength, opacity: node.opacity(), spread };
    // Later canvas objects erase earlier lights where their opaque surfaces cover them.
    if (lights.some(light => x < light.x + light.width + light.spread && x + w > light.x - light.spread &&
      y < light.y + light.height + light.spread && y + h > light.y - light.spread)) {
      shapes.push({ ...shape, strength: 0 });
    }
    if (strength) {
      shapes.push(shape);
      lights.push(shape);
    }
  }
  return shapes;
}

export function SelectionHdrLayer({ layer, performanceMode }: { layer: RefObject<Konva.Layer | null>; performanceMode: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const darkTheme = useTheme(state => state.theme === 'dark');
  const wantsHdr = useSelectionHdr(state => hdrBrightness(state, darkTheme) > 0);
  const active = wantsHdr && !performanceMode;
  useEffect(() => {
    const canvas = canvasRef.current, scene = layer.current;
    if (!active || !canvas || !scene) return;
    const display = window.matchMedia(hdrDisplayQuery);
    let renderer: Awaited<ReturnType<typeof createHdrRenderer>> | undefined;
    let initializing = false, failed = false, disposed = false, scheduled = 0;

    const fallback = () => {
      canvas.hidden = true;
      renderer?.release();
      renderer = undefined;
      useSelectionHdr.setState({ output: 'fallback' });
    };
    const draw = () => {
      if (!renderer) return;
      const dark = useTheme.getState().theme === 'dark';
      const amount = hdrBrightness(useSelectionHdr.getState(), dark);
      const { selected, selectedGroups } = useCanvas.getState();
      const count = selected.length + selectedGroups.length;
      const stage = scene.getStage(), width = stage?.width() ?? 0, height = stage?.height() ?? 0;
      if (!amount || !count || count > 24 || !width || !height || document.hidden) {
        canvas.hidden = true;
        return;
      }
      try {
        const shapes = frameShapes(scene, width, height);
        canvas.hidden = !shapes.length;
        if (shapes.length) renderer.draw(shapes, width, height, amount, dark);
      } catch {
        failed = true;
        fallback();
      }
    };
    const start = async () => {
      if (disposed) return;
      if (!display.matches || !navigator.gpu) { fallback(); return; }
      if (failed || initializing || renderer) return;
      initializing = true;
      try {
        const current = await createHdrRenderer(canvas);
        if (disposed || !display.matches) { current.release(); return; }
        renderer = current;
        useSelectionHdr.setState({ output: 'ready' });
        void current.failed.then(() => {
          if (disposed || renderer !== current) return;
          failed = true;
          fallback();
        });
        draw();
      } catch {
        if (!disposed) { failed = true; fallback(); }
      } finally {
        initializing = false;
      }
    };
    const schedule = () => {
      if (scheduled) return;
      scheduled = requestAnimationFrame(() => { scheduled = 0; draw(); });
    };
    const unsubscribeHdr = useSelectionHdr.subscribe((state, before) => {
      const dark = useTheme.getState().theme === 'dark';
      if (hdrBrightness(state, dark) !== hdrBrightness(before, dark)) schedule();
    });
    const unsubscribeTheme = useTheme.subscribe(schedule);
    scene.on('draw.hdr', draw);
    display.addEventListener('change', start);
    document.addEventListener('visibilitychange', schedule);
    // Start after the current commit so a discarded StrictMode effect never owns the canvas.
    queueMicrotask(() => { if (!disposed) void start(); });
    return () => {
      disposed = true;
      cancelAnimationFrame(scheduled);
      scene.off('draw.hdr', draw);
      display.removeEventListener('change', start);
      document.removeEventListener('visibilitychange', schedule);
      unsubscribeHdr();
      unsubscribeTheme();
      renderer?.release();
      canvas.hidden = true;
      useSelectionHdr.setState({ output: 'idle' });
    };
  }, [active, layer]);
  return active ? <canvas ref={canvasRef} className="selection-hdr-layer" aria-hidden="true" hidden/> : null;
}
