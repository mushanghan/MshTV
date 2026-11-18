import { useEffect, useState } from 'react';
import { Power, X } from 'lucide-react';
import { flushBoard, request, useConnection } from './api';
import { useCanvas } from './store';
import { useServerState } from './serverState';
import { useMediaPreview } from './library';
import { stopPlayback } from './playback';

export function ServerControls({ workspace = false, disabled = false }: { workspace?: boolean; disabled?: boolean }) {
  const connection = useConnection();
  const [phase, setPhase] = useState<'idle' | 'confirm' | 'starting' | 'waiting' | 'closed'>('idle'), [error, setError] = useState('');
  useEffect(() => {
    if (phase !== 'waiting') return;
    let alive = true;
    const check = async () => {
      try { const response = await fetch('/api/v1/health', { cache: 'no-store', signal: AbortSignal.timeout(1200) }); if (alive && !response.ok) setPhase('closed'); }
      catch { if (alive) setPhase('closed'); }
    };
    void check(); const timer = setInterval(() => void check(), 1500);
    return () => { alive = false; clearInterval(timer); };
  }, [phase]);
  const shutdown = async () => {
    setError(''); setPhase('starting');
    let saved = false;
    try {
      if (!workspace) { await flushBoard(); saved = true; useCanvas.setState({ editable: false }); }
      await request('/system/shutdown', { method: 'POST', body: '{}' });
      stopPlayback(); useMediaPreview.getState().close(); useServerState.setState({ stopping: true }); setPhase('waiting');
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法关闭后端，请检查连接。'); setPhase('confirm');
      // Saving errors already freeze the canvas; a failed shutdown request may safely restore saved editing.
      if (saved) useCanvas.setState({ editable: true });
    }
  };
  return <>
    <button type="button" className="icon-button server-power" title={workspace ? '关闭后端' : '保存并关闭后端'} aria-label="关闭后端"
      disabled={disabled || (!workspace && connection.status === 'loading') || phase !== 'idle'}
      onClick={() => { setError(''); setPhase('confirm'); }}><Power size={16}/></button>
    {phase !== 'idle' && <div className="modal-backdrop"><div className="shutdown-dialog" role="dialog" aria-modal="true" aria-label="关闭 MshTV 后端">
      <div className="panel-heading"><h2>{phase === 'closed' ? '后端已关闭' : '关闭后端'}</h2>{phase === 'confirm' && <button className="icon-button" aria-label="取消关闭后端" onClick={() => setPhase('idle')}><X size={18}/></button>}</div>
      {phase === 'confirm' ? <>
        <p>{workspace ? '关闭后端会停止文件夹监控，并断开所有页面。请先保存其他页面的修改。' : '将先保存当前画布，再停止文件夹监控和后端服务。其他打开的页面也会断开，请先保存其他页面的修改。'}</p>
        {error && <p role="alert">{error}</p>}
        <div className="dialog-actions"><button onClick={() => setPhase('idle')}>取消</button><button onClick={() => void shutdown()}>{workspace ? '确认关闭后端' : '保存并关闭后端'}</button></div>
      </> : <>
        <p>{phase === 'closed' ? '可以关闭此页面。再次使用时，请重新运行 start.cmd。' :
          phase === 'starting' && !workspace ? '正在保存画布…' : '正在关闭后端，请稍候…'}</p>
        {phase === 'closed' && <button onClick={() => window.location.reload()}>后端重启后重新连接</button>}
      </>}
    </div></div>}
  </>;
}
