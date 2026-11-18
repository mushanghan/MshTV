import { useEffect, useMemo, useState } from 'react';
import { AudioLines, Folder, FolderPlus, Plus, RefreshCw, Search, StickyNote, Trash2, Video, X } from 'lucide-react';
import { HubConnectionBuilder, HttpTransportType, LogLevel } from '@microsoft/signalr';
import { request, useConnection, useLanSession } from './api';
import { ASSET_DRAG_TYPE, cacheAssets, fileSize, folderName, invalidateLibrary, invalidateLibraryBatch, statusLabel, useLibraryRevision, type AssetPage, type Root } from './library';
import { samples } from './model';
import { useCanvas } from './store';
import { useServerState } from './serverState';
import { usePerformanceMode } from './PerformanceMode';
import { LibraryAudioControls, LibraryThumbnail } from './LibraryMedia';
import { isLanClient, scopedApiUrl } from './navigation';
import { InlineDeleteButton } from './InlineDeleteButton';

export function LibraryPanel() {
  const connection = useConnection(), editable = useCanvas(s => s.editable), revision = useLibraryRevision();
  const canvasItems = useCanvas(s => s.doc.items);
  const canvasAssetIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of canvasItems) if (item.assetId) ids.add(item.assetId);
    return ids;
  }, [canvasItems]);
  const [roots, setRoots] = useState<Root[]>([]), [page, setPage] = useState<AssetPage>({ items: [], nextCursor: null });
  const [query, setQuery] = useState(''), [kind, setKind] = useState(''), [sort, setSort] = useState('added:desc');
  const [cursor, setCursor] = useState(''), [history, setHistory] = useState<string[]>([]), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const [manage, setManage] = useState(false), [path, setPath] = useState(''), [busy, setBusy] = useState(false), [tools, setTools] = useState(true);
  const [includeSubdirectories, setIncludeSubdirectories] = useState(true), [newFilesOnly, setNewFilesOnly] = useState(false);
  const [rootId, setRootId] = useState('');
  const [monitorSupported, setMonitorSupported] = useState<boolean | null>(null);
  const stopping = useServerState(s => s.stopping);
  const hoverEnabled = usePerformanceMode(s => !s.mode?.enabled);
  const paired = useLanSession(s => s.state === 'connected');
  const available = connection.status !== 'loading' && !stopping && (!isLanClient || paired);
  useEffect(() => {
    if (!available || monitorSupported !== null) return; let alive = true;
    const check = () => { void request<{ monitorOptionsVersion?: number }>('/health').then(data => { if (alive) setMonitorSupported(data.monitorOptionsVersion === 1); }).catch(() => {}); };
    check(); const timer = setInterval(check, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [available, monitorSupported]);
  useEffect(() => {
    if (!available) return;
    const hub = new HubConnectionBuilder().withUrl(scopedApiUrl('/api/v1/events'), { transport: HttpTransportType.WebSockets, skipNegotiation: true }).withAutomaticReconnect().configureLogging(LogLevel.None).build();
    const changedIds = new Set<string>();
    let allAssets = false, changeTimer: ReturnType<typeof setTimeout> | undefined;
    hub.on('LibraryChanged', (data: { assetId?: string; allAssets?: boolean }) => {
      allAssets ||= !!data.allAssets || changedIds.size >= 512;
      if (allAssets) changedIds.clear();
      else if (data.assetId) changedIds.add(data.assetId);
      changeTimer ??= setTimeout(() => {
        changeTimer = undefined;
        invalidateLibraryBatch(changedIds, allAssets);
        changedIds.clear(); allAssets = false;
      }, 300);
    });
    hub.onreconnected(() => invalidateLibrary(null, true));
    void hub.start().catch(() => {});
    const timer = setInterval(() => invalidateLibrary(null, true), 10000);
    const focus = () => invalidateLibrary(null, true); window.addEventListener('focus', focus);
    return () => { clearTimeout(changeTimer); clearInterval(timer); window.removeEventListener('focus', focus); void hub.stop(); };
  }, [available]);
  useEffect(() => {
    if (!available) return; let alive = true;
    void request<Root[]>('/library/roots?includeImports=true').then(data => { if (alive) setRoots(data); }).catch(() => {});
    return () => { alive = false; };
  }, [available, revision]);
  useEffect(() => {
    if (!available) return; let alive = true;
    void request<{ ffmpeg: boolean; ffprobe: boolean }>('/library/tools').then(data => { if (alive) setTools(data.ffmpeg && data.ffprobe); }).catch(() => {});
    return () => { alive = false; };
  }, [available]);
  useEffect(() => { setCursor(''); setHistory([]); }, [query, kind, sort, rootId]);
  useEffect(() => { if (rootId && !roots.some(root => root.id === rootId)) setRootId(''); }, [roots, rootId]);
  useEffect(() => {
    if (!available) return;
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      const [field, direction] = sort.split(':');
      const params = new URLSearchParams({ q: query, kind, sort: field, direction, limit: '50', cursor, rootId });
      void request<AssetPage>(`/assets?${params}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]) })
        .then(data => { if (!controller.signal.aborted) { cacheAssets(data.items, revision); setPage(data); setError(''); } })
        .catch(e => { if (!controller.signal.aborted) setError(e.message); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 180);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [available, query, kind, sort, cursor, rootId, revision]);
  const command = async (url: string, method: string, body?: object) => {
    if (url.startsWith('/library/roots') && (method === 'POST' || method === 'PATCH') && monitorSupported !== true) {
      setError('尚未确认后端支持这些监控选项，请关闭旧后端并重新运行 start.cmd。'); return false;
    }
    setBusy(true); setError('');
    try { await request(url, { method, body: body ? JSON.stringify(body) : '{}' }); setRoots(await request<Root[]>('/library/roots?includeImports=true')); invalidateLibrary(null, true); return true; }
    catch (e) { setError(e instanceof Error ? e.message : '请求失败'); invalidateLibrary(null, true); return false; }
    finally { setBusy(false); }
  };
  const deleteFolder = (root: Root) => void command(`/library/roots/${root.id}/library?revision=${root.revision}`, 'DELETE');
  const deleteFolderTitle = '从素材库删除文件夹及其全部素材并停止监控，保留磁盘原件';
  const watchedRoots = roots.filter(root => !root.managed);
  const sourceNames = new Map(roots.map(root => [root.id, root.managed ? '拖入导入' : folderName(root.path)]));
  return <aside className="library-panel">
    <div className="panel-heading"><span>素材库</span><button className="icon-button" aria-label="管理监控文件夹" disabled={isLanClient}
      title={isLanClient ? '请在 Windows 主机管理监控文件夹' : '管理 Windows 后端文件夹'} onClick={() => setManage(true)}><FolderPlus size={17}/></button></div>
    <div className="library-search"><Search size={13}/><input aria-label="搜索素材文件名" placeholder="搜索文件名" value={query} onChange={e => setQuery(e.target.value)}/></div>
    {roots.length > 0 && <nav className="library-folders" aria-label="素材来源文件夹">
      <button className="library-folder-all" aria-pressed={!rootId} onClick={() => setRootId('')}>全部素材</button>
      {roots.map(root => <div key={root.id} className="library-folder-row">
        <button title={root.managed ? '从电脑拖入的素材' : root.path} aria-label={root.managed ? '拖入导入' : `查看文件夹 ${root.path}`} aria-pressed={rootId === root.id} onClick={() => setRootId(root.id)}><Folder size={13}/><span>{sourceNames.get(root.id)}</span></button>
        {!root.managed && !isLanClient && <InlineDeleteButton key={root.revision} className="icon-button" disabled={busy} title={deleteFolderTitle}
          label={`删除素材文件夹 ${root.path}`} onConfirm={() => deleteFolder(root)}><Trash2 size={12}/></InlineDeleteButton>}
      </div>)}
    </nav>}
    <div className="library-filters"><select aria-label="素材类型" value={kind} onChange={e => setKind(e.target.value)}><option value="">全部类型</option><option value="image">图片</option><option value="video">视频</option><option value="audio">音频</option></select><select aria-label="素材排序" value={sort} onChange={e => setSort(e.target.value)}><option value="added:desc">最新添加</option><option value="modified:desc">最近修改</option><option value="added:asc">最早添加</option><option value="modified:asc">最早修改</option></select></div>
    {error && <p className="library-error" role="alert">{error}</p>}
    {!tools && <p className="panel-description">未找到校验通过的媒体工具，封面和时长可能不可用；仍可原生预览。配置说明见 README。</p>}
    <div className="library-section-title"><span>{loading ? '正在读取…' : '拖动素材到画布'}</span><button className="icon-button" aria-label="刷新素材库" onClick={() => invalidateLibrary()}><RefreshCw size={12}/></button></div>
    <div className="asset-list">{page.items.map(asset => <div key={asset.id} className="asset-row" data-testid={`asset-${asset.id}`}
      draggable={editable && asset.status === 'ready'}
      onPointerDownCapture={event => {
        // Let range dragging own this gesture; the next press on the card can drag the asset again.
        event.currentTarget.draggable = editable && asset.status === 'ready' && !(event.target as Element).closest('[data-media-controls]');
      }}
      onDragStart={e => { e.dataTransfer.setData(ASSET_DRAG_TYPE, asset.id); e.dataTransfer.effectAllowed = 'copy'; }}>
      <LibraryThumbnail asset={asset} hoverEnabled={hoverEnabled} inCanvas={canvasAssetIds.has(asset.id)}/>
      <div className="asset-description" title={`${asset.name}\n${roots.find(root => root.id === asset.rootId)?.path ?? ''}${asset.folder ? '\\' + asset.folder : ''}\n${asset.extension} · ${fileSize(asset.size)}\n${statusLabel(asset.status)}${asset.error ? '\n' + asset.error : ''}`}><span>{asset.name}</span><small>{asset.extension.slice(1).toUpperCase()} · {fileSize(asset.size)}</small><small className="asset-source">{sourceNames.get(asset.rootId) ?? (!asset.rootId ? '画布引用' : '')}{asset.folder ? ' / ' + asset.folder : ''}</small>{asset.folder && roots.find(root => root.id === asset.rootId)?.includeSubdirectories === false && <em>已收录 · 当前不监控子目录</em>}{asset.status !== 'ready' && <em>{statusLabel(asset.status)}</em>}{asset.kind === 'audio' && <LibraryAudioControls asset={asset}/>}</div>
      <InlineDeleteButton key={asset.revision} className="icon-button asset-remove" disabled={busy} title="从素材库删除，保留磁盘原件"
        label={`删除素材 ${asset.name}`} onConfirm={() => void command(`/assets/${asset.id}?revision=${asset.revision}`, 'DELETE')}><Trash2 size={13}/></InlineDeleteButton>
    </div>)}</div>
    {roots.length > 0 && !page.items.length && !loading && <p className="panel-description">暂无匹配素材。目录扫描和写入检测在后台进行。</p>}
    {(history.length > 0 || page.nextCursor) && <div className="library-pages"><button disabled={!history.length} onClick={() => { setCursor(history.at(-1)!); setHistory(history.slice(0, -1)); }}>上一页</button><span>{history.length + 1}</span><button disabled={!page.nextCursor} onClick={() => { setHistory([...history, cursor]); setCursor(page.nextCursor!); }}>下一页</button></div>}
    {!roots.length && <><p className="panel-description">添加后端文件夹开始整理素材。下方保留离线示例。</p><button className="wide-button" onClick={() => setManage(true)}><FolderPlus size={15}/>添加监控文件夹</button><div className="sample-list">{samples.map((sample, i) => <button key={sample.id} className="sample-card" disabled={!editable} onClick={() => useCanvas.getState().add('image', sample.id)}><div className="sample-thumb"><img src={sample.url} alt={sample.title}/><span className="sample-add"><Plus size={16}/></span><span className="sample-index">0{i + 1}</span></div><div className="sample-title">{sample.title}<span>示例</span></div></button>)}</div></>}
    <div className="section-rule"/><div className="add-options"><button disabled={!editable} onClick={() => useCanvas.getState().add('video')}><Video size={17}/><span>视频占位卡片</span><Plus size={14}/></button><button disabled={!editable} onClick={() => useCanvas.getState().add('audio')}><AudioLines size={17}/><span>音频占位卡片</span><Plus size={14}/></button><button disabled={!editable} onClick={() => useCanvas.getState().add('note')}><StickyNote size={17}/><span>文字备注</span><kbd>N</kbd></button></div>
    {manage && <div className="modal-backdrop"><div className="folder-dialog"><div className="panel-heading"><h2>监控文件夹</h2><button aria-label="关闭文件夹管理" className="icon-button" onClick={() => setManage(false)}><X size={18}/></button></div><p>路径属于 <strong>Windows 后端电脑</strong>，不是浏览器所在设备。原始文件只读；移除来源不会删除文件或画布卡片。</p>
      {monitorSupported !== true && <p className="library-error" role="alert">{monitorSupported === false ? '前后端版本不匹配：当前后端未确认支持监控选项。请关闭旧后端并重新运行 start.cmd 后刷新页面，再添加或修改目录。' : '正在确认后端监控选项，请稍候；如持续未确认，请重启后端。'}</p>}
      <h3 className="monitor-section-heading">添加新文件夹</h3>
      <MonitorOptions label="新文件夹监控选项" recursive={includeSubdirectories} newOnly={newFilesOnly} disabled={busy || monitorSupported !== true} onChange={(recursive, onlyNew) => { setIncludeSubdirectories(recursive); setNewFilesOnly(onlyNew); }}/>
      <p className="monitor-help">上方选项仅用于下面新添加的目录；修改已有目录，请使用下方对应文件夹的选项。</p>
      <p className="monitor-help">只计入新文件：先记录当前已有文件，初始化完成后收录新增文件。不会清除已经入库的素材。</p>
      <form onSubmit={async e => { e.preventDefault(); if (await command('/library/roots', 'POST', { path, includeSubdirectories, newFilesOnly })) setPath(''); }}><input aria-label="Windows 后端文件夹路径" value={path} placeholder="例如 D:\\影视素材\\项目一" onChange={e => setPath(e.target.value)} required/><button disabled={busy || monitorSupported !== true} type="submit">添加目录</button></form>
      {error && <p className="library-error" role="alert">{error}</p>}
      {watchedRoots.length > 0 && <h3 className="monitor-section-heading">已添加的文件夹 · 下方选项立即保存</h3>}
      <div className="root-list">{watchedRoots.map(root => <div key={root.id} className="root-row"><strong>{root.path}</strong><small>{!root.online ? '离线' : !root.enabled ? '已暂停' : root.baselinePending ? '正在记录已有文件，完成后接收新增' : '监控中'} {root.error}</small>
        <small className="root-scan-scope">扫描范围：{typeof root.includeSubdirectories !== 'boolean' ? '尚未确认' : root.includeSubdirectories ? '当前文件夹及全部子文件夹' : '仅当前文件夹（不扫描子文件夹）'}</small>
        {!root.includeSubdirectories && <p className="monitor-help">之前收录的子目录素材仍保留；取消勾选只停止后续子目录扫描，不会删除已有素材。</p>}
        <MonitorOptions label={`监控选项 ${root.path}`} recursive={root.includeSubdirectories} newOnly={root.newFilesOnly} disabled={busy || monitorSupported !== true} onChange={(recursive, onlyNew) => void command(`/library/roots/${root.id}`, 'PATCH', { enabled: root.enabled, revision: root.revision, includeSubdirectories: recursive, newFilesOnly: onlyNew })}/>
        <div><button disabled={busy} onClick={() => void command(`/library/roots/${root.id}`, 'PATCH', { enabled: !root.enabled, revision: root.revision })}>{root.enabled ? '暂停' : '启用'}</button><button disabled={busy} onClick={() => void command(`/library/roots/${root.id}/scan`, 'POST')}>重新扫描</button><button disabled={busy} title="停止监控并撤销访问，保留库内记录" onClick={() => void command(`/library/roots/${root.id}?revision=${root.revision}`, 'DELETE')}>移除配置</button>
          <InlineDeleteButton key={root.revision} className="remove-library-folder" disabled={busy} title={deleteFolderTitle}
            label={`删除文件夹 ${root.path}`} onConfirm={() => deleteFolder(root)}>删除文件夹</InlineDeleteButton></div></div>)}</div>
    </div></div>}
  </aside>;
}

function MonitorOptions({ label, recursive, newOnly, disabled, onChange }: { label: string; recursive: boolean; newOnly: boolean; disabled: boolean; onChange: (recursive: boolean, newOnly: boolean) => void }) {
  const [draft, setDraft] = useState({ recursive, newOnly });
  useEffect(() => { if (!disabled) setDraft({ recursive, newOnly }); }, [recursive, newOnly, disabled]);
  const change = (recursive: boolean, newOnly: boolean) => { setDraft({ recursive, newOnly }); onChange(recursive, newOnly); };
  return <fieldset className="monitor-options" aria-label={label} disabled={disabled}>
    <label><input type="checkbox" checked={draft.recursive} onChange={e => change(e.target.checked, draft.newOnly)}/>包含子文件夹</label>
    <label><input type="checkbox" checked={draft.newOnly} onChange={e => change(draft.recursive, e.target.checked)}/>只计入新文件</label>
  </fieldset>;
}
