import { expect, it } from 'vitest';
import { fromNoteDocument, layoutNote, plainStyle, toNoteDocument } from './note-format';
import type { NoteSpan } from '../model';

it('round trips plain legacy notes, empty lines and UTF-16 style offsets', () => {
  const text = '普通\n😀重点\n\n结尾';
  const noteSpans: NoteSpan[] = [{ from: 3, to: 7, bold: true, italic: true, underline: true, red: true }];
  expect(fromNoteDocument(toNoteDocument(text, noteSpans))).toEqual({ text, noteSpans });
  expect(fromNoteDocument(toNoteDocument('旧备注\n'))).toEqual({ text: '旧备注\n', noteSpans: [] });
});
it('flattens paragraphs and keeps only permitted emphasis rather than HTML or arbitrary marks', () => {
  expect(fromNoteDocument({ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: '<script>hello</script>', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] },
    { type: 'paragraph', content: [{ type: 'text', text: '强调', marks: [{ type: 'red' }, { type: 'underline' }] }] },
  ] })).toEqual({ text: '<script>hello</script>\n强调', noteSpans: [{ from: 23, to: 25, bold: false, italic: false, underline: true, red: true }] });
});
it('merges adjacent equivalent styles without changing plain gaps', () => {
  expect(fromNoteDocument({ type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: 'a', marks: [{ type: 'bold' }] }, { type: 'text', text: 'b', marks: [{ type: 'bold' }] }, { type: 'text', text: 'c' },
  ] }] }).noteSpans).toEqual([{ from: 0, to: 2, ...plainStyle, bold: true }]);
});
it('wraps rich notes using real style widths while retaining graphemes and fixed line height', () => {
  const spans: NoteSpan[] = [{ from: 0, to: 2, ...plainStyle, bold: true }];
  const runs = layoutNote('ab😀c\nd', spans, 22, 100, (_, style) => style.bold ? 12 : 10);
  expect(runs.map(r => r.text).join('')).toBe('ab😀cd');
  expect(runs.find(r => r.text.includes('😀'))?.y).toBe(24.8);
  expect(runs.every(r => r.x + r.width <= 22)).toBe(true);
  expect(runs.at(-1)?.y).toBeCloseTo(74.4);
});
