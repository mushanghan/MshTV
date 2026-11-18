import { describe, expect, it } from 'vitest';
import { assignMembership, containingGroup, groupBounds } from './groups';
import { emptyDocument, type CanvasItem, type CanvasGroup } from '../model';

const item = (x: number, y: number, groupId: string | null = null): CanvasItem => ({ id: 'item', type: 'note', assetId: null, title: '', text: '正文', x, y, width: 100, height: 80, groupId });
const group: CanvasGroup = { id: 'a', name: 'A', x: 0, y: 0, width: 300, height: 200 };
describe('spatial group boards', () => {
  it('creates independent bounds with room for the header', () => {
    const b = groupBounds([item(-50, 20), item(200, 100)]);
    expect(b).toEqual({ x: -74, y: -28, width: 398, height: 232 });
  });
  it('joins and leaves by card center, including partial overlap', () => {
    expect(containingGroup(item(-40, 20), [group])).toBe('a');
    expect(containingGroup(item(-60, 20), [group])).toBeNull();
    expect(containingGroup(item(100, 170), [group])).toBeNull();
  });
  it('chooses the top painted overlapping board and can transfer between boards', () => {
    const top = { ...group, id: 'b', x: 100 };
    expect(containingGroup(item(120, 10), [group, top])).toBe('b');
    expect(containingGroup(item(320, 10, 'a'), [group, top])).toBe('b');
  });
  it('reassigns only affected cards and retains empty boards and independent geometry', () => {
    const original = { ...emptyDocument(), groups: [group], items: [item(350, 0, 'a'), { ...item(20, 10), id: 'untouched' }] };
    const next = assignMembership(original, new Set(['item']));
    expect(next.items[0].groupId).toBeNull(); expect(next.items[1]).toBe(original.items[1]);
    expect(next.groups).toBe(original.groups); expect(next.groups[0]).toEqual(group);
    expect(original.items[0].groupId).toBe('a');
  });
});
