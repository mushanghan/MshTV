import { create } from 'zustand';
import { emptyDocument, groupNameLimit, type BoardDocument, type Camera, type ItemType, type NoteSpan, type Point, samples } from './model';
import { assignMembership, groupBounds } from './canvas/groups';
import { defaultCamera } from './canvas/geometry';
import type { Asset } from './library';
import { mediaLayout, rememberMediaAspects } from './canvas/mediaGeometry';
export interface EditingTarget { id: string; field: 'text' | 'title' | 'name' }
type EditingSession = { before: BoardDocument; original: string; id: string } &
  ({ field: 'text' | 'title' } | { field: 'name'; draft: string });

function withGroupName(doc: BoardDocument, id: string, name: string): BoardDocument {
  const group = doc.groups.find(group => group.id === id);
  if (!group || name === group.name) return doc;
  return { ...doc, groups: doc.groups.map(group => group.id === id ? { ...group, name } : group) };
}
interface CanvasState {
  doc: BoardDocument; selected: string[]; selectedGroups: string[]; camera: Camera; tool: 'select' | 'hand'; past: BoardDocument[]; future: BoardDocument[]; editable: boolean;
  replace: (doc: BoardDocument) => void; commit: (doc: BoardDocument) => void; select: (ids: string[], groupIds?: string[]) => void;
  selectGroup: (id: string, additive?: boolean) => void;
  editing: EditingSession | null;
  beginEditing: (target: EditingTarget) => void; updateEditing: (value: string) => void; finishEditing: (cancel?: boolean) => void;
  updateNote: (text: string, noteSpans: NoteSpan[]) => void;
  setCamera: (camera: Camera) => void; setTool: (tool: 'select' | 'hand') => void; add: (type: ItemType, assetId?: string) => void;
  addAssets: (assets: Asset[], point: Point) => boolean;
  remove: () => void; group: () => void; ungroup: () => void; undo: () => void; redo: () => void;
}
export const useCanvas = create<CanvasState>((set, get) => ({
  doc: emptyDocument(), selected: [], selectedGroups: [], editing: null, camera: defaultCamera, tool: 'select', past: [], future: [], editable: false,
  replace: doc => set({ doc, selected: [], selectedGroups: [], editing: null, past: [], future: [] }),
  commit: doc => { get().finishEditing(); const s = get(); if (!s.editable || JSON.stringify(doc) === JSON.stringify(s.doc)) return; set({ doc, past: [...s.past, s.doc].slice(-60), future: [] }); },
  beginEditing: target => {
    if (get().editing?.id === target.id && get().editing?.field === target.field) return;
    get().finishEditing(); const s = get();
    if (!s.editable) return;
    const { id, field } = target;
    if (field === 'name') {
      const group = s.doc.groups.find(group => group.id === id);
      if (!group) return;
      set({ editing: { id, field, before: s.doc, original: group.name, draft: group.name }, selected: [], selectedGroups: [id], tool: 'select' });
      return;
    }
    const item = s.doc.items.find(item => item.id === id);
    if (item) set({ editing: { id, field, before: s.doc, original: item[field] }, selected: [id], selectedGroups: [], tool: 'select' });
  },
  updateEditing: value => {
    const s = get(), edit = s.editing; if (!edit || !s.editable) return;
    if (edit.field === 'name') {
      const draft = value.slice(0, groupNameLimit);
      // Keep the typed value in the input and only autosave names the server will accept.
      set({ editing: { ...edit, draft }, doc: withGroupName(s.doc, edit.id, draft.trim() || edit.original) });
      return;
    }
    const limit = edit.field === 'text' ? 10000 : 200;
    set({ doc: { ...s.doc, items: s.doc.items.map(i => i.id === edit.id ? { ...i, [edit.field]: value.slice(0, limit), ...(edit.field === 'text' ? { noteSpans: [] } : {}) } : i) } });
  },
  finishEditing: (cancel = false) => {
    const s = get(), edit = s.editing; if (!edit) return;
    if (edit.field === 'name') {
      const current = s.doc.groups.find(group => group.id === edit.id);
      if (cancel && s.editable) set({ editing: null, doc: withGroupName(s.doc, edit.id, edit.original) });
      else if (current && current.name !== edit.original) set({ editing: null, past: [...s.past, edit.before].slice(-60), future: [] });
      else set({ editing: null });
      return;
    }
    const current = s.doc.items.find(i => i.id === edit.id);
    if (cancel && s.editable) {
      set({ editing: null, doc: { ...s.doc, items: s.doc.items.map(i => {
        if (i.id !== edit.id) return i;
        const original = edit.before.items.find(before => before.id === edit.id)!;
        const restored = { ...i, [edit.field]: edit.original };
        if (edit.field === 'text') { if (original.noteSpans === undefined) delete restored.noteSpans; else restored.noteSpans = original.noteSpans; }
        return restored;
      }) } });
    } else if (current && (current[edit.field] !== edit.original || (edit.field === 'text' && JSON.stringify(current.noteSpans ?? []) !== JSON.stringify(edit.before.items.find(i => i.id === edit.id)?.noteSpans ?? [])))) {
      // Autosave each paused typing burst, but undo a whole editing session in one step.
      set({ editing: null, past: [...s.past, edit.before].slice(-60), future: [] });
    } else set({ editing: null });
  },
  updateNote: (text, noteSpans) => {
    const s = get(), edit = s.editing; if (!s.editable || edit?.field !== 'text') return;
    if (text.length > 10000 || noteSpans.length > 2000) return;
    set({ doc: { ...s.doc, items: s.doc.items.map(i => i.id === edit.id ? { ...i, text, noteSpans } : i) } });
  },
  select: (selected, selectedGroups = []) => set({ selected, selectedGroups }),
  selectGroup: (id, additive) => {
    const { selectedGroups } = get();
    if (!additive) { set({ selectedGroups: [id], selected: [] }); return; }
    set({ selectedGroups: selectedGroups.includes(id) ? selectedGroups.filter(group => group !== id) : [...selectedGroups, id] });
  },
  setCamera: camera => set({ camera }), setTool: tool => set({ tool }),
  add: (type, assetId) => {
    const s = get(); if (!s.editable) return;
    const host = document.querySelector('[data-canvas-host]')?.getBoundingClientRect();
    const offset = (s.doc.items.length % 6) * 24;
    const item = mediaLayout({ id: crypto.randomUUID(), type, assetId: assetId ?? null, title: type === 'note' ? '文字备注' : type === 'video' ? '视频占位' : type === 'audio' ? '音频占位' : samples.find(a => a.id === assetId)?.title ?? '示例图片', text: '', x: ((host?.width ?? 1000) / 2 - s.camera.x) / s.camera.scale - 160 + offset, y: ((host?.height ?? 700) / 2 - s.camera.y) / s.camera.scale - 110 + offset, width: 320, height: type === 'note' ? 200 : 220, groupId: null });
    s.commit(assignMembership({ ...s.doc, items: [...s.doc.items, item] }, new Set([item.id]))); set({ selected: [item.id], selectedGroups: [] });
  },
  remove: () => {
    const s = get();
    const items = s.doc.items.filter(i => !s.selected.includes(i.id)).map(i => i.groupId && s.selectedGroups.includes(i.groupId) ? { ...i, groupId: null } : i);
    s.commit({ ...s.doc, items, groups: s.doc.groups.filter(g => !s.selectedGroups.includes(g.id)) });
    set({ selected: [], selectedGroups: [] });
  },
  addAssets: (assets, point) => {
    const s = get();
    if (!s.editable || !assets.length || s.doc.items.length + assets.length > 10000) return false;
    rememberMediaAspects(assets);
    const added = assets.map((asset, index) => {
      const item = { id: crypto.randomUUID(), type: asset.kind, assetId: asset.id, title: asset.name.slice(0, 200), text: '', x: point.x + index * 336, y: point.y, width: 320, height: asset.kind === 'audio' ? 160 : 353, groupId: null };
      return asset.kind === 'image' ? mediaLayout(item) : item;
    });
    const selected = added.map(item => item.id);
    s.commit(assignMembership({ ...s.doc, items: [...s.doc.items, ...added] }, new Set(selected)));
    set({ selected, selectedGroups: [] });
    return true;
  },
  group: () => {
    const s = get(); if (s.selected.length < 2) return;
    const id = crypto.randomUUID(); const items = s.doc.items.map(i => s.selected.includes(i.id) ? { ...i, groupId: id } : i);
    s.commit({ ...s.doc, items, groups: [...s.doc.groups, { id, name: `分组 ${s.doc.groups.length + 1}`, ...groupBounds(items.filter(i => s.selected.includes(i.id))) }] });
    set({ selected: [], selectedGroups: [id] });
  },
  ungroup: () => {
    const s = get(), groups = new Set([...s.selectedGroups, ...s.doc.items.filter(i => s.selected.includes(i.id)).map(i => i.groupId).filter(id => id !== null)]);
    s.commit({ ...s.doc, items: s.doc.items.map(i => i.groupId && groups.has(i.groupId) ? { ...i, groupId: null } : i), groups: s.doc.groups.filter(g => !groups.has(g.id)) });
    set({ selectedGroups: [] });
  },
  undo: () => { get().finishEditing(); const s = get(); if (!s.editable || !s.past.length) return; set({ doc: s.past.at(-1)!, past: s.past.slice(0, -1), future: [s.doc, ...s.future], selected: [], selectedGroups: [] }); },
  redo: () => { get().finishEditing(); const s = get(); if (!s.editable || !s.future.length) return; set({ doc: s.future[0], past: [...s.past, s.doc], future: s.future.slice(1), selected: [], selectedGroups: [] }); },
}));
