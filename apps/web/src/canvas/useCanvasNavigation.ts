import { useEffect, type RefObject } from 'react';
import { create } from 'zustand';
import type { Camera, Point } from '../model';
import { useCanvas } from '../store';
import { zoomAt } from './geometry';

export type ScrollMode = 'auto' | 'trackpad' | 'mouse';
const storageKey = 'mshtv:canvas-scroll-mode';

function readMode(): ScrollMode {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === 'trackpad' || saved === 'mouse') return saved;
  } catch { /* Use the device default when browser storage is unavailable. */ }
  return 'auto';
}

export const useScrollMode = create<{ mode: ScrollMode; setMode: (mode: ScrollMode) => void }>(set => ({
  mode: readMode(),
  setMode(mode) {
    set({ mode });
    try { localStorage.setItem(storageKey, mode); } catch { /* The selection still works for this page. */ }
  },
}));

export function scrollPans(mode: ScrollMode) {
  return mode === 'trackpad' || mode === 'auto' && /^Mac/.test(navigator.platform) && navigator.maxTouchPoints === 0;
}

type SafariGesture = Event & { scale?: number; clientX?: number; clientY?: number };

function overCanvas(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest('.konvajs-content, .canvas-playback'));
}

export function useCanvasNavigation(host: RefObject<HTMLDivElement | null>, panWithScroll: boolean) {
  useEffect(() => {
    const surface = host.current;
    if (!surface) return;
    let frame = 0;
    let base: Camera | undefined;
    let pending: Camera | undefined;
    let pointer: Point | undefined;
    let pinch: { camera: Camera; anchor: Point } | undefined;
    const current = () => useCanvas.getState().camera;
    const nextCamera = () => base === current() && pending ? pending : current();
    const schedule = (camera: Camera) => {
      base = current();
      pending = camera;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        // A fit/reset or a mouse pan may have replaced the camera before the frame.
        if (pending && current() === base) useCanvas.getState().setCamera(pending);
        pending = undefined;
        base = undefined;
      });
    };
    const wheel = (event: WheelEvent) => {
      if (!overCanvas(event.target)) return;
      event.preventDefault();
      if (pinch) return;
      const camera = nextCamera();
      const line = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
      const page = event.deltaMode === WheelEvent.DOM_DELTA_PAGE;
      const dx = event.deltaX * (page ? surface.clientWidth : line);
      const dy = event.deltaY * (page ? surface.clientHeight : line);
      if (panWithScroll && !event.ctrlKey && !event.metaKey) {
        if (!dx && !dy) return;
        const horizontal = event.shiftKey && dx === 0;
        schedule({ ...camera, x: camera.x - (horizontal ? dy : dx), y: camera.y - (horizontal ? 0 : dy) });
      } else if (dy) {
        const rect = surface.getBoundingClientRect();
        schedule(zoomAt(camera, { x: event.clientX - rect.left, y: event.clientY - rect.top },
          camera.scale * Math.exp(-Math.max(-120, Math.min(120, dy)) * .003)));
      }
    };
    const rememberPointer = (event: PointerEvent) => {
      pointer = overCanvas(event.target) ? { x: event.clientX, y: event.clientY } : undefined;
    };
    const clearPointer = () => { pointer = undefined; };
    const beginPinch = (event: SafariGesture) => {
      if (!overCanvas(event.target)) return;
      event.preventDefault();
      const rect = surface.getBoundingClientRect();
      const position = typeof event.clientX === 'number' && typeof event.clientY === 'number' &&
        event.clientX >= rect.left && event.clientX < rect.right && event.clientY >= rect.top && event.clientY < rect.bottom
        ? { x: event.clientX, y: event.clientY } : pointer;
      pinch = { camera: nextCamera(), anchor: position
        ? { x: position.x - rect.left, y: position.y - rect.top }
        : { x: rect.width / 2, y: rect.height / 2 } };
    };
    const movePinch = (event: SafariGesture) => {
      if (!pinch) return;
      event.preventDefault();
      const scale = event.scale;
      if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) return;
      schedule(zoomAt(pinch.camera, pinch.anchor, pinch.camera.scale * scale));
    };
    const endPinch = (event: Event) => {
      if (pinch) event.preventDefault();
      pinch = undefined;
    };
    const resetInput = () => {
      pinch = undefined;
      pointer = undefined;
      cancelAnimationFrame(frame);
      frame = 0;
      base = undefined;
      pending = undefined;
    };
    surface.addEventListener('wheel', wheel, { passive: false });
    surface.addEventListener('pointermove', rememberPointer);
    surface.addEventListener('pointerleave', clearPointer);
    surface.addEventListener('gesturestart', beginPinch, { passive: false });
    window.addEventListener('gesturechange', movePinch, { passive: false });
    window.addEventListener('gestureend', endPinch, { passive: false });
    window.addEventListener('blur', resetInput);
    return () => {
      resetInput();
      surface.removeEventListener('wheel', wheel);
      surface.removeEventListener('pointermove', rememberPointer);
      surface.removeEventListener('pointerleave', clearPointer);
      surface.removeEventListener('gesturestart', beginPinch);
      window.removeEventListener('gesturechange', movePinch);
      window.removeEventListener('gestureend', endPinch);
      window.removeEventListener('blur', resetInput);
    };
  }, [host, panWithScroll]);
}
