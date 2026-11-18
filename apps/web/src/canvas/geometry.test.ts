import { describe, it, expect } from 'vitest';
import { fitCamera, toWorld, zoomAt } from './geometry';
import { diffDocuments, emptyDocument, type CanvasItem } from '../model';
describe('world camera', () => {
  it('keeps pointer anchored at arbitrary pan and scale', () => {
    for (const scale of [.02, .1, .75, 1, 3, 8]) {
      const camera = { x: -240, y: 528, scale }, point = { x: 726, y: 329 };
      const before = toWorld(point, camera), after = toWorld(point, zoomAt(camera, point, scale * 1.15));
      expect(after.x).toBeCloseTo(before.x, 8); expect(after.y).toBeCloseTo(before.y, 8);
    }
  });
  it('fits negative and positive coordinates with padding', () => {
    const items = [{ x: -1000, y: -500, width: 320, height: 220 }, { x: 800, y: 600, width: 400, height: 300 }] as CanvasItem[];
    const c = fitCamera(items, 1200, 800);
    for (const i of items) { expect(i.x * c.scale + c.x).toBeGreaterThanOrEqual(59); expect((i.x + i.width) * c.scale + c.x).toBeLessThanOrEqual(1141); expect((i.y + i.height) * c.scale + c.y).toBeLessThanOrEqual(741); }
  });
  it('clamps zoom', () => { expect(zoomAt({ x: 0, y: 0, scale: 1 }, { x: 0, y: 0 }, 100).scale).toBe(8); });
});
it('emits independent group/item operations and deletions', () => {
  const before = emptyDocument(), after = { ...before, groups: [{ id: 'group', name: 'test', x: 0, y: 0, width: 400, height: 300 }], items: [{ id: 'one', groupId: 'group' } as CanvasItem] };
  expect(diffDocuments(before, after).map(o => o.kind)).toEqual(['putGroup', 'putItem']);
  expect(diffDocuments(after, before).map(o => o.kind)).toEqual(['deleteItem', 'deleteGroup']);
});
