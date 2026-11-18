import { useLayoutEffect, useRef } from 'react';
import Konva from 'konva';
import { Shape } from 'react-konva';
import type { CanvasPalette } from '../theme';

const lift = 3;

export function selectionLightStrength(group: Konva.Group, steady: boolean) {
  return steady ? 1 : Math.max(0, Math.min(1, group.offsetY() / lift));
}

export function useSelectionLift(selected: boolean, animate: boolean) {
  const node = useRef<Konva.Group | null>(null);
  useLayoutEffect(() => {
    const group = node.current;
    const target = selected ? lift : 0;
    if (!group || group.offsetY() === target) return;
    if (!animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      group.offsetY(target);
      return;
    }
    let tween: Konva.Tween | undefined = new Konva.Tween({
      node: group, offsetY: target, duration: .16, easing: Konva.Easings.EaseOut,
      onFinish: () => { group.off('.selectionLift'); tween?.destroy(); tween = undefined; },
    });
    group.on('transformstart.selectionLift', () => tween?.pause());
    group.on('transformend.selectionLift', () => tween?.play());
    tween.play();
    return () => { group.off('.selectionLift'); tween?.destroy(); };
  }, [selected, animate]);
  return node;
}

// The zero-sized shape paints light only. It has no hit area or selection bounds.
export function SelectionLight({ steady = false, radius = 7, glow }: {
  steady?: boolean; radius?: number; glow: CanvasPalette['selectionGlow'];
}) {
  return <Shape name="selection-light" steadyLight={steady} listening={false} sceneFunc={(context, shape) => {
    const group = shape.getParent();
    if (!(group instanceof Konva.Group)) return;
    const strength = selectionLightStrength(group, steady);
    if (strength <= 0) return;
    const scale = group.getAbsoluteScale();
    const zoom = Math.min(1, 2 * Math.min(Math.abs(scale.x), Math.abs(scale.y)));
    context.save();
    context.globalAlpha *= strength;
    context.shadowColor = glow.color;
    context.shadowBlur = glow.blur * zoom * context.canvas.getPixelRatio();
    context.fillStyle = glow.fill;
    context.beginPath();
    Konva.Util.drawRoundedRectPath(context, group.width(), group.height(), radius);
    context.closePath();
    // The card covers the solid fill, leaving only the feathered light around it.
    context.fill();
    context.restore();
  }}/>;
}
