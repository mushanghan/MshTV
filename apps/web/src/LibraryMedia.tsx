import { useEffect, useRef } from 'react';
import { AudioLines, Check, Image, Pause, Play, Video } from 'lucide-react';
import { duration, mediaUrl, useMediaPreview, type Asset } from './library';
import { PlaybackControls, PlaybackElement } from './PlaybackControls';
import { stopPlayback, togglePlayback, usePlayback } from './playback';

export function LibraryThumbnail({ asset, hoverEnabled, inCanvas }: { asset: Asset; hoverEnabled: boolean; inCanvas: boolean }) {
  const ready = asset.status === 'ready';
  const audio = asset.kind === 'audio';
  const key = `${audio ? 'library' : 'hover'}:${asset.id}`;
  const session = usePlayback(state => state.current?.key === key ? state.current : null);
  const phase = usePlayback(state => state.current?.key === key ? state.phase : null);
  const error = usePlayback(state => state.current?.key === key ? state.error : '');
  const button = useRef<HTMLButtonElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const playing = phase === 'playing' || phase === 'loading';
  const label = audio && ready ? (playing ? '暂停' : '播放') : '预览';
  useEffect(() => () => { clearTimeout(hoverTimer.current); stopPlayback(key); }, [key]);
  useEffect(() => {
    if (asset.kind !== 'video' || hoverEnabled) return;
    clearTimeout(hoverTimer.current);
    stopPlayback(key);
  }, [asset.kind, key, hoverEnabled]);
  useEffect(() => {
    if (!session) return;
    if (!ready || asset.version !== session.asset.version) { stopPlayback(key); return; }
    const observer = new IntersectionObserver(entries => {
      if (usePlayback.getState().current === session && entries.some(entry => !entry.isIntersecting)) stopPlayback(key);
    });
    observer.observe(button.current!);
    return () => observer.disconnect();
  }, [key, session, ready, asset.version]);
  return <button className="asset-thumbnail" ref={button} aria-label={`${label} ${asset.name}`} title={error || `${label} ${asset.name}`}
    aria-description={inCanvas ? '已添加到画布' : undefined}
    onKeyDown={event => { if (event.code === 'Space') event.stopPropagation(); }}
    onClick={() => {
      clearTimeout(hoverTimer.current);
      if (audio && ready) togglePlayback(key, asset);
      else useMediaPreview.getState().open(asset.id);
    }}
    onPointerEnter={event => {
      if (!hoverEnabled || asset.kind !== 'video' || !ready || event.pointerType !== 'mouse') return;
      hoverTimer.current = setTimeout(() => togglePlayback(key, asset), 300);
    }}
    onPointerLeave={() => {
      clearTimeout(hoverTimer.current);
      if (!audio) stopPlayback(key);
    }}>
    {asset.hasThumbnail && ready ? <img src={mediaUrl(asset, 'thumb')} loading="lazy" draggable={false} alt="" onError={event => { event.currentTarget.style.visibility = 'hidden'; }}/> :
      audio ? (ready ? playing ? <Pause size={17}/> : <Play size={17}/> : <AudioLines size={23}/>) : asset.kind === 'video' ? <Video size={23}/> : <Image size={23}/>}
    {session && !audio && <>{phase !== 'error' && <PlaybackElement session={session} className="library-hover-frame"/>}
      <span className="library-hover-status" role="status">{phase === 'playing' ? '静音预览' : phase === 'error' ? '预览失败' : '加载中'}</span></>}
    {inCanvas && <span className="asset-canvas-mark" aria-hidden="true"><Check size={10} strokeWidth={2.5}/></span>}
    {asset.duration != null && <small>{duration(asset.duration)}</small>}
  </button>;
}

export function LibraryAudioControls({ asset }: { asset: Asset }) {
  const session = usePlayback(state => state.current?.key === `library:${asset.id}` ? state.current : null);
  if (!session) return null;
  return <><PlaybackElement session={session} className="audio-element"/>
    <PlaybackControls session={session} showToggle={false}/></>;
}
