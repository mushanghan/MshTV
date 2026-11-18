import { useRef } from 'react';
import { Shape } from 'react-konva';
import type { NoteSpan } from '../model';
import { layoutNote, type NoteDrawRun, type NoteStyle } from './note-format';
const font = (style: NoteStyle) => `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}16px Arial`;
export function RichNoteText({ text, spans, width, height, visible, color, emphasis }: {
  text: string; spans: NoteSpan[]; width: number; height: number; visible: boolean; color: string; emphasis: string;
}) {
  const cache = useRef<{ text: string; spans: NoteSpan[]; width: number; height: number; runs: NoteDrawRun[] } | null>(null);
  return <Shape name="note-body" x={18} y={18} width={width} height={height} visible={visible} listening={false} sceneFunc={(context, shape) => {
    const w = shape.width(), h = shape.height();
    if (!cache.current || cache.current.text !== text || cache.current.spans !== spans || cache.current.width !== w || cache.current.height !== h) {
      const runs = layoutNote(text, spans, w, h, (value, style) => { context.font = font(style); return context.measureText(value).width; });
      cache.current = { text, spans, width: w, height: h, runs };
    }
    context.save(); context.beginPath(); context.rect(0, 0, w, h); context.clip(); context.textBaseline = 'middle';
    for (const run of cache.current.runs) {
      const ink = run.style.red ? emphasis : color;
      context.font = font(run.style); context.fillStyle = ink;
      context.fillText(run.text, run.x, run.y + 12.4);
      if (run.style.underline) { context.beginPath(); context.strokeStyle = ink; context.lineWidth = 1; context.moveTo(run.x, run.y + 20); context.lineTo(run.x + run.width, run.y + 20); context.stroke(); }
    }
    context.restore();
  }}/>;
}
