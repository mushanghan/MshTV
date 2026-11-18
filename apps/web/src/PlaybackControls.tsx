import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { request } from './api';
import { duration, mediaUrl, type Asset } from './library';
import { togglePlayback, usePlayback, type Playback } from './playback';

export function PlaybackElement({ session, className }: { session: Playback; className: string }) {
  const mount = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const parent = mount.current!;
    parent.appendChild(session.element);
    return () => { if (session.element.parentNode === parent) session.element.remove(); };
  }, [session]);
  return <span ref={mount} className={className}/>;
}

export function OriginalDownload({ asset }: { asset: Asset }) {
  return <a href={`${mediaUrl(asset, 'source')}&download=1`} download={asset.name}>下载原文件</a>;
}

const waveformCache = new Map<string, number[]>();

function AudioWaveform({ asset, progress }: { asset: Asset; progress: number }) {
  const key = `${asset.id}:${asset.version}`;
  const [result, setResult] = useState<{ key: string; peaks?: number[]; error?: string }>();
  useEffect(() => {
    const cached = waveformCache.get(key);
    if (cached) {
      waveformCache.delete(key);
      waveformCache.set(key, cached);
      setResult({ key, peaks: cached });
      return;
    }
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout>;
    const load = async (remaining: number) => {
      try {
        const { peaks } = await request<{ peaks: number[] }>(`/media/${asset.id}/waveform?v=${asset.version}`, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
        });
        if (controller.signal.aborted) return;
        waveformCache.set(key, peaks);
        if (waveformCache.size > 64) waveformCache.delete(waveformCache.keys().next().value!);
        setResult({ key, peaks });
      } catch (error) {
        if (controller.signal.aborted) return;
        if ((error as { status?: number }).status === 429 && remaining > 0)
          retry = setTimeout(() => void load(remaining - 1), 1000);
        else setResult({ key, error: error instanceof Error ? error.message : '无法读取波形。' });
      }
    };
    retry = setTimeout(() => void load(2), 0);
    return () => { controller.abort(); clearTimeout(retry); };
  }, [asset.id, asset.version, key]);
  const peaks = result?.key === key ? result.peaks : undefined;
  const path = useMemo(() => peaks?.map((peak, i) => {
    const height = Math.max(1, Math.round(peak / 255 * 48));
    return `M${i + .5} ${50 - height}v${height * 2}`;
  }).join(''), [peaks]);
  return path && peaks ? <svg className="audio-waveform" role="img" aria-label="音频波形" viewBox={`0 0 ${peaks.length} 100`} preserveAspectRatio="none">
    <path d={path} stroke="var(--waveform, #83929a)" strokeWidth=".78"/>
    <path d={path} stroke="var(--waveform-active, #b6d1bd)" strokeWidth=".78" style={{ clipPath: `inset(0 ${100 - progress * 100}% 0 0)` }}/>
  </svg> : <span className="waveform-status" title={result?.key === key ? result.error : undefined}>
    {result?.key === key && result.error ? '波形不可用' : '正在生成波形…'}
  </span>;
}

export function PlaybackControls({ session, showToggle = true }: { session: Playback; showToggle?: boolean }) {
  const phase = usePlayback(state => state.phase);
  const time = usePlayback(state => state.time);
  const length = usePlayback(state => state.length);
  const error = usePlayback(state => state.error);
  const { asset, element } = session;
  const playing = phase === 'playing' || phase === 'loading';
  const position = Math.max(0, Math.min(length, time));
  return <div className="inline-playback" data-media-controls onKeyDown={event => { if (event.code === 'Space') event.stopPropagation(); }}>
    {asset.kind === 'audio' && <AudioWaveform asset={asset} progress={length > 0 ? position / length : 0}/>}
    {phase === 'error' ? <div className="playback-status" role="alert">{error} <OriginalDownload asset={asset}/></div> :
      <div className="playback-transport">
        {showToggle && <button type="button" aria-label={`${playing ? '暂停' : '播放'} ${asset.name}`} onClick={() => togglePlayback(session.key, asset)}>
          {playing ? <Pause size={13}/> : <Play size={13}/>}
        </button>}
        <input type="range" min={0} max={length || 1} step=".01" disabled={!length || element.readyState < 1}
          aria-label={`${asset.name} 播放进度`} value={position}
          onChange={event => {
            element.currentTime = Number(event.currentTarget.value);
            usePlayback.setState({ time: element.currentTime });
          }}/>
        <span className="playback-time" title={phase === 'loading' ? '正在加载媒体' : undefined}>
          {phase === 'loading' ? '加载中' : `${duration(position)} / ${duration(length)}`}
        </span>
      </div>}
  </div>;
}
