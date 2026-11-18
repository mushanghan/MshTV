import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Konva from 'konva';
import { Stage, Layer, Rect, Transformer } from 'react-konva';
import RBush from 'rbush';
import { useCanvas, type EditingTarget } from '../store';
import { usePerformanceMode } from '../PerformanceMode';
import { fitCamera, toWorld, zoomAt } from './geometry';
import { Card } from './Card';
import { GroupBoard } from './GroupBoard';
import { InlineEditor } from './InlineEditor';
import { assignMembership } from './groups';
import { samples, type Point } from '../model';
import { request } from '../api';
import { ASSET_DRAG_TYPE, cacheAssets, type Asset } from '../library';
import { useLocalFileDrop } from './useLocalFileDrop';
import { THUMBNAIL_CACHE_LIMIT } from './useThumbnail';
import { CanvasPlayback } from './CanvasPlayback';
import { useMediaGeometry, mediaLayout } from './mediaGeometry';
import { scrollPans, useCanvasNavigation, useScrollMode } from './useCanvasNavigation';
import { useCanvasPalette } from '../theme';
import { SelectionHdrLayer } from './SelectionHdrLayer';
Konva.pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
Konva.dragButtons = [0]; // The middle button pans the canvas even when pressed over a card.
export function Canvas() {
  const palette = useCanvasPalette();
  const host = useRef<HTMLDivElement>(null), stage = useRef<Konva.Stage>(null), transformer = useRef<Konva.Transformer>(null);
  const scene = useRef<Konva.Layer>(null);
  const groupTransformer = useRef<Konva.Transformer>(null), groupNodes = useRef(new Map<string, Konva.Group>());
  const groupDragging = useRef<{ id: string; x: number; y: number; members: Map<string, Point> } | null>(null);
  const nodes = useRef(new Map<string, Konva.Group>()), gesture = useRef<{ kind: 'pan' | 'box'; start: Point; origin: Point; additive: boolean } | null>(null);
  const dragging = useRef(new Map<string, Point>());
  const [size, setSize] = useState({ width: 1, height: 1 }), [space, setSpace] = useState(false), [box, setBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const editing = useCanvas(s => s.editing);
  const performanceMode = usePerformanceMode(state => state.mode?.enabled ?? false);
  const viewPadding = performanceMode ? 96 : 300;
  const [dropStatus, setDropStatus] = useState('');
  useLocalFileDrop(host, setDropStatus);
  const panWithScroll = scrollPans(useScrollMode(s => s.mode));
  useCanvasNavigation(host, panWithScroll);
  const doc = useCanvas(s => s.doc), selected = useCanvas(s => s.selected), camera = useCanvas(s => s.camera), tool = useCanvas(s => s.tool), editable = useCanvas(s => s.editable);
  const largeCorners = !performanceMode && camera.scale >= .35;
  const selectedGroups = useCanvas(s => s.selectedGroups);
  const animateSelection = !performanceMode && selected.length + selectedGroups.length <= 24;
  const resizeHandles = {
    borderEnabled: performanceMode,
    anchorStroke: performanceMode ? palette.anchor : 'transparent',
    anchorFill: performanceMode ? palette.anchorFill : 'transparent',
    anchorStrokeWidth: performanceMode ? 1 : 0,
    anchorSize: performanceMode ? 8 : camera.scale >= .35 ? 15 : 10,
  };
  const singleGroup = selectedGroups.length === 1 ? selectedGroups[0] : undefined;
  const panMode = tool === 'hand' || space;
  const mediaRevision = useMediaGeometry();
  const layoutItems = useMemo(() => doc.items.map(mediaLayout), [doc.items, mediaRevision]);
  const selectedIds = useMemo(() => new Set(selected), [selected]);
  const freeResize = useMemo(() => selectedIds.size > 0 && doc.items.every(i => !selectedIds.has(i.id) || i.type === 'note'), [doc.items, selectedIds]);
  useEffect(() => {
    const observer = new ResizeObserver(entries => { const { width, height } = entries[0].contentRect; setSize({ width, height }); });
    observer.observe(host.current!); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if ((e.target as HTMLElement).closest('input,textarea,select,[contenteditable=true]') || editing || document.querySelector('.modal-backdrop')) return; if (e.code === 'Space') { e.preventDefault(); setSpace(true); } };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') setSpace(false); };
    const blur = () => { setSpace(false); gesture.current = null; setBox(null); };
    const release = () => { gesture.current = null; setBox(null); };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', blur); window.addEventListener('mouseup', release);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); window.removeEventListener('mouseup', release); };
  }, [editing]);
  const index = useMemo(() => {
    const tree = new RBush<{ minX: number; minY: number; maxX: number; maxY: number; id: string }>();
    tree.load(layoutItems.map(i => ({ minX: i.x, minY: i.y, maxX: i.x + i.width, maxY: i.y + i.height, id: i.id }))); return tree;
  }, [layoutItems]);
  const visible = useMemo(() => {
    const p = toWorld({ x: -viewPadding, y: -viewPadding }, camera);
    const q = toWorld({ x: size.width + viewPadding, y: size.height + viewPadding }, camera);
    const ids = new Set(index.search({ minX: p.x, minY: p.y, maxX: q.x, maxY: q.y }).map(i => i.id));
    return layoutItems.filter(i => ids.has(i.id) || selectedIds.has(i.id));
  }, [index, camera, size, viewPadding, layoutItems, selectedIds]);
  const detailed = useMemo(() => visible.slice(0, 800), [visible]);
  const sharpImages = useMemo(() => {
    // A 2048px RGBA preview can decode to 16 MiB. Reserve space for the thumbnail cache and detail nodes.
    const budget = window.matchMedia('(pointer: coarse)').matches ? 96 : 256;
    const slots = Math.max(0, Math.min(2, Math.floor((budget - (detailed.length + THUMBNAIL_CACHE_LIMIT) / 4) / 16)));
    if (!slots) return new Set<string>();
    const { x, y, scale } = camera;
    const candidates = detailed.filter(item => item.type === 'image' && item.assetId && !samples.some(sample => sample.id === item.assetId)).map(item => {
      const left = x + (item.x + 7) * scale, top = y + (item.y + 7) * scale;
      const width = (item.width - 14) * scale, height = (item.height - 47) * scale;
      const visibleWidth = Math.min(size.width, left + width) - Math.max(0, left);
      const visibleHeight = Math.min(size.height, top + height) - Math.max(0, top);
      return { id: item.id, edge: Math.max(width, height) * Konva.pixelRatio,
        area: Math.max(0, visibleWidth) * Math.max(0, visibleHeight), selected: selectedIds.has(item.id) };
    }).filter(item => item.edge > 256 && item.area > 0);
    candidates.sort((a, b) => Number(b.selected) - Number(a.selected) || b.area - a.area);
    return new Set(candidates.slice(0, slots).map(item => item.id));
  }, [camera, detailed, selectedIds, size]);
  const sharpVideos = useMemo(() => {
    // A 1024px cover takes at most 4 MiB. Image previews keep their existing allocation.
    const budget = window.matchMedia('(pointer: coarse)').matches ? 96 : 256;
    const slots = Math.max(0, Math.min(4, Math.floor((budget - (detailed.length + THUMBNAIL_CACHE_LIMIT) / 4 - 16 * sharpImages.size) / 4)));
    const p = toWorld({ x: 0, y: 0 }, camera), q = toWorld({ x: size.width, y: size.height }, camera);
    const cards = detailed.filter(item => item.type === 'video' && item.assetId &&
      Math.max(item.width - 14, item.height - 47) * camera.scale * Konva.pixelRatio > 256 &&
      item.x < q.x && item.x + item.width > p.x && item.y < q.y && item.y + item.height > p.y);
    cards.sort((a, b) => Number(selectedIds.has(b.id)) - Number(selectedIds.has(a.id)));
    return new Set(cards.slice(0, slots).map(item => item.id));
  }, [camera, detailed, selectedIds, sharpImages, size]);
  const register = useCallback((id: string, node: Konva.Group | null) => { if (node) nodes.current.set(id, node); else nodes.current.delete(id); }, []);
  const registerGroup = useCallback((id: string, node: Konva.Group | null) => { if (node) groupNodes.current.set(id, node); else groupNodes.current.delete(id); }, []);
  useEffect(() => { transformer.current?.nodes(selected.map(id => nodes.current.get(id)).filter((n): n is Konva.Group => !!n)); }, [selected, doc, detailed.length]);
  useEffect(() => { const node = singleGroup && groupNodes.current.get(singleGroup); groupTransformer.current?.nodes(node ? [node] : []); }, [singleGroup, doc]);
  const onDown = useCallback((id: string, e: Konva.KonvaEventObject<MouseEvent>) => {
    if (useCanvas.getState().tool === 'hand' || e.evt.button !== 0 || e.evt.getModifierState(' ') || space) return;
    e.cancelBubble = true; const s = useCanvas.getState(), ids = [id];
    if (e.evt.ctrlKey || e.evt.metaKey) s.select(ids.every(x => s.selected.includes(x)) ? s.selected.filter(x => !ids.includes(x)) : [...new Set([...s.selected, ...ids])], s.selectedGroups);
    else if (!s.selected.includes(id) || s.selectedGroups.length) s.select(ids);
  }, [space]);
  const onDragStart = useCallback((id: string) => {
    const s = useCanvas.getState(); if (!s.selected.includes(id)) s.select([id]);
    const selection = new Set(useCanvas.getState().selected);
    dragging.current = new Map(s.doc.items.filter(item => selection.has(item.id)).map(item => [item.id, { x: item.x, y: item.y }]));
  }, []);
  const onDragMove = useCallback((id: string) => {
    const main = nodes.current.get(id), original = dragging.current.get(id); if (!main || !original) return;
    const dx = main.x() - original.x, dy = main.y() - original.y;
    dragging.current.forEach((p, key) => { if (key !== id) nodes.current.get(key)?.position({ x: p.x + dx, y: p.y + dy }); });
  }, []);
  const onDragEnd = useCallback(() => {
    const s = useCanvas.getState();
    const next = { ...s.doc, items: s.doc.items.map(i => { const n = dragging.current.has(i.id) && nodes.current.get(i.id); return n ? { ...i, x: n.x(), y: n.y() } : i; }) };
    s.commit(assignMembership(next, new Set(dragging.current.keys()))); dragging.current.clear();
  }, []);
  const onEdit = useCallback((id: string, field: EditingTarget['field']) => {
    const s = useCanvas.getState(); if (space || s.tool === 'hand' || !s.editable) return;
    s.beginEditing({ id, field });
  }, [space]);
  const onGroupDown = useCallback((id: string, e: Konva.KonvaEventObject<MouseEvent>) => {
    if (useCanvas.getState().tool === 'hand' || space || e.evt.button !== 0) return;
    e.cancelBubble = true; useCanvas.getState().selectGroup(id, e.evt.ctrlKey || e.evt.metaKey);
  }, [space]);
  const onGroupDragStart = useCallback((id: string) => {
    const s = useCanvas.getState(), group = s.doc.groups.find(g => g.id === id)!;
    s.selectGroup(id);
    groupDragging.current = { id, x: group.x, y: group.y, members: new Map(s.doc.items.filter(i => i.groupId === id).map(i => [i.id, { x: i.x, y: i.y }])) };
  }, []);
  const onGroupDragMove = useCallback((id: string) => {
    const start = groupDragging.current, node = groupNodes.current.get(id); if (!start || !node) return;
    const dx = node.x() - start.x, dy = node.y() - start.y;
    start.members.forEach((p, key) => nodes.current.get(key)?.position({ x: p.x + dx, y: p.y + dy }));
  }, []);
  const onGroupDragEnd = useCallback((id: string) => {
    const start = groupDragging.current, node = groupNodes.current.get(id); if (!start || !node) return;
    const dx = node.x() - start.x, dy = node.y() - start.y, s = useCanvas.getState();
    s.commit({ ...s.doc, groups: s.doc.groups.map(g => g.id === id ? { ...g, x: node.x(), y: node.y() } : g), items: s.doc.items.map(i => {
      const p = start.members.get(i.id); return p ? { ...i, x: p.x + dx, y: p.y + dy } : i;
    }) }); groupDragging.current = null;
  }, []);
  const onGroupTransformEnd = () => {
    const s = useCanvas.getState(), id = s.selectedGroups[0];
    const node = s.selectedGroups.length === 1 ? groupNodes.current.get(id) : undefined;
    if (!node) return;
    const next = { ...s.doc, groups: s.doc.groups.map(g => g.id === id ? { ...g, x: node.x(), y: node.y(), width: node.width(), height: node.height() } : g) };
    // Resizing the board changes containment, never the card geometry.
    s.commit(assignMembership(next, new Set(s.doc.items.filter(i => i.groupId === id || i.groupId === null).map(i => i.id))));
  };
  const pointerDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
    const p = stage.current!.getPointerPosition()!;
    if (panMode || e.evt.button === 1) { e.evt.preventDefault(); gesture.current = { kind: 'pan', start: p, origin: camera, additive: false }; return; }
    if (e.target !== stage.current || e.evt.button !== 0) return;
    const additive = e.evt.ctrlKey || e.evt.metaKey;
    gesture.current = { kind: 'box', start: toWorld(p, camera), origin: p, additive };
    if (!additive) useCanvas.getState().select([]);
  };
  const pointerMove = () => {
    const g = gesture.current, p = stage.current?.getPointerPosition(); if (!g || !p) return;
    if (g.kind === 'pan') useCanvas.getState().setCamera({ ...camera, x: g.origin.x + p.x - g.start.x, y: g.origin.y + p.y - g.start.y });
    else { const q = toWorld(p, camera); setBox({ x: Math.min(q.x, g.start.x), y: Math.min(q.y, g.start.y), width: Math.abs(q.x - g.start.x), height: Math.abs(q.y - g.start.y) }); }
  };
  const pointerUp = () => {
    const g = gesture.current;
    if (g?.kind === 'box' && box && box.width * camera.scale > 3) {
      const hits = index.search({ minX: box.x, minY: box.y, maxX: box.x + box.width, maxY: box.y + box.height }).map(i => i.id);
      const s = useCanvas.getState(); s.select([...new Set([...(g.additive ? s.selected : []), ...hits])], g.additive ? s.selectedGroups : []);
    }
    gesture.current = null; setBox(null);
  };
  const transformEnd = () => {
    const s = useCanvas.getState();
    const selection = new Set(s.selected);
    const items = s.doc.items.map(i => {
      if (!selection.has(i.id)) return i;
      const n = nodes.current.get(i.id); if (!n) return i;
      const width = n.width() * n.scaleX(), height = n.height() * n.scaleY();
      // Preserve the rendered origin when baking a scaled visual lift back to unit scale.
      const y = n.y() + n.offsetY() * (1 - n.scaleY());
      n.setAttrs({ y, scaleX: 1, scaleY: 1 });
      return mediaLayout({ ...i, x: n.x(), y, width: Math.max(40, width), height: Math.max(40, height) });
    }); s.commit(assignMembership({ ...s.doc, items }, selection));
  };
  // Aggregation avoids creating thousands of detailed nodes in a zoomed-out view.
  const aggregates = useMemo(() => {
    if (visible.length <= 800) return [];
    const bins = new Map<string, { x: number; y: number; count: number }>(), cell = 28 / camera.scale;
    visible.slice(800).forEach(i => { const x = Math.floor(i.x / cell) * cell, y = Math.floor(i.y / cell) * cell, key = `${x}:${y}`; const b = bins.get(key); if (b) b.count++; else bins.set(key, { x, y, count: 1 }); });
    return [...bins.values()];
  }, [visible, camera.scale]);
  return <div className={`canvas-host ${panMode ? 'pan-mode' : ''}`} ref={host} data-canvas-host onContextMenu={e => e.preventDefault()}
    onDragOver={e => { if (e.dataTransfer.types.includes(ASSET_DRAG_TYPE)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
    onDrop={e => {
      const id = e.dataTransfer.getData(ASSET_DRAG_TYPE); if (!/^[a-f0-9-]{36}$/i.test(id)) return;
      e.preventDefault(); const rect = host.current!.getBoundingClientRect();
      const point = toWorld({ x: e.clientX - rect.left, y: e.clientY - rect.top }, useCanvas.getState().camera);
      setDropStatus('正在添加素材…');
      void request<Asset>(`/assets/${id}`).then(asset => {
        if (asset.status !== 'ready') { setDropStatus('素材尚不可用，请等待文件完成或检查来源目录。'); return; }
        if (!useCanvas.getState().addAssets([asset], point)) { setDropStatus('画布暂不可编辑或已达到卡片上限。'); return; }
        cacheAssets([asset]);
        setDropStatus('');
      }).catch(() => setDropStatus('素材添加失败，请检查后端并重试。'));
    }}>
    <Stage ref={stage} width={size.width} height={size.height} x={camera.x} y={camera.y} scaleX={camera.scale} scaleY={camera.scale}
      onMouseDown={pointerDown} onMouseMove={pointerMove} onMouseUp={pointerUp}>
      <Layer ref={scene}>
        {doc.groups.map(group => <GroupBoard key={group.id} group={group} palette={palette} largeCorners={largeCorners} selected={selectedGroups.includes(group.id)} performanceMode={performanceMode} animateSelection={animateSelection} draggable={editable && !panMode} editing={editing?.field === 'name' && editing.id === group.id} register={registerGroup} onDown={onGroupDown} onDragStart={onGroupDragStart} onDragMove={onGroupDragMove} onDragEnd={onGroupDragEnd} onEdit={onEdit}/>)}
        {detailed.map(item => <Card key={item.id} item={item} palette={palette} largeCorners={largeCorners} selected={selectedIds.has(item.id)} performanceMode={performanceMode} animateSelection={animateSelection} draggable={editable && !panMode} editing={editing?.field !== 'name' && editing?.id === item.id} sharpPreview={sharpImages.has(item.id) || sharpVideos.has(item.id)} mediaInteractive={!panMode} register={register} onDown={onDown} onDragStart={onDragStart} onDragMove={onDragMove} onDragEnd={onDragEnd} onEdit={onEdit}/>)}
        {aggregates.map((b, i) => <Rect key={i} x={b.x} y={b.y} width={22 / camera.scale} height={18 / camera.scale} fill={palette.overview} opacity={.6} listening={false}/>)}
      </Layer>
      <Layer>
        <Transformer ref={groupTransformer} {...resizeHandles} enabledAnchors={['top-left', 'top-center', 'top-right', 'middle-left', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right']} rotateEnabled={false} flipEnabled={false} keepRatio={false} shiftBehavior="none" ignoreStroke borderStroke={palette.anchor} visible={!!singleGroup && editable && !panMode} onTransformEnd={onGroupTransformEnd}
          boundBoxFunc={(oldBox, newBox) => newBox.width < 80 * camera.scale || newBox.height < 80 * camera.scale || newBox.width > 1e9 * camera.scale || newBox.height > 1e9 * camera.scale ? oldBox : newBox}/>
        <Transformer ref={transformer} {...resizeHandles} enabledAnchors={freeResize ? ['top-left', 'top-center', 'top-right', 'middle-left', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right'] : ['top-left', 'top-right', 'bottom-left', 'bottom-right']} rotateEnabled={false} flipEnabled={false} keepRatio={!freeResize} shiftBehavior="none" ignoreStroke={!performanceMode} borderStroke={palette.anchor} visible={editable && !panMode} onTransformEnd={transformEnd}
          boundBoxFunc={(oldBox, newBox) => Math.abs(newBox.width) < 40 * camera.scale || Math.abs(newBox.height) < 40 * camera.scale || Math.abs(newBox.width) > 10000 * camera.scale || Math.abs(newBox.height) > 10000 * camera.scale ? oldBox : newBox}/>
        {box && <Rect {...box} fill={palette.boxFill} stroke={palette.box} strokeWidth={1 / camera.scale} listening={false}/>}
      </Layer>
    </Stage>
    <SelectionHdrLayer layer={scene} performanceMode={performanceMode}/>
    <CanvasPlayback items={detailed} nodes={nodes} panMode={panMode}/>
    {!doc.items.length && !doc.groups.length && <div className="empty-canvas"><span className="empty-cross">＋</span><h2>给灵感一个自由的空间</h2><p>拖入电脑上的文件，自动入库并放在画布上。按 N 创建文字备注。</p><small>{panWithScroll ? '双指滑动平移 · 捏合缩放' : '空格 + 拖动平移 · 滚轮缩放'} · 拖动空白处框选</small></div>}
    <div className="canvas-caption">{doc.name}<span> / </span>无限画布</div>
    <div className="zoom-controls"><button aria-label="缩小" onClick={() => useCanvas.getState().setCamera(zoomAt(camera, { x: size.width / 2, y: size.height / 2 }, camera.scale / 1.2))}>−</button><button title="重置到 100%" onClick={() => useCanvas.getState().setCamera({ x: size.width / 2, y: size.height / 2, scale: 1 })}>{Math.round(camera.scale * 100)}%</button><button aria-label="放大" onClick={() => useCanvas.getState().setCamera(zoomAt(camera, { x: size.width / 2, y: size.height / 2 }, camera.scale * 1.2))}>＋</button><i/><button onClick={() => useCanvas.getState().setCamera(fitCamera([...layoutItems, ...doc.groups], size.width, size.height))}>适应全部</button></div>
    <InlineEditor items={layoutItems} groups={doc.groups} palette={palette}/>
    {dropStatus && <div className="canvas-drop-status" role="status">{dropStatus}<button aria-label="关闭素材提示" onClick={() => setDropStatus('')}>×</button></div>}
  </div>;
}
