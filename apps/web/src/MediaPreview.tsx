import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { duration, fileSize, mediaUrl, statusLabel, useAsset, useMediaPreview } from './library';
import { OriginalDownload } from './PlaybackControls';
import { playbackError, stopPlayback } from './playback';

export function MediaPreview() {
  const id = useMediaPreview(s => s.id), asset = useAsset(id);
  const media = useRef<HTMLMediaElement | null>(null), [error, setError] = useState('');
  useEffect(() => { if (id) stopPlayback(); }, [id]);
  useEffect(() => { setError(''); const close = (e: KeyboardEvent) => { if (e.key === 'Escape') useMediaPreview.getState().close(); }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, [id]);
  useEffect(() => {
    if (!id) return;
    const element = media.current;
    const visibility = () => { if (document.hidden) element?.pause(); }; document.addEventListener('visibilitychange', visibility);
    return () => { document.removeEventListener('visibilitychange', visibility); if (element) { element.pause(); element.removeAttribute('src'); element.load(); } };
  }, [id, asset?.status]);
  if (!id) return null;
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) useMediaPreview.getState().close(); }}><div className="media-dialog"><div className="panel-heading"><h2>{asset?.name ?? '正在读取素材…'}</h2><button className="icon-button" aria-label="关闭媒体预览" onClick={() => useMediaPreview.getState().close()}><X size={19}/></button></div>
    {asset && <><p className="media-info">{asset.extension.toUpperCase()} · {fileSize(asset.size)} {duration(asset.duration)} {asset.width && asset.height ? ` · ${asset.width} × ${asset.height}` : ''}</p>
      {asset.status !== 'ready' ? <p>{statusLabel(asset.status)}</p> : error ? <p role="alert">{error} {asset.kind !== 'image' && <OriginalDownload asset={asset}/>}</p> : asset.kind === 'image' ? <img className="large-image" src={mediaUrl(asset, asset.hasPreview ? 'preview' : 'source')} alt={asset.name} onError={() => setError('当前图片格式不支持浏览器预览')}/> : asset.kind === 'video' ? <video key={id} ref={node => { media.current = node; }} controls preload="metadata" playsInline src={mediaUrl(asset, 'source')} poster={asset.hasThumbnail ? mediaUrl(asset, 'thumb') : undefined} onError={event => setError(playbackError('video', event.currentTarget.error?.code))}/> : <audio key={id} ref={node => { media.current = node; }} controls preload="metadata" src={mediaUrl(asset, 'source')} onError={event => setError(playbackError('audio', event.currentTarget.error?.code))}/>}
      {asset.error && <p className="property-hint">{asset.error}</p>}</>}
  </div></div>;
}
