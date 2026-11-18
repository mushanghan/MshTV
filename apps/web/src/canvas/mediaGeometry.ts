import { useSyncExternalStore } from 'react';
import type { Asset } from '../library';
import { samples, type CanvasItem } from '../model';

export const MEDIA_INSET = 7;
export const MEDIA_WIDTH_PADDING = 14;
export const MEDIA_HEIGHT_PADDING = 47;
type FrameSource = 'cover' | 'preview' | 'player';
const aspects = new Map<string, { value: number; version: number; source: 'probe' | FrameSource }>();
const sampleAspects = new Map(samples.map(sample => [sample.id, sample.aspect]));
const listeners = new Set<() => void>();
let revision = 0;

function mediaAspect(width?: number | null, height?: number | null) {
  if (!width || !height || width < 0 || height < 0) return undefined;
  const aspect = width / height;
  return Number.isFinite(aspect) && aspect > 0 ? aspect : undefined;
}

export function rememberMediaAspects(assets: Asset[]) {
  let changed = false;
  for (const asset of assets) {
    if (asset.kind === 'audio') continue;
    const aspect = mediaAspect(asset.width, asset.height);
    const previous = aspects.get(asset.id);
    if (!aspect || (previous && previous.version >= asset.version)) continue;
    aspects.delete(asset.id);
    aspects.set(asset.id, { value: aspect, version: asset.version, source: 'probe' });
    changed ||= previous?.value !== aspect;
  }
  if (changed) publishGeometry();
}

export function rememberMediaFrame(asset: Asset, width: number, height: number, source: FrameSource) {
  const value = mediaAspect(width, height);
  const previous = aspects.get(asset.id);
  if (!value || previous && previous.version > asset.version) return;
  if (previous?.version === asset.version && source !== 'player') {
    if (previous.source === 'player' || source === 'cover' && previous.source !== 'probe') return;
    // Retain original metadata when the decoded derivative only differs by rounding.
    if (Math.abs(previous.value / value - 1) < .01) return;
  }
  aspects.delete(asset.id);
  aspects.set(asset.id, { value, version: asset.version, source });
  if (previous?.value !== value || aspects.size > 12000) publishGeometry();
}

function publishGeometry() {
  // Keep geometry stable across library refreshes and thumbnail cache eviction.
  while (aspects.size > 12000) aspects.delete(aspects.keys().next().value!);
  revision++;
  listeners.forEach(listener => listener());
}

export function useMediaGeometry() {
  return useSyncExternalStore(listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => revision);
}

function fitMediaFrame(width: number, height: number, aspect: number, image: boolean) {
  const contentHeight = image ? Math.max(1, height - MEDIA_HEIGHT_PADDING) : height - MEDIA_HEIGHT_PADDING;
  const contentWidth = Math.min(width - MEDIA_WIDTH_PADDING, contentHeight * aspect);
  const frame = {
    width: image ? Math.max(40, contentWidth + MEDIA_WIDTH_PADDING) : contentWidth + MEDIA_WIDTH_PADDING,
    height: contentWidth / aspect + MEDIA_HEIGHT_PADDING,
  };
  return image || frame.width >= 40 && height > MEDIA_HEIGHT_PADDING ? frame : { width, height };
}

export function mediaLayout(item: CanvasItem): CanvasItem {
  if (!item.assetId || (item.type !== 'image' && item.type !== 'video')) return item;
  const aspect = aspects.get(item.assetId)?.value ?? (item.type === 'image' ? sampleAspects.get(item.assetId) : undefined);
  if (!aspect) return item;
  const size = fitMediaFrame(item.width, item.height, aspect, item.type === 'image');
  if (Math.abs(size.width - item.width) < .001 && Math.abs(size.height - item.height) < .001) return item;
  return { ...item, ...size };
}
