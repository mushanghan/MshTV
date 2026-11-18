import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { FolderOpen, X } from 'lucide-react';
import { flushBoard, request } from './api';
import { useCanvas } from './store';
import { fileSize } from './library';
import { stopPlayback } from './playback';

type Scope = 'selection' | 'board';
interface ExportJob {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
  path: string | null;
  total: number;
  succeeded: number;
  failed: number;
  current: string | null;
  fileBytes: number;
  copiedBytes: number;
  error: string | null;
  failures: { folder: string; name: string; reason: string }[];
}
const directoryKey = 'mshtv-export-directory';
const labels = { queued: '等待导出', running: '正在导出', completed: '导出完成', cancelled: '已取消', failed: '导出中断' };

export default function ExportPanel({ initial, visible, onClose }: {
  initial: Scope; visible: boolean; onClose: () => void;
}) {
  const items = useCanvas(state => state.doc.items);
  const itemIds = useCanvas(state => state.selected);
  const groupIds = useCanvas(state => state.selectedGroups);
  const [scope, setScope] = useState<Scope>(initial);
  const [parent, setParent] = useState(() => {
    try { return localStorage.getItem(directoryKey) ?? ''; }
    catch { return ''; }
  });
  const [name, setName] = useState('MshTV_Export');
  const [job, setJob] = useState<ExportJob>();
  const [starting, setStarting] = useState(false);
  const [picking, setPicking] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState('');
  const active = job?.status === 'queued' || job?.status === 'running';
  const counts = useMemo(() => {
    const selected = new Set(itemIds), groups = new Set(groupIds);
    const board = new Set<string>(), selection = new Set<string>();
    for (const item of items) {
      if (item.type === 'note' || !item.assetId || !/^[0-9a-f-]{36}$/i.test(item.assetId)) continue;
      const key = `${item.groupId ?? ''}/${item.assetId.toLowerCase()}`;
      board.add(key);
      if (selected.has(item.id) || (item.groupId && groups.has(item.groupId))) selection.add(key);
    }
    return { board: board.size, selection: selection.size };
  }, [items, itemIds, groupIds]);

  useEffect(() => {
    if (!active || !job) return;
    const id = job.id;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await request<ExportJob>(`/exports/${id}`);
        if (disposed) return;
        setJob(next);
        setError('');
        if (next.status !== 'queued' && next.status !== 'running') return;
      } catch (error) {
        if (disposed) return;
        if ((error as { status?: number }).status === 404) {
          setJob(current => current && { ...current, status: 'failed', error: '导出任务已失效。请查看目标目录中的导出报告。' });
          return;
        }
        setError('暂时无法读取导出进度，正在重新连接。');
      }
      timer = setTimeout(poll, 500);
    };
    timer = setTimeout(poll, 500);
    return () => { disposed = true; clearTimeout(timer); };
  }, [active, job?.id]);

  useEffect(() => { if (visible) stopPlayback(); }, [visible]);
  useEffect(() => { if (!job && visible) setScope(initial); }, [initial, visible]);
  useEffect(() => {
    if (!visible) return;
    let disposed = false;
    void request<{ job: ExportJob | null }>('/exports/active').then(({ job: activeJob }) => {
      if (activeJob && !disposed) setJob(current => current ?? activeJob);
    }).catch(() => {});
    return () => { disposed = true; };
  }, [visible]);
  const pickFolder = async () => {
    setPicking(true);
    setError('');
    try {
      const { path } = await request<{ path: string | null }>('/exports/pick-folder', {
        method: 'POST',
        body: JSON.stringify({ initialDirectory: parent.trim() }),
        signal: AbortSignal.timeout(11 * 60 * 1000),
      });
      if (path !== null) setParent(path);
    } catch (error) { setError(error instanceof Error ? error.message : '无法打开文件夹选择器。'); }
    finally { setPicking(false); }
  };
  const start = async (event: FormEvent) => {
    event.preventDefault();
    setStarting(true);
    setError('');
    try {
      const revision = await flushBoard('导出');
      const { selected, selectedGroups } = useCanvas.getState();
      const accepted = await request<ExportJob>('/exports', { method: 'POST', body: JSON.stringify({
        revision, scope, itemIds: scope === 'selection' ? selected : [], groupIds: scope === 'selection' ? selectedGroups : [],
        parent: parent.trim(), name: name.trim(),
      }) });
      setJob(accepted);
      try { localStorage.setItem(directoryKey, parent.trim()); } catch { /* Export can proceed with storage disabled. */ }
    } catch (error) { setError(error instanceof Error ? error.message : '无法开始导出。'); }
    finally { setStarting(false); }
  };
  const cancel = async () => {
    if (!job) return;
    setCancelling(true);
    try { await request(`/exports/${job.id}/cancel`, { method: 'POST' }); }
    catch { setError('无法取消导出，请重试。'); }
    finally { setCancelling(false); }
  };
  const openFolder = async (id: string) => {
    setError('');
    try { await request(`/exports/${id}/open`, { method: 'POST' }); }
    catch (error) { setError(error instanceof Error ? error.message : '无法打开导出文件夹。'); }
  };
  if (!visible) return null;
  return <div className="modal-backdrop"><section className="shutdown-dialog export-dialog" role="dialog" aria-modal="true" aria-label="导出原始素材">
      <div className="panel-heading"><h2>导出原始素材</h2><button className="icon-button" aria-label="关闭导出窗口" disabled={starting || picking} onClick={onClose}><X size={17}/></button></div>
      {job ? <>
        <p role="status">{labels[job.status]} · {job.total} 个文件 · 成功 {job.succeeded} · 失败 {job.failed} · 未完成 {job.total - job.succeeded - job.failed}</p>
        <progress aria-label="导出进度" max={job.total} value={job.succeeded + job.failed + (active && job.fileBytes ? job.copiedBytes / job.fileBytes : 0)}/>
        {active && job.current && <p>{job.current} · {job.copiedBytes ? fileSize(job.copiedBytes) : '0 B'} / {fileSize(job.fileBytes)}</p>}
        {job.path && <p className="export-path"><strong>Windows 导出位置</strong><br/>{job.path}</p>}
        {job.error && <p role="alert">{job.error}</p>}
        {job.failures.length > 0 && <details open><summary>失败明细</summary><ul>{job.failures.map((failure, index) =>
          <li key={index}>{failure.folder} / {failure.name} · {failure.reason}</li>)}</ul>
          {job.failed > job.failures.length && <p>其余明细请查看导出报告.txt。</p>}</details>}
        <div className="dialog-actions">
          {active ? <><button onClick={onClose}>后台运行</button><button onClick={() => void cancel()} disabled={cancelling}>取消导出</button></> :
            <><button onClick={() => { setJob(undefined); setScope(initial); setError(''); }}>再次导出</button>
              {job.path && <button onClick={() => void openFolder(job.id)}>在 Windows 中打开文件夹</button>}</>}
        </div>
      </> : <form onSubmit={event => void start(event)}>
        <label>导出范围<select value={scope} onChange={event => setScope(event.target.value as Scope)} disabled={starting}>
          <option value="selection">选中内容 · {counts.selection} 个文件</option>
          <option value="board">整个画布 · {counts.board} 个文件</option>
        </select></label>
        <label htmlFor="export-parent">Windows 导出目标目录</label>
        <div className="export-directory-field">
          <input id="export-parent" value={parent} onChange={event => setParent(event.target.value)} disabled={starting || picking}
            required maxLength={1024} placeholder="D:\\Exports"/>
          <button type="button" disabled={starting || picking} onClick={() => void pickFolder()}><FolderOpen size={15}/>选择文件夹</button>
        </div>
        {picking ? <p role="status">请在 Windows 桌面上的选择窗口中确认或取消。</p> :
          <p>选择运行 MshTV 的 Windows 电脑上的文件夹，MshTV 会在其中新建导出目录。</p>}
        <label>导出文件夹名称<input value={name} onChange={event => setName(event.target.value)} disabled={starting} required maxLength={100}/></label>
        <div className="dialog-actions"><button type="submit" disabled={starting || picking || !counts[scope]}>
          {starting ? '正在保存画布…' : '开始导出'}</button></div>
      </form>}
      {error && <p role="alert">{error}</p>}
    </section></div>;
}
