import { useEffect, useRef, useState } from 'react';
import { Zap } from 'lucide-react';
import { create } from 'zustand';
import { request } from './api';
import { useServerState } from './serverState';
import { isLanClient } from './navigation';

interface MediaMode { enabled: boolean; revision: number; analysisLimit: number }
const endpoint = '/settings/performance';
export const usePerformanceMode = create<{ mode: MediaMode | null }>(() => ({ mode: null }));

function applyMode(mode: MediaMode) {
  usePerformanceMode.setState(current => (current.mode?.revision ?? 0) <= mode.revision ? { mode } : current);
}

export function PerformanceModeToggle({ connected }: { connected: boolean }) {
  const mode = usePerformanceMode(state => state.mode);
  const stopping = useServerState(state => state.stopping);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const channel = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    if (!connected || stopping) return;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const snapshot = await request<MediaMode>(endpoint, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
        });
        if (!controller.signal.aborted) { applyMode(snapshot); setError(''); }
      } catch {
        if (!controller.signal.aborted) setError('无法读取性能模式，请刷新页面重试。');
      }
    };
    const signal = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('mshtv-performance-mode');
    channel.current = signal;
    if (signal) signal.onmessage = () => void refresh();
    window.addEventListener('focus', refresh);
    void refresh();
    return () => {
      controller.abort();
      window.removeEventListener('focus', refresh);
      signal?.close();
      channel.current = null;
    };
  }, [connected, stopping]);

  const toggle = async () => {
    if (!mode || saving || stopping) return;
    setSaving(true);
    setError('');
    try {
      const snapshot = await request<MediaMode>(endpoint, {
        method: 'PUT', body: JSON.stringify({ enabled: !mode.enabled, revision: mode.revision }),
      });
      applyMode(snapshot);
      channel.current?.postMessage(null);
    } catch (cause) {
      if ((cause as { status?: number }).status === 409) {
        try { applyMode(await request<MediaMode>(endpoint)); } catch { /* Retry when the page regains focus. */ }
      }
      setError(cause instanceof Error ? cause.message : '无法切换性能模式，请重试。');
    } finally { setSaving(false); }
  };

  const title = error || (!mode ? '正在读取性能模式' : mode.enabled
    ? `性能模式 · 后台 ${mode.analysisLimit} 路 · 封面悬停时保持静止`
    : `普通模式 · 后台 ${mode.analysisLimit} 路`);
  return <div className="performance-mode">
    <button type="button" className="performance-mode-toggle" role="switch" aria-label="性能模式"
      aria-checked={mode?.enabled ?? false} title={isLanClient ? title + ' · 在 Windows 主机设置' : title} disabled={isLanClient || !connected || !mode || saving || stopping}
      onClick={() => void toggle()}>
      <Zap size={14}/>性能模式
      <span aria-hidden="true">{saving || !mode ? '…' : mode.enabled ? '开' : '关'}</span>
    </button>
    {error && <span className="performance-mode-feedback" role="status">{error}</span>}
  </div>;
}
