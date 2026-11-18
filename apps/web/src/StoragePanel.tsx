import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { request } from './api';
import { fileSize } from './library';

type Operation = 'backup' | 'migrate' | 'restore';
interface StorageStatus {
  directory: string;
  pending?: { operation: Operation; parent: string; targetDirectory?: string | null } | null;
  last?: { operation: Operation; directory?: string; error?: string } | null;
}
interface Check {
  sqlite: boolean; boards: number; missing: number; offline: number; broken: number;
  space: Record<'database' | 'cache' | 'imports' | 'backups' | 'free' | 'external', number>;
}
const names = { backup: '备份', migrate: '更改工作目录', restore: '恢复备份' };
const labels = { database: '数据库', cache: '预览缓存', imports: '导入副本', backups: '目录内的升级备份', free: '当前磁盘可用', external: '外部素材索引大小' };
const storageSize = (size: number) => size === 0 ? '0 B' : fileSize(size);

export function StoragePanel({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<StorageStatus>();
  const [check, setCheck] = useState<Check>();
  const [section, setSection] = useState<'storage' | 'backup'>('storage');
  const [changingDirectory, setChangingDirectory] = useState(false);
  const [newDirectory, setNewDirectory] = useState('');
  const [operation, setOperation] = useState<'backup' | 'restore'>('backup');
  const [parent, setParent] = useState('');
  const [backup, setBackup] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    void request<StorageStatus>('/storage/status', { signal: controller.signal }).then(setStatus)
      .catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, []);

  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try { await work(); }
    catch (e) { setError(e instanceof Error ? e.message : '操作失败。'); }
    finally { setBusy(false); }
  }
  const post = <T,>(path: string, body: object = {}, timeout = 300000) =>
    request<T>('/storage/' + path, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  const refresh = async () => setStatus(await request<StorageStatus>('/storage/status'));
  const inspect = async () => setCheck(await post<Check>('check'));
  const pick = async (value: string, set: (next: string) => void) => {
    const result = await post<{ path: string | null }>('pick-folder', { initialDirectory: value }, 600000);
    if (result.path) set(result.path);
  };
  const schedule = async (job: object) => { await post('jobs', job); await refresh(); };
  const showLast = status?.last && (status.last.operation === 'migrate') === (section === 'storage');
  return <div className="modal-backdrop" onKeyDown={e => {
    if (e.key === 'Escape' && !busy) { e.stopPropagation(); onClose(); }
  }}>
    <section className="workspace-dialog storage-dialog" role="dialog" aria-modal="true" aria-label="存储与维护">
      <div className="panel-heading"><h2>存储与维护</h2><button type="button" autoFocus className="icon-button" aria-label="关闭存储与维护" disabled={busy} onClick={onClose}><X size={18}/></button></div>
      <div className="storage-tabs" role="group" aria-label="维护页面">
        <button type="button" className="workspace-button" aria-pressed={section === 'storage'} disabled={busy} onClick={() => setSection('storage')}>存储设置</button>
        <button type="button" className="workspace-button" aria-pressed={section === 'backup'} disabled={busy} onClick={() => setSection('backup')}>备份与恢复</button>
      </div>
      {status?.pending && <div className="storage-pending">
        <p role="status">重启后执行{names[status.pending.operation]} · {status.pending.targetDirectory ?? status.pending.parent}</p>
        <button className="workspace-button" disabled={busy} onClick={() => void run(async () => {
          await request('/storage/jobs', { method: 'DELETE' }); await refresh();
        })}>取消待执行任务</button>
      </div>}
      {showLast && status?.last && <p role={status.last.error ? 'alert' : 'status'}>
        {names[status.last.operation]}{status.last.error ? '失败。' + status.last.error : '完成。' + status.last.directory}
      </p>}
      {section === 'storage' ? <>
      <div className="storage-directory">
        <h3>工作目录</h3>
        {status && <>
          <code>{status.directory}</code>
          <div className="storage-actions">
            <button className="workspace-button" disabled={busy} onClick={() => void run(async () => { await post('open'); })}>在资源管理器中打开</button>
            <button type="button" className="workspace-button" aria-expanded={changingDirectory} disabled={busy || Boolean(status.pending)}
              onClick={() => setChangingDirectory(value => !value)}>{changingDirectory ? '收起目录设置' : '更改工作目录'}</button>
          </div>
        </>}
        {changingDirectory && !status?.pending && <form onSubmit={e => {
          e.preventDefault();
          void run(async () => {
            await schedule({ operation: 'migrate', targetDirectory: newDirectory });
            setChangingDirectory(false);
            setNewDirectory('');
          });
        }}>
          <label>新工作目录<span className="storage-path"><input aria-label="新工作目录" value={newDirectory} required onChange={e => setNewDirectory(e.target.value)}/>
            <button className="workspace-button" type="button" disabled={busy} onClick={() => void run(() => pick(newDirectory, setNewDirectory))}>选择文件夹</button></span></label>
          <p>请选择一个空文件夹。重启后复制并校验数据，再切换到所选目录。</p>
          <button type="submit" className="workspace-button primary" disabled={busy || !newDirectory.trim()}>保存目录设置</button>
        </form>}
      </div>
      <h3>磁盘空间与完整性</h3>
      <div className="storage-actions">
        <button className="workspace-button" disabled={busy || !status} onClick={() => void run(inspect)}>立即检查</button>
        <button className="workspace-button" disabled={busy || !check || check.space.cache === 0}
          onBlur={() => setConfirmClear(false)}
          onClick={() => {
            if (!confirmClear) { setConfirmClear(true); return; }
            setConfirmClear(false);
            void run(async () => {
              const result = await post<{ removed: number; skipped: number; bytes: number }>('clear-cache');
              await inspect();
              setMessage(`已清理 ${result.removed} 项，释放 ${storageSize(result.bytes)}。跳过 ${result.skipped} 项。`);
            });
          }}>{confirmClear ? '确认清理预览缓存' : '清理预览缓存'}</button>
      </div>
      {check && <>
        <dl>{(Object.keys(labels) as (keyof Check['space'])[]).map(key =>
          <div key={key}><dt>{labels[key]}</dt><dd>{storageSize(check.space[key])}</dd></div>)}</dl>
        <p>数据库{check.sqlite ? '检查通过' : '检查未通过'} · {check.boards} 张画布 · {check.offline} 个目录离线 · {check.missing} 个素材标记缺失 · {check.broken} 条引用异常</p>
      </>}
      <p>预览缓存会按需重建。素材原件保留在各自的来源文件夹中。</p>
      </> : <>
      <h3>整库备份与恢复</h3>
      <p>备份包含所有画布及导入副本，安排后在下次启动时执行。恢复会创建新的工作目录。</p>
      {!status?.pending && <form onSubmit={e => {
        e.preventDefault();
        void run(() => schedule({ operation, parent, backup: operation === 'restore' ? backup : null }));
      }}>
        <label>操作<select value={operation} onChange={e => setOperation(e.target.value as 'backup' | 'restore')}>
          <option value="backup">创建备份</option><option value="restore">从备份恢复</option>
        </select></label>
        {operation === 'restore' && <label>备份文件夹<span className="storage-path"><input value={backup} required onChange={e => setBackup(e.target.value)}/>
          <button className="workspace-button" type="button" disabled={busy} onClick={() => void run(() => pick(backup, setBackup))}>选择备份</button></span></label>}
        <label>{operation === 'backup' ? '备份保存位置' : '恢复目标位置'}<span className="storage-path"><input value={parent} required onChange={e => setParent(e.target.value)}/>
          <button className="workspace-button" type="button" disabled={busy} onClick={() => void run(() => pick(parent, setParent))}>选择目标</button></span></label>
        <button type="submit" className="workspace-button primary" disabled={busy || !status}>安排在重启时执行</button>
      </form>}
      </>}
      {busy && <p role="status">正在处理…</p>}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  </div>;
}
