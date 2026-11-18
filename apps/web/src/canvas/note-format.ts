import type { JSONContent } from '@tiptap/core';
import type { NoteSpan } from '../model';
export const NOTE_RED = '#f07878';
export const plainStyle = { bold: false, italic: false, underline: false, red: false };
export type NoteStyle = typeof plainStyle;
const sameStyle = (a: NoteStyle, b: NoteStyle) => a.bold === b.bold && a.italic === b.italic && a.underline === b.underline && a.red === b.red;

export function noteRuns(text: string, spans: NoteSpan[] = []) {
  const runs: { text: string; style: NoteStyle }[] = []; let offset = 0;
  for (const span of spans) {
    if (span.from > offset) runs.push({ text: text.slice(offset, span.from), style: plainStyle });
    runs.push({ text: text.slice(span.from, span.to), style: span }); offset = span.to;
  }
  if (offset < text.length) runs.push({ text: text.slice(offset), style: plainStyle });
  return runs;
}

export function toNoteDocument(text: string, spans: NoteSpan[] = []): JSONContent {
  const content: JSONContent[] = [];
  for (const run of noteRuns(text, spans)) {
    const marks = (['bold', 'italic', 'underline', 'red'] as const).filter(key => run.style[key]).map(type => ({ type }));
    run.text.split('\n').forEach((part, index) => {
      if (index) content.push({ type: 'hardBreak' });
      if (part) content.push({ type: 'text', text: part, marks });
    });
  }
  return { type: 'doc', content: [{ type: 'paragraph', content }] };
}

export function fromNoteDocument(doc: JSONContent): { text: string; noteSpans: NoteSpan[] } {
  let text = ''; const noteSpans: NoteSpan[] = [];
  function append(node: JSONContent) {
    if (node.type === 'hardBreak') { text += '\n'; return; }
    if (node.type === 'text') {
      const from = text.length; text += node.text ?? '';
      const marks = new Set(node.marks?.map(mark => mark.type));
      const style = { bold: marks.has('bold'), italic: marks.has('italic'), underline: marks.has('underline'), red: marks.has('red') };
      if (text.length > from && Object.values(style).some(Boolean)) {
        const previous = noteSpans.at(-1);
        if (previous && previous.to === from && sameStyle(previous, style)) previous.to = text.length;
        else noteSpans.push({ from, to: text.length, ...style });
      }
      return;
    }
    node.content?.forEach(append);
  }
  doc.content?.forEach((block, index) => { if (index) text += '\n'; append(block); });
  return { text, noteSpans };
}

export interface NoteDrawRun { text: string; x: number; y: number; width: number; style: NoteStyle }
export function layoutNote(text: string, spans: NoteSpan[], width: number, height: number, measure: (text: string, style: NoteStyle) => number): NoteDrawRun[] {
  const glyphs: { text: string; style: NoteStyle }[] = [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const run of noteRuns(text, spans)) for (const entry of segmenter.segment(run.text)) glyphs.push({ text: entry.segment, style: run.style });
  const result: NoteDrawRun[] = []; let x = 0, y = 0;
  for (let i = 0; i < glyphs.length; i++) {
    const glyph = glyphs[i];
    if (glyph.text === '\n' || glyph.text === '\r\n') { x = 0; y += 24.8; continue; }
    if (y >= height) break;
    // Move an ordinary Latin word to the next line if it fits there, while allowing long words to break.
    if (/[A-Za-z0-9]/.test(glyph.text) && (i === 0 || !/[A-Za-z0-9]/.test(glyphs[i - 1].text))) {
      let wordWidth = 0;
      for (let n = i; n < glyphs.length && /^[A-Za-z0-9_'’-]$/.test(glyphs[n].text); n++) wordWidth += measure(glyphs[n].text, glyphs[n].style);
      if (x > 0 && wordWidth <= width && x + wordWidth > width) { x = 0; y += 24.8; }
    }
    const glyphWidth = measure(glyph.text, glyph.style);
    if (x > 0 && x + glyphWidth > width) { x = 0; y += 24.8; }
    if (y >= height) break;
    const previous = result.at(-1);
    if (previous && previous.y === y && sameStyle(previous.style, glyph.style)) { previous.text += glyph.text; previous.width += glyphWidth; }
    else result.push({ text: glyph.text, x, y, width: glyphWidth, style: glyph.style });
    x += glyphWidth;
  }
  return result;
}
