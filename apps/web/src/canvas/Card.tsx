import { memo, useEffect } from 'react';
import { Group, Rect, Text, Image as CanvasImage, Line, Circle } from 'react-konva';
import type Konva from 'konva';
import { samples, type CanvasItem } from '../model';
import { RichNoteText } from './RichNoteText';
import { duration, mediaUrl, statusLabel, useAsset, useMediaPreview, type Asset } from '../library';
import { togglePlayback, usePlayback } from '../playback';
import { useThumbnail } from './useThumbnail';
import { MEDIA_HEIGHT_PADDING, MEDIA_INSET, rememberMediaFrame } from './mediaGeometry';
import type { CanvasPalette } from '../theme';
import { SelectionLight, useSelectionLift } from './SelectionLight';
interface Props {
  item: CanvasItem; palette: CanvasPalette; largeCorners: boolean; selected: boolean; draggable: boolean; editing: boolean; sharpPreview: boolean; mediaInteractive: boolean;
  performanceMode: boolean; animateSelection: boolean;
  register: (id: string, node: Konva.Group | null) => void;
  onDown: (id: string, event: Konva.KonvaEventObject<MouseEvent>) => void;
  onDragStart: (id: string) => void; onDragMove: (id: string) => void; onDragEnd: (id: string) => void; onEdit: (id: string, field: 'text' | 'title') => void;
}
export const Card = memo(function Card({ item, palette, largeCorners, selected, performanceMode, animateSelection, draggable, editing, sharpPreview, mediaInteractive, register, onDown, onDragStart, onDragMove, onDragEnd, onEdit }: Props) {
  const floating = selected && !performanceMode;
  const outlined = selected && performanceMode;
  const radius = largeCorners ? 16 : 7;
  const groupRef = useSelectionLift(floating && !editing, animateSelection && !editing);
  const sample = samples.find(s => s.id === item.assetId);
  const asset = useAsset(item.assetId);
  const ready = asset?.status === 'ready';
  const thumbnail = useThumbnail(sample?.url ?? (ready && asset.hasThumbnail ? mediaUrl(asset, 'thumb') : undefined));
  const previewUrl = sharpPreview && ready && asset.kind !== 'audio' && asset.hasPreview ? mediaUrl(asset, 'preview') : undefined;
  const preview = useThumbnail(previewUrl, false);
  const image = (previewUrl ? preview : undefined) ?? thumbnail;
  useEffect(() => {
    if (image && (asset?.kind === 'image' || asset?.kind === 'video'))
      rememberMediaFrame(asset, image.naturalWidth, image.naturalHeight, asset.kind === 'image' && image === preview ? 'preview' : 'cover');
  }, [asset, image, preview]);
  const w = item.width, h = item.height, note = item.type === 'note';
  const mediaBox = { x: MEDIA_INSET, y: MEDIA_INSET, width: w - 2 * MEDIA_INSET, height: h - MEDIA_HEIGHT_PADDING };
  const mediaRadius = item.type === 'image' ? radius - MEDIA_INSET : 0;
  const imageScale = image ? Math.min(mediaBox.width / image.width, mediaBox.height / image.height) : 0;
  const imageWidth = (image?.width ?? 0) * imageScale, imageHeight = (image?.height ?? 0) * imageScale;
  const playVideo = (event: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    if (item.type !== 'video' || !mediaInteractive || !ready || event.evt.ctrlKey || event.evt.metaKey) return;
    if ('button' in event.evt && event.evt.button !== 0) return;
    const point = event.currentTarget.getRelativePointerPosition();
    if (point && point.x >= MEDIA_INSET && point.x <= w - MEDIA_INSET &&
      point.y >= MEDIA_INSET && point.y <= MEDIA_INSET + h - MEDIA_HEIGHT_PADDING) {
      togglePlayback(`canvas:${item.id}`, asset);
    }
  };
  const resizeNote = (event: Konva.KonvaEventObject<Event>) => {
    if (!note) return;
    const node = event.currentTarget as Konva.Group;
    const width = Math.max(40, node.width() * node.scaleX());
    const height = Math.max(40, node.height() * node.scaleY());
    // Resize the note's layout during the gesture, so glyphs never inherit the transformer scale.
    // This is transient Konva state; persist one operation when the transform ends.
    const y = node.y() + node.offsetY() * (1 - node.scaleY());
    node.setAttrs({ width, height, y, scaleX: 1, scaleY: 1 });
    node.findOne<Konva.Rect>('.card-background')?.size({ width, height });
    node.findOne<Konva.Text>('.note-body')?.size({ width: Math.max(1, width - 36), height: Math.max(1, height - 36) });
  };
  return <Group id={item.id} ref={node => { groupRef.current = node; register(item.id, node); }} x={item.x} y={item.y} width={w} height={h} draggable={draggable}
    onMouseDown={e => onDown(item.id, e)}
    onClick={playVideo} onTap={playVideo}
    onDblClick={e => {
      if (e.evt.ctrlKey || e.evt.metaKey || e.evt.button !== 0) return;
      const p = e.currentTarget.getRelativePointerPosition();
      if (note && p && p.x >= 18 && p.y >= 18 && p.x <= w - 18 && p.y <= h - 18) onEdit(item.id, 'text');
      else if (asset && (item.type !== 'video' || !ready) && p && p.y < h - 40) useMediaPreview.getState().open(asset.id);
    }}
    onDragStart={() => onDragStart(item.id)} onDragMove={() => onDragMove(item.id)} onDragEnd={() => onDragEnd(item.id)} onTransform={resizeNote}>
    {floating && <SelectionLight steady={editing} radius={radius} glow={palette.selectionGlow}/>}
    <Rect name="card-background" width={w} height={h} fill={note ? palette.note : palette.card} cornerRadius={radius} stroke={outlined ? palette.selected : note ? palette.noteBorder : palette.cardBorder} strokeWidth={outlined ? 2 : 1}
      shadowEnabled={(palette.elevation && largeCorners) || floating} shadowForStrokeEnabled={false} shadowColor="#232730" shadowOpacity={floating ? .13 : .17}
      shadowBlur={floating ? 16 : 13} shadowOffsetY={floating ? 7 : 5}/>
    {note ? <>
      {item.noteSpans?.length ? <RichNoteText text={item.text} spans={item.noteSpans} width={Math.max(1, w - 36)} height={Math.max(1, h - 36)} visible={!editing} color={palette.noteText} emphasis={palette.noteEmphasis}/> : <Text name="note-body" x={18} y={18} width={Math.max(1, w - 36)} height={Math.max(1, h - 36)} text={item.text || '双击输入备注…'} fontSize={16} lineHeight={1.55} fill={item.text ? palette.noteText : palette.noteHint} wrap="word" ellipsis listening={false} visible={!editing}/>}
    </> : <>
      {image ? <CanvasImage x={mediaBox.x + (mediaBox.width - imageWidth) / 2} y={mediaBox.y + (mediaBox.height - imageHeight) / 2}
        width={imageWidth} height={imageHeight} image={image} cornerRadius={mediaRadius} listening={false}/>
        : <Rect {...mediaBox} cornerRadius={mediaRadius} fill={item.type === 'audio' ? palette.audioPlaceholder : palette.stillPlaceholder} listening={false}/>}
      {(item.type === 'video' || item.type === 'audio' && ready) &&
        <MediaPlayButton item={item} asset={asset} interactive={mediaInteractive} palette={palette}/>}
      {item.type === 'audio' && !item.assetId && Array.from({ length: 24 }, (_, n) => <Rect key={n} x={w * .15 + n * w * .029} y={(h - 40) / 2 - (8 + Math.sin(n * 1.6) ** 2 * 24)} width={Math.max(2, w * .01)} height={16 + Math.sin(n * 1.6) ** 2 * 48} fill={palette.audioWave} cornerRadius={2} listening={false}/>)}
      <Text x={13} y={h - 27} width={Math.max(1, w - 70)} height={20} text={item.title || '未命名'} fill={palette.cardTitle} fontSize={12} ellipsis wrap="none" visible={!editing}
        onDblClick={e => { e.cancelBubble = true; if (!e.evt.ctrlKey && !e.evt.metaKey && e.evt.button === 0) onEdit(item.id, 'title'); }}/>
      {asset && asset.status !== 'ready' && <><Rect {...mediaBox} cornerRadius={mediaRadius} fill={palette.previewMask} listening={false}/><Text x={14} y={Math.max(12, (h - 47) / 2)} width={w - 28} align="center" text={statusLabel(asset.status)} fill={palette.previewWarning} fontSize={12} listening={false}/></>}
      {ready && asset.kind === 'image' && !image && asset.error && <Text x={14} y={Math.max(12, (h - 47) / 2)} width={w - 28} align="center" text="暂无图片预览，双击查看" fill={palette.previewWarning} fontSize={12} listening={false}/>}
      <Text x={w - 49} y={h - 26} width={38} align="right" text={asset ? asset.kind !== 'image' && asset.duration != null ? duration(asset.duration) : asset.extension.slice(1).toUpperCase() : item.type === 'image' ? '示例' : '占位'} fill={palette.cardMeta} fontSize={10} listening={false}/>
    </>}
  </Group>;
});

function MediaPlayButton({ item, asset, interactive, palette }: { item: CanvasItem; asset?: Asset; interactive: boolean; palette: CanvasPalette }) {
  const key = `canvas:${item.id}`;
  const active = usePlayback(state => state.current?.key === key);
  const enabled = item.type === 'audio' && interactive && asset?.status === 'ready';
  const stop = (event: Konva.KonvaEventObject<Event>) => { event.cancelBubble = true; };
  const play = (event: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    if (event.evt.ctrlKey || event.evt.metaKey || ('button' in event.evt && event.evt.button !== 0)) return;
    stop(event);
    if (asset) togglePlayback(key, asset);
  };
  if (active) return null;
  return <Group name="media-play" x={item.width / 2} y={(item.height - 40) / 2} listening={enabled}
    onMouseDown={event => { if (!event.evt.ctrlKey && !event.evt.metaKey && event.evt.button === 0) stop(event); }}
    onTouchStart={stop} onClick={play} onTap={play} onDblClick={stop}>
    <Circle radius={23} fill={palette.playBackground}/>
    <Line points={[-5, -9, 9, 0, -5, 9]} closed fill={palette.playIcon} listening={false}/>
  </Group>;
}
