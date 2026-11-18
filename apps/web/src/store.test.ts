import { beforeEach, expect, it } from 'vitest';
import { emptyDocument, type CanvasItem } from './model';
import { useCanvas } from './store';
const item: CanvasItem = { id: 'note', type: 'note', assetId: null, title: '备注', text: '原文', x: 20, y: 30, width: 320, height: 200, groupId: null };
beforeEach(() => { useCanvas.getState().replace({ ...emptyDocument(), items: [item] }); useCanvas.setState({ editable: true }); });
it('updates the live document while undoing a full editing session in one step', () => {
  const s = useCanvas.getState(); s.beginEditing({ id: 'note', field: 'text' });
  s.updateEditing('第一个输入'); s.updateEditing('完成的一段中文');
  expect(useCanvas.getState().doc.items[0].text).toBe('完成的一段中文'); expect(useCanvas.getState().past).toHaveLength(0);
  s.finishEditing(); expect(useCanvas.getState().past).toHaveLength(1);
  s.undo(); expect(useCanvas.getState().doc.items[0].text).toBe('原文');
  s.redo(); expect(useCanvas.getState().doc.items[0].text).toBe('完成的一段中文');
});
it('cancels to the original field without changing card geometry or adding history', () => {
  const s = useCanvas.getState(); s.beginEditing({ id: 'note', field: 'title' }); s.updateEditing('临时名称'); s.finishEditing(true);
  expect(useCanvas.getState().doc.items[0]).toEqual(item); expect(useCanvas.getState().past).toHaveLength(0);
  expect(useCanvas.getState().editing).toBeNull();
});
it('preserves styles through undo redo and cancels style-only changes', () => {
  const s = useCanvas.getState(), mark = { from: 0, to: 2, bold: true, italic: false, underline: true, red: true };
  s.beginEditing({ id: 'note', field: 'text' }); s.updateNote('原文', [mark]); s.finishEditing();
  s.undo(); expect(useCanvas.getState().doc.items[0].noteSpans ?? []).toEqual([]);
  s.redo(); expect(useCanvas.getState().doc.items[0].noteSpans).toEqual([mark]);
  s.beginEditing({ id: 'note', field: 'text' }); s.updateNote('原文', []); s.finishEditing(true);
  expect(useCanvas.getState().doc.items[0].noteSpans).toEqual([mark]);
});
