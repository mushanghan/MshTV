import { useLayoutEffect, useRef, type RefObject } from 'react';
import type Konva from 'konva';
import type { CanvasItem } from '../model';
import { useAsset } from '../library';
import { PlaybackControls, PlaybackElement } from '../PlaybackControls';
import { stopPlayback, usePlayback } from '../playback';
import { MEDIA_HEIGHT_PADDING, MEDIA_INSET, MEDIA_WIDTH_PADDING } from './mediaGeometry';

const geometryEvents = 'xChange.media yChange.media offsetYChange.media scaleXChange.media scaleYChange.media widthChange.media heightChange.media';

export function CanvasPlayback({ items, nodes, panMode }: {
  items: CanvasItem[]; nodes: RefObject<Map<string, Konva.Group>>; panMode: boolean;
}) {
  const session = usePlayback(state => state.current?.key.startsWith('canvas:') ? state.current : null);
  const failed = usePlayback(state => state.phase === 'error');
  const asset = useAsset(session?.asset.id);
  const id = session?.key.slice('canvas:'.length);
  const video = session?.asset.kind === 'video';
  const present = items.some(item => item.id === id && item.assetId === session?.asset.id);
  const valid = !asset || (asset.status === 'ready' && asset.version === session?.asset.version);
  const overlay = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!session || !id) return;
    const node = nodes.current.get(id), stage = node?.getStage(), frame = overlay.current;
    if (!present || !valid || !node || !stage || !frame) { stopPlayback(session.key); return; }
    let animation = 0;
    const sync = () => {
      animation = 0;
      const scale = node.getAbsoluteScale();
      const point = node.getAbsoluteTransform().point({ x: MEDIA_INSET, y: MEDIA_INSET });
      const width = Math.max(0, node.width() - MEDIA_WIDTH_PADDING) * scale.x;
      const height = Math.max(0, node.height() - MEDIA_HEIGHT_PADDING) * scale.y;
      if (width < 80 || height < 24 || point.x + width <= 0 || point.y + height <= 0 ||
          point.x >= stage.width() || point.y >= stage.height()) {
        stopPlayback(session.key);
        return;
      }
      frame.style.transform = `translate(${point.x}px, ${point.y}px)`;
      frame.style.width = `${width}px`;
      frame.style.height = `${height}px`;
      if (video) {
        const footer = (MEDIA_HEIGHT_PADDING - MEDIA_INSET) * scale.y;
        frame.style.setProperty('--video-footer-height', `${footer}px`);
      }
    };
    const schedule = () => { if (!animation) animation = requestAnimationFrame(sync); };
    node.on(geometryEvents, schedule);
    stage.on(geometryEvents, schedule);
    sync();
    return () => {
      cancelAnimationFrame(animation);
      node.off('.media', schedule);
      stage.off('.media', schedule);
    };
  }, [id, nodes, present, session, valid, video]);
  if (!session) return null;
  return <div ref={overlay} className={`canvas-playback${video ? ' canvas-video-playback' : ''}${panMode ? ' media-pan-mode' : ''}`} data-playback-card={id}>
    {!failed && <PlaybackElement session={session} className={video ? 'canvas-video-frame' : 'audio-element'}/>}
    <PlaybackControls session={session}/>
  </div>;
}
