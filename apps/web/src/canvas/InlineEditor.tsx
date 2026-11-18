import { lazy, Suspense, useEffect, useLayoutEffect, useRef } from 'react';
import { saveBoard } from '../api';
import { useCanvas } from '../store';
import { groupNameLimit, type CanvasGroup, type CanvasItem } from '../model';
import type { CanvasPalette } from '../theme';
import { groupTitleBounds } from './groups';
const NoteEditor = lazy(() => import('./NoteEditor').then(module => ({ default: module.NoteEditor })));

export function InlineEditor({ items, groups, palette }: { items: CanvasItem[]; groups: CanvasGroup[]; palette: CanvasPalette }) {
  const edit = useCanvas(s => s.editing), camera = useCanvas(s => s.camera), editable = useCanvas(s => s.editable);
  const input = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const composing = useRef(false);
  const group = edit?.field === 'name' ? groups.find(group => group.id === edit.id) : undefined;
  const item = edit && edit.field !== 'name' ? items.find(item => item.id === edit.id) : undefined;
  useLayoutEffect(() => {
    const node = input.current; if (!node || !edit) return;
    composing.current = false;
    node.focus({ preventScroll: true });
    if (edit.field !== 'text') node.select();
    else node.setSelectionRange(node.value.length, node.value.length);
  }, [edit?.id, edit?.field]);
  useEffect(() => { if (!editable) useCanvas.getState().finishEditing(); }, [editable]);
  const target = group ?? item;
  if (!edit || !target) return null;
  const note = edit.field === 'text';
  const layout = group ? groupTitleBounds(group.width) : {
    x: note ? 18 : 13,
    y: note ? 18 : target.height - 27,
    width: Math.max(1, target.width - (note ? 36 : 70)),
    height: note ? Math.max(1, target.height - 36) : 24,
  };
  const style = {
    left: camera.x + (target.x + layout.x) * camera.scale,
    top: camera.y + (target.y + layout.y) * camera.scale,
    width: layout.width, height: layout.height,
    transform: `scale(${camera.scale})`,
    ...(group && { background: palette.group, color: palette.groupTitle }),
  };
  const shared = {
    value: edit.field === 'name' ? edit.draft : (item?.[edit.field] ?? ''),
    style, className: `inline-editor ${note ? 'inline-note' : 'inline-title'}`,
    maxLength: group ? groupNameLimit : note ? 10000 : 200, spellCheck: false,
    'aria-label': group ? '画布分组名称' : note ? '备注内容' : '素材名称',
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => useCanvas.getState().updateEditing(event.target.value),
    onBlur: () => useCanvas.getState().finishEditing(),
    onCompositionStart: () => { composing.current = true; }, onCompositionEnd: () => { composing.current = false; },
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      event.stopPropagation();
      if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
      const mod = event.ctrlKey || event.metaKey;
      if (event.key === 'Escape') { event.preventDefault(); useCanvas.getState().finishEditing(true); }
      else if (event.key === 'Enter' && (!note || mod)) { event.preventDefault(); useCanvas.getState().finishEditing(); }
      else if (mod && event.key.toLowerCase() === 's') { event.preventDefault(); useCanvas.getState().finishEditing(); void saveBoard(); }
    },
  };
  return note && item ? <Suspense fallback={<div style={style} className="inline-editor inline-note" role="status">正在加载编辑器…</div>}><NoteEditor key={item.id} item={item} style={style}/></Suspense> : <input {...shared} ref={node => { input.current = node; }}/>;
}
