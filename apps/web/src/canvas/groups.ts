import type { BoardDocument, CanvasGroup, CanvasItem } from '../model';
import { bounds } from './geometry';
import { mediaLayout } from './mediaGeometry';

export function groupBounds(items: CanvasItem[]) {
  const b = bounds(items.map(mediaLayout));
  return { x: b.x - 24, y: b.y - 48, width: Math.max(80, b.width + 48), height: Math.max(80, b.height + 72) };
}

// Membership changes on drop, using the card center. Last-painted board wins overlaps.
export function containingGroup(item: CanvasItem, groups: CanvasGroup[]): string | null {
  const layout = mediaLayout(item);
  const x = layout.x + layout.width / 2, y = layout.y + layout.height / 2;
  for (let index = groups.length - 1; index >= 0; index--) {
    const g = groups[index];
    if (x >= g.x && y >= g.y && x <= g.x + g.width && y <= g.y + g.height) return g.id;
  }
  return null;
}

export function assignMembership(doc: BoardDocument, ids: Set<string>): BoardDocument {
  return { ...doc, items: doc.items.map(item => ids.has(item.id) ? { ...item, groupId: containingGroup(item, doc.groups) } : item) };
}

export function groupTitleBounds(width: number) {
  return { x: 16, y: 14, width: Math.max(1, width - 32), height: 20 };
}
