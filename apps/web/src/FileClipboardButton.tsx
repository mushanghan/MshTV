import { useCallback, useEffect, useRef, useState } from 'react';
import { ClipboardCopy, X } from 'lucide-react';
import { flushBoard, request } from './api';
import { useCanvas } from './store';
import { useServerState } from './serverState';

interface Capability { available: boolean; reason: string | null }
interface CopyResult {
  copied: number;
  ignored: number;
  unavailable: number;
  failures: { name: string; reason: string }[];
}
const label = '复制文件到 Windows 剪贴板';
const localOnly = '请在运行 MshTV 的 Windows 电脑上直接打开本机页面。其他设备可使用导出或下载。';

export default function FileClipboardButton({ ready, hasSelection }: { ready: boolean; hasSelection: boolean }) {
  const [capability, setCapability] = useState<Capability>();
  const [copying, setCopying] = useState(false);
  const inFlight = useRef(false);
  const [feedback, setFeedback] = useState<{ message: string; error?: boolean; result?: CopyResult }>();
  const holder = useRef<HTMLDivElement>(null);
  const stopping = useServerState(state => state.stopping);
  const canCopy = ready && hasSelection && capability?.available === true && !stopping;

  useEffect(() => {
    if (!ready || stopping) return;
    let current = true;
    const check = async () => {
      try {
        const result = await request<Capability>('/clipboard/capability');
        if (current) setCapability(result);
      } catch {
        if (current) setCapability({ available: false, reason: '无法确认剪贴板可用，请重新连接或刷新页面。' });
      }
    };
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname) || !navigator.userAgent.includes('Windows NT')) {
      setCapability({ available: false, reason: localOnly });
      return;
    }
    void check();
    window.addEventListener('focus', check);
    return () => { current = false; window.removeEventListener('focus', check); };
  }, [ready, stopping]);

  useEffect(() => {
    if (!feedback) return;
    const dismiss = (event: PointerEvent) => {
      if (!holder.current?.contains(event.target as Node)) setFeedback(undefined);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [feedback]);

  const copy = useCallback(async () => {
    if (!canCopy || inFlight.current) return;
    const { selected, selectedGroups } = useCanvas.getState();
    if (!selected.length && !selectedGroups.length) return;
    inFlight.current = true;
    setCopying(true);
    setFeedback(undefined);
    try {
      const revision = await flushBoard('复制文件');
      const result = await request<CopyResult>('/clipboard/files', {
        method: 'POST',
        body: JSON.stringify({ revision, itemIds: selected, groupIds: selectedGroups }),
        signal: AbortSignal.timeout(30000),
      });
      const message = result.copied ? `已复制 ${result.copied} 个文件。` : '选区中没有可复制的文件。';
      setFeedback({ message, result, error: !result.copied });
    } catch (error) {
      setFeedback({ message: error instanceof Error ? error.message : '无法复制文件。', error: true });
    } finally {
      inFlight.current = false;
      setCopying(false);
    }
  }, [canCopy]);

  useEffect(() => {
    if (!canCopy) return;
    const onCopy = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.key.toLowerCase() !== 'c' ||
        !event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const { editing, selected, selectedGroups } = useCanvas.getState();
      if (editing || (!selected.length && !selectedGroups.length) || document.querySelector('.modal-backdrop') ||
        document.getSelection()?.isCollapsed === false ||
        (event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])'))) return;
      event.preventDefault();
      if (!event.repeat) void copy();
    };
    window.addEventListener('keydown', onCopy);
    return () => window.removeEventListener('keydown', onCopy);
  }, [canCopy, copy]);

  const reason = stopping ? '后端正在关闭。' :
    !hasSelection ? '先选中素材或分组。' : capability?.reason ?? (capability?.available ? `${label} (Ctrl+C)` : '正在确认 Windows 剪贴板可用性。');
  return <div className="file-clipboard" ref={holder}>
    <span title={reason}>
      <button type="button" className="file-clipboard-action" aria-label={label}
        aria-keyshortcuts={canCopy ? 'Control+C' : undefined} disabled={!canCopy || copying} onClick={() => void copy()}>
        <ClipboardCopy size={17}/>复制文件
      </button>
    </span>
    {(copying || feedback) && <div className="file-clipboard-feedback">
      <div className="file-clipboard-heading">
        <span role={feedback?.error ? 'alert' : 'status'}>{copying ? '正在复制文件…' : feedback?.message}</span>
        {!copying && <button type="button" className="icon-button" aria-label="关闭复制提示" onClick={() => setFeedback(undefined)}><X size={14}/></button>}
      </div>
      {!!feedback?.result?.copied && <p>在 Windows 桌面空白处或目标文件夹内按 Ctrl+V。</p>}
      {!!feedback?.result?.ignored && <p>已略过 {feedback.result.ignored} 个文字、示例或占位卡片。</p>}
      {!!feedback?.result?.unavailable && <>
        <p>{feedback.result.unavailable} 个素材无法复制</p>
        <ul>{feedback.result.failures.map((file, index) => <li key={index}>{file.name || '未命名'} · {file.reason}</li>)}</ul>
        {feedback.result.unavailable > feedback.result.failures.length && <p>另有 {feedback.result.unavailable - feedback.result.failures.length} 项失败，请分批检查。</p>}
      </>}
    </div>}
  </div>;
}
