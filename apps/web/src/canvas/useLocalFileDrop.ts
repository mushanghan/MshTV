import { useEffect, type RefObject } from 'react';
import { request } from '../api';
import { ASSET_DRAG_TYPE, cacheAssets, invalidateLibrary, type Asset } from '../library';
import { useCanvas } from '../store';
import { toWorld } from './geometry';

const chunkSize = 4 * 1024 * 1024;
const maxFileSize = 32 * 1024 * 1024 * 1024;
const maxFiles = 20;

async function fingerprint(file: File, signal: AbortSignal) {
  const digests = new Uint8Array(Math.ceil(file.size / chunkSize) * 32);
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    signal.throwIfAborted();
    const bytes = await file.slice(offset, offset + chunkSize).arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    digests.set(new Uint8Array(digest), offset / chunkSize * 32);
  }
  const result = await crypto.subtle.digest('SHA-256', digests);
  return [...new Uint8Array(result)].map(byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
}

async function findIndexedMatch(file: File, signal: AbortSignal) {
  const params = new URLSearchParams({ name: file.name, size: String(file.size) });
  const candidates = await request<{ digest: string; asset: Asset }[]>(`/assets/drop-candidates?${params}`, { signal });
  if (!candidates.length) return undefined;
  const digest = await fingerprint(file, signal);
  signal.throwIfAborted();
  const matches = candidates.filter(candidate => candidate.digest === digest);
  return matches.length === 1 ? matches[0].asset : undefined;
}

async function importFile(file: File, signal: AbortSignal) {
  if (file.size <= 0 || file.size > maxFileSize) throw new Error('请选择不超过 32 GiB 的图片、视频或音频文件。');
  const matchSignal = AbortSignal.any([signal, AbortSignal.timeout(90000)]);
  const existing = await findIndexedMatch(file, matchSignal).catch(() => undefined);
  signal.throwIfAborted();
  if (existing) return existing;

  const params = new URLSearchParams({ name: file.name });
  return request<Asset>(`/assets/import?${params}`, {
    method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(16 * 60 * 1000)]),
  });
}

export function useLocalFileDrop(host: RefObject<HTMLDivElement | null>, setStatus: (status: string) => void) {
  useEffect(() => {
    let active: AbortController | undefined;
    const dragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files') || event.dataTransfer.types.includes(ASSET_DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = useCanvas.getState().editable && !active && !document.querySelector('.modal-backdrop') ? 'copy' : 'none';
    };
    const drop = async (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      // A browser can attach a native image file alongside the library reference.
      if (event.dataTransfer.types.includes(ASSET_DRAG_TYPE) || active || document.querySelector('.modal-backdrop')) return;
      const rect = host.current?.getBoundingClientRect();
      if (!rect || !useCanvas.getState().editable) {
        setStatus('画布暂不可编辑，恢复后再拖入文件。');
        return;
      }
      const selection = event.dataTransfer.files;
      if (!selection.length || selection.length > maxFiles) {
        setStatus('每次可拖入 1 至 20 个媒体文件。');
        return;
      }
      const files = Array.from(selection);
      const x = event.clientX - rect.left, y = event.clientY - rect.top;
      const onCanvas = x >= 0 && y >= 0 && x < rect.width && y < rect.height;
      const point = toWorld(onCanvas ? { x, y } : { x: rect.width / 2, y: rect.height / 2 }, useCanvas.getState().camera);
      const controller = new AbortController();
      active = controller;
      const assets: Asset[] = [], failures: string[] = [];
      let addedCount = 0;
      try {
        for (const file of files) {
          setStatus(`正在导入 ${file.name}（${assets.length + failures.length + 1}/${files.length}）…`);
          try {
            assets.push(await importFile(file, controller.signal));
          } catch (error) {
            if (controller.signal.aborted) return;
            failures.push(`${file.name}：${error instanceof Error ? error.message : '无法核对文件。'}`);
          }
        }
        if (assets.length) {
          const ids = [...new Set(assets.map(asset => asset.id))].join(',');
          const latest = await request<Asset[]>(`/assets/batch?ids=${ids}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]) });
          controller.signal.throwIfAborted();
          const available = latest.filter(asset => asset.status === 'ready' || asset.status === 'pending');
          const verified = assets.flatMap(asset => available.filter(row => row.id === asset.id && row.version === asset.version));
          if (assets.length !== verified.length) failures.push('有素材在核对期间发生变化，请重新拖入。');
          if (verified.length) {
            if (!useCanvas.getState().addAssets(verified, point)) throw new Error('画布暂不可编辑或已达到卡片上限。');
            cacheAssets(verified);
            invalidateLibrary();
            addedCount = verified.length;
          }
        }
        setStatus(failures.length ? `${files.length - addedCount} 个文件未添加。${failures[0]}` : '');
      } catch (error) {
        if (!controller.signal.aborted) setStatus(error instanceof Error ? error.message : '添加文件失败，请重试。');
      } finally { active = undefined; }
    };
    window.addEventListener('dragover', dragOver);
    window.addEventListener('drop', drop, true);
    return () => {
      active?.abort();
      window.removeEventListener('dragover', dragOver);
      window.removeEventListener('drop', drop, true);
    };
  }, [host, setStatus]);
}
