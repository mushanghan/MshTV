import { create } from 'zustand';
import { mediaUrl, useMediaPreview, type Asset } from './library';
import { rememberMediaFrame } from './canvas/mediaGeometry';

type Phase = 'loading' | 'playing' | 'paused' | 'error';
export interface Playback {
  key: string;
  asset: Asset;
  element: HTMLMediaElement;
  events: AbortController;
}

export const usePlayback = create<{
  current: Playback | null;
  phase: Phase;
  time: number;
  length: number;
  error: string;
}>(() => ({ current: null, phase: 'paused', time: 0, length: 0, error: '' }));

const positions = new Map<string, { assetId: string; version: number; time: number }>();

export function stopPlayback(key?: string) {
  const { current } = usePlayback.getState();
  if (!current || (key && current.key !== key)) return;
  const { element, events } = current;
  if (!current.key.startsWith('hover:') && element.readyState >= 1 && Number.isFinite(element.currentTime)) {
    positions.delete(current.key);
    positions.set(current.key, { assetId: current.asset.id, version: current.asset.version, time: element.ended ? 0 : element.currentTime });
    if (positions.size > 64) positions.delete(positions.keys().next().value!);
  }
  events.abort();
  element.pause();
  element.removeAttribute('src');
  element.load();
  element.remove();
  usePlayback.setState({ current: null });
}

export function playbackError(kind: Asset['kind'], code?: number) {
  if (code === 2) return '媒体加载中断，请检查来源后重试。';
  if (code === 3) return '浏览器无法解码此文件。';
  return kind === 'video' ? '当前视频格式不支持浏览器预览。' : '当前音频格式不支持浏览器预览。';
}

function fail(current: Playback, message: string) {
  if (usePlayback.getState().current !== current || current.events.signal.aborted) return;
  current.events.abort();
  current.element.pause();
  current.element.removeAttribute('src');
  current.element.load();
  usePlayback.setState({ phase: 'error', error: message });
}

function play(current: Playback) {
  usePlayback.setState({ phase: 'loading' });
  void current.element.play().catch(error => {
    if (error.name === 'AbortError') return;
    fail(current, error.name === 'NotAllowedError' ? '浏览器阻止了播放，请点击播放。' :
      playbackError(current.asset.kind, current.element.error?.code));
  });
}

export function togglePlayback(key: string, asset: Asset) {
  if (asset.status !== 'ready' || asset.kind === 'image' || document.hidden || useMediaPreview.getState().id) return;
  const hover = key.startsWith('hover:');
  const { current, phase } = usePlayback.getState();
  if (hover && current && !current.key.startsWith('hover:') && (phase === 'playing' || phase === 'loading')) return;
  if (current?.key === key && current.asset.version === asset.version && phase !== 'error') {
    if (current.element.paused) play(current); else current.element.pause();
    return;
  }
  stopPlayback();
  const element = document.createElement(asset.kind);
  if (element instanceof HTMLVideoElement) element.playsInline = true;
  element.muted = hover;
  element.preload = 'metadata';
  const events = new AbortController();
  const session = { key, asset, element, events };
  const on = (name: string, listener: () => void) => element.addEventListener(name, listener, { signal: events.signal });
  const updateTime = () => {
    const time = element.currentTime;
    if (hover && time >= 6) { stopPlayback(key); return; }
    usePlayback.setState({ time });
  };
  on('loadedmetadata', () => {
    if (element instanceof HTMLVideoElement && key.startsWith('canvas:'))
      rememberMediaFrame(asset, element.videoWidth, element.videoHeight, 'player');
    const length = Number.isFinite(element.duration) ? element.duration : 0;
    const previous = positions.get(key);
    if (!hover && previous?.assetId === asset.id && previous.version === asset.version && previous.time > 0 && previous.time < length)
      element.currentTime = previous.time;
    usePlayback.setState({ length });
    updateTime();
  });
  on('timeupdate', updateTime);
  on('seeked', updateTime);
  on('playing', () => usePlayback.setState({ phase: 'playing' }));
  on('waiting', () => { if (!element.paused) usePlayback.setState({ phase: 'loading' }); });
  on('pause', () => usePlayback.setState({ phase: 'paused' }));
  on('ended', () => { if (hover) stopPlayback(key); else usePlayback.setState({ phase: 'paused' }); });
  on('error', () => fail(session, playbackError(asset.kind, element.error?.code)));
  usePlayback.setState({ current: session, time: 0, length: asset.duration ?? 0, error: '', phase: 'loading' });
  element.src = mediaUrl(asset, 'source');
  // Keep the first play() inside the initiating user gesture.
  play(session);
}
