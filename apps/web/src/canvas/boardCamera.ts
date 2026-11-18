import type { Camera } from '../model';
import { useCanvas } from '../store';
import { defaultCamera, maxCameraScale, minCameraScale } from './geometry';

function readCamera(key: string): Camera {
  try {
    const camera: Camera | null = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (camera && Number.isFinite(camera.x) && Number.isFinite(camera.y) && Number.isFinite(camera.scale)
      && camera.scale >= minCameraScale && camera.scale <= maxCameraScale) return camera;
  } catch { /* Use the default if browser storage is unavailable or invalid. */ }
  return defaultCamera;
}

let active: { key: string; stop: () => void } | undefined;

export function trackBoardCamera(workspaceVersion: string, boardId: string) {
  const key = `mshtv:board-camera:${workspaceVersion}:${boardId}`;
  if (active?.key === key) return;
  active?.stop();
  useCanvas.getState().setCamera(readCamera(key));

  let pending: Camera | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!pending) return;
    try { localStorage.setItem(key, JSON.stringify(pending)); } catch { /* The view still works for this page. */ }
    pending = undefined;
  };
  const unsubscribe = useCanvas.subscribe((next, prev) => {
    if (next.camera === prev.camera) return;
    pending = next.camera;
    timer ??= setTimeout(flush, 300);
  });
  const saveWhenHidden = () => { if (document.hidden) flush(); };
  document.addEventListener('visibilitychange', saveWhenHidden);
  window.addEventListener('pagehide', flush);
  active = { key, stop: () => {
    flush();
    unsubscribe();
    document.removeEventListener('visibilitychange', saveWhenHidden);
    window.removeEventListener('pagehide', flush);
  } };
}
