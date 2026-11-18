import type { Camera, CanvasItem, Point } from '../model';
export const defaultCamera: Camera = { x: 100, y: 100, scale: 1 };
export const minCameraScale = .02;
export const maxCameraScale = 8;

export function toWorld(point: Point, camera: Camera): Point { return { x: (point.x - camera.x) / camera.scale, y: (point.y - camera.y) / camera.scale }; }
export function zoomAt(camera: Camera, point: Point, scale: number): Camera {
  scale = Math.max(minCameraScale, Math.min(maxCameraScale, scale));
  const world = toWorld(point, camera);
  return { x: point.x - world.x * scale, y: point.y - world.y * scale, scale };
}
type Rectangle = Pick<CanvasItem, 'x' | 'y' | 'width' | 'height'>;
export function bounds(items: Rectangle[]) {
  if (!items.length) return { x: 0, y: 0, width: 0, height: 0 };
  const x = Math.min(...items.map(i => i.x)), y = Math.min(...items.map(i => i.y));
  return { x, y, width: Math.max(...items.map(i => i.x + i.width)) - x, height: Math.max(...items.map(i => i.y + i.height)) - y };
}
export function fitCamera(items: Rectangle[], width: number, height: number): Camera {
  if (!items.length) return { x: width / 2, y: height / 2, scale: 1 };
  const box = bounds(items), scale = Math.max(minCameraScale, Math.min(1.5, (width - 120) / box.width, (height - 120) / box.height));
  return { x: width / 2 - (box.x + box.width / 2) * scale, y: height / 2 - (box.y + box.height / 2) * scale, scale };
}
