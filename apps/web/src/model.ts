export type ItemType = 'image' | 'video' | 'audio' | 'note';
export interface NoteSpan { from: number; to: number; bold: boolean; italic: boolean; underline: boolean; red: boolean }
export interface CanvasItem { id: string; type: ItemType; assetId: string | null; title: string; text: string; x: number; y: number; width: number; height: number; groupId: string | null; noteSpans?: NoteSpan[] | null }
export interface CanvasGroup { id: string; name: string; x: number; y: number; width: number; height: number }
export const groupNameLimit = 100;
export interface BoardDocument { schemaVersion: 1; name: string; items: CanvasItem[]; groups: CanvasGroup[] }
export interface BoardSnapshot { id: string; revision: number; document: BoardDocument }
export interface Camera { x: number; y: number; scale: number }
export interface Point { x: number; y: number }
export interface Operation { kind: 'putItem' | 'deleteItem' | 'putGroup' | 'deleteGroup'; item?: CanvasItem; group?: CanvasGroup; id?: string }
export const emptyDocument = (): BoardDocument => ({ schemaVersion: 1, name: '自由画布', items: [], groups: [] });
export const samples = [
  { id: 'sample-dunes', title: '沙丘 · 远景', url: '/samples/dunes.svg', color: '#bc9876', aspect: 16 / 9 },
  { id: 'sample-coast', title: '海岸 · 空镜', url: '/samples/coast.svg', color: '#779b9a', aspect: 16 / 9 },
  { id: 'sample-studio', title: '空间 · 光影', url: '/samples/studio.svg', color: '#9c949f', aspect: 16 / 9 },
];
export function diffDocuments(before: BoardDocument, after: BoardDocument): Operation[] {
  if (before === after) return [];
  const ops: Operation[] = [];
  const oldItems = new Map(before.items.map(x => [x.id, x]));
  const oldGroups = new Map(before.groups.map(x => [x.id, x]));
  for (const group of after.groups) {
    const previous = oldGroups.get(group.id);
    if (group !== previous && JSON.stringify(group) !== JSON.stringify(previous)) ops.push({ kind: 'putGroup', group });
    oldGroups.delete(group.id);
  }
  for (const item of after.items) {
    const previous = oldItems.get(item.id);
    if (item !== previous && JSON.stringify(item) !== JSON.stringify(previous)) ops.push({ kind: 'putItem', item });
    oldItems.delete(item.id);
  }
  for (const id of oldItems.keys()) ops.push({ kind: 'deleteItem', id });
  for (const id of oldGroups.keys()) ops.push({ kind: 'deleteGroup', id });
  return ops;
}
