import { Extension, Mark } from '@tiptap/core';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import HardBreak from '@tiptap/extension-hard-break';
import Bold from '@tiptap/extension-bold';
import Italic from '@tiptap/extension-italic';
import Underline from '@tiptap/extension-underline';
import { UndoRedo } from '@tiptap/extensions/undo-redo';
import { Plugin } from '@tiptap/pm/state';
import { Bold as BoldIcon, Italic as ItalicIcon, Underline as UnderlineIcon, Eraser } from 'lucide-react';
import { useRef, type CSSProperties } from 'react';
import { saveBoard } from '../api';
import { useCanvas } from '../store';
import type { CanvasItem } from '../model';
import { fromNoteDocument, NOTE_RED, toNoteDocument } from './note-format';

const Red = Mark.create({
  name: 'red',
  parseHTML: () => [{ tag: 'span[data-note-red]' }, { style: 'color', getAttrs: value => value === NOTE_RED || value === 'rgb(240, 120, 120)' ? {} : false }],
  renderHTML: () => ['span', { 'data-note-red': 'true', style: `color:var(--note-emphasis,${NOTE_RED})` }, 0],
});
const Limits = Extension.create({
  name: 'noteLimits',
  addProseMirrorPlugins: () => [new Plugin({ filterTransaction: transaction => {
    if (!transaction.docChanged) return true;
    const note = fromNoteDocument(transaction.doc.toJSON());
    return note.text.length <= 10000 && note.noteSpans.length <= 2000;
  } })],
});

export function NoteEditor({ item, style }: { item: CanvasItem; style: CSSProperties }) {
  const root = useRef<HTMLDivElement>(null);
  const scale = useCanvas(s => s.camera.scale);
  const editor = useEditor({
    extensions: [Document, Paragraph, Text, HardBreak, Bold, Italic, Underline, Red, UndoRedo.configure({ depth: 60 }), Limits],
    content: toNoteDocument(item.text, item.noteSpans ?? []), autofocus: 'end',
    editorProps: {
      attributes: { role: 'textbox', 'aria-label': '备注内容', 'aria-multiline': 'true', class: 'note-rich-editor', spellcheck: 'false' },
      handleKeyDown: (view, event) => {
        const mod = event.ctrlKey || event.metaKey;
        // Let the IME handle ordinary candidate keys; suppress modified editor commands until composition ends.
        if (view.composing || event.isComposing || event.keyCode === 229) return mod;
        if (event.key === 'Escape') { event.preventDefault(); useCanvas.getState().finishEditing(true); return true; }
        if (event.key === 'Enter' && mod) { event.preventDefault(); useCanvas.getState().finishEditing(); return true; }
        if (mod && event.key.toLowerCase() === 's') { event.preventDefault(); useCanvas.getState().finishEditing(); void saveBoard(); return true; }
        return false;
      },
    },
    onUpdate: ({ editor: current }) => {
      const note = fromNoteDocument(current.getJSON());
      useCanvas.getState().updateNote(note.text, note.noteSpans);
    },
  }, [item.id]);
  const active = useEditorState({ editor, selector: context => ({ bold: context.editor?.isActive('bold') ?? false, italic: context.editor?.isActive('italic') ?? false, underline: context.editor?.isActive('underline') ?? false, red: context.editor?.isActive('red') ?? false }) });
  return <div ref={root} style={style} className="inline-editor inline-note" onKeyDown={event => event.stopPropagation()} onBlurCapture={event => {
    if (!root.current?.contains(event.relatedTarget as Node | null)) useCanvas.getState().finishEditing();
  }}>
    <div className="note-format-toolbar" role="toolbar" aria-label="备注文字样式" style={{ top: Number(style.top) < 48 ? Number(style.height) + 8 / scale : -42 / scale, left: -3 / scale, transform: `scale(${1 / scale})`, transformOrigin: 'top left' }}>
      <button type="button" aria-label="加粗" title="加粗 (Ctrl+B)" aria-pressed={active?.bold} onMouseDown={e => e.preventDefault()} onClick={() => editor?.chain().focus().toggleBold().run()}><BoldIcon size={15}/></button>
      <button type="button" aria-label="斜体" title="斜体 (Ctrl+I)" aria-pressed={active?.italic} onMouseDown={e => e.preventDefault()} onClick={() => editor?.chain().focus().toggleItalic().run()}><ItalicIcon size={15}/></button>
      <button type="button" aria-label="下划线" title="下划线 (Ctrl+U)" aria-pressed={active?.underline} onMouseDown={e => e.preventDefault()} onClick={() => editor?.chain().focus().toggleUnderline().run()}><UnderlineIcon size={15}/></button>
      <button type="button" aria-label="标红" title="标红" aria-pressed={active?.red} onMouseDown={e => e.preventDefault()} onClick={() => editor?.chain().focus().toggleMark('red').run()}><span className="note-red-icon">A</span></button>
      <span className="format-divider"/>
      <button type="button" aria-label="清除格式" title="清除选中文字的格式" onMouseDown={e => e.preventDefault()} onClick={() => editor?.chain().focus().unsetAllMarks().run()}><Eraser size={15}/></button>
    </div>
    <EditorContent editor={editor} className="note-editor-content"/>
  </div>;
}
