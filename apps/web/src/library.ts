import { useEffect, useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { request } from './api';
import { rememberMediaAspects } from './canvas/mediaGeometry';
import { scopedApiUrl } from './navigation';
export const ASSET_DRAG_TYPE = 'application/x-mshtv-asset';
export interface Asset { id: string; rootId: string; name: string; kind: 'image' | 'video' | 'audio'; extension: string; size: number; modifiedAt: number; addedAt: number; status: string; version: number; width: number | null; height: number | null; duration: number | null; hasThumbnail: boolean; hasPreview: boolean; error: string | null; revision: number; folder: string }
export interface Root { id: string; path: string; enabled: boolean; online: boolean; error: string | null; lastScanAt: number; revision: number; includeSubdirectories: boolean; newFilesOnly: boolean; baselinePending: boolean; managed: boolean }
export interface AssetPage { items: Asset[]; nextCursor: string | null }
const assets = new Map<string, { asset: Asset; validatedAt: number }>();
const invalidated = new Map<string, number>();
const pending = new Set<string>(), subscribers = new Set<() => void>(), queued = new Set<string>();
let batchTimer: ReturnType<typeof setTimeout> | undefined, fetching = false;
let generation = 0, allInvalidatedAt = 0;
const invalidatedAt = (id: string) => Math.max(allInvalidatedAt, invalidated.get(id) ?? 0);

function queueAsset(id: string) {
  if (pending.has(id)) return; pending.add(id); queued.add(id);
  scheduleBatch();
}
function scheduleBatch() {
  if (fetching || batchTimer || !queued.size) return;
  batchTimer = setTimeout(() => { batchTimer = undefined; void flushAssets(); }, 30);
}
async function flushAssets() {
  fetching = true;
  const ids = [...queued].slice(0, 100); ids.forEach(id => queued.delete(id));
  const requestedAt = generation;
  try { cacheAssets(await request<Asset[]>(`/assets/batch?ids=${ids.join(',')}`), requestedAt); }
  catch { }
  finally {
    for (const id of ids) {
      pending.delete(id);
      if (invalidatedAt(id) > requestedAt) queueAsset(id);
      else if (!assets.has(id)) invalidated.delete(id);
    }
    fetching = false;
    scheduleBatch();
  }
}
function emit() { subscribers.forEach(fn => fn()); }
function subscribe(listener: () => void) { subscribers.add(listener); return () => subscribers.delete(listener); }
export function cacheAssets(items: Asset[], validatedAt = generation) {
  const changed: Asset[] = [];
  for (const asset of items) {
    const previous = assets.get(asset.id);
    if (validatedAt < invalidatedAt(asset.id) || previous && (validatedAt < previous.validatedAt ||
      validatedAt === previous.validatedAt && asset.revision < previous.asset.revision)) continue;
    const unchanged = previous && (Object.keys(asset) as (keyof Asset)[]).every(key => previous.asset[key] === asset[key]);
    if (!unchanged) changed.push(asset);
    assets.delete(asset.id);
    assets.set(asset.id, { asset: unchanged ? previous.asset : asset, validatedAt });
  }
  let evicted = false;
  while (assets.size > 2000) {
    const id = assets.keys().next().value!;
    assets.delete(id);
    if (!pending.has(id)) invalidated.delete(id);
    evicted = true;
  }
  if (changed.length) rememberMediaAspects(changed);
  if (changed.length || evicted) emit();
}
export function invalidateLibraryBatch(ids: Iterable<string>, allAssets = false) {
  generation++;
  if (allAssets) { allInvalidatedAt = generation; invalidated.clear(); }
  else for (const id of ids) if (assets.has(id) || pending.has(id)) invalidated.set(id, generation);
  emit();
}
export function invalidateLibrary(id?: string | null, allAssets = false) {
  invalidateLibraryBatch(id ? [id] : [], allAssets);
}
export function useLibraryRevision() { return useSyncExternalStore(subscribe, () => generation); }
export function useAsset(id?: string | null) {
  const valid = !!id && /^[a-f0-9-]{36}$/i.test(id);
  const asset = useSyncExternalStore(subscribe, () => valid ? assets.get(id!)?.asset : undefined);
  const revision = useSyncExternalStore(subscribe, () => valid ? invalidatedAt(id!) : 0);
  useEffect(() => {
    if (!valid) return;
    const record = assets.get(id!);
    if (!record || record.validatedAt < invalidatedAt(id!)) queueAsset(id!);
  }, [id, valid, asset, revision]);
  return asset;
}
export const mediaUrl = (asset: Asset, variant: 'thumb' | 'preview' | 'source') => scopedApiUrl(`/api/v1/media/${asset.id}/${variant}?v=${asset.version}`);
export const statusLabel = (status: string) => ({ pending: '等待文件完成 / 分析中', missing: '文件缺失', offline: '来源目录离线', sourceRemoved: '来源配置已移除', removed: '素材已从素材库移除', ready: '可用' }[status] ?? status);
export const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
export function fileSize(size: number) { return size >= 1024 ** 3 ? `${(size / 1024 ** 3).toFixed(1)} GB` : size >= 1024 ** 2 ? `${(size / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`; }
export function duration(seconds?: number | null) { if (seconds == null) return ''; return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`; }
export const useMediaPreview = create<{ id: string | null; open: (id: string) => void; close: () => void }>(set => ({ id: null, open: id => set({ id }), close: () => set({ id: null }) }));
