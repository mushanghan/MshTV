import { lazy, Suspense, useEffect, useState } from 'react';
import { ArrowLeft, AudioLines, Check, ChevronRight, FolderOpen, FolderOutput, Group, Hand, ImagePlus, Layers, LoaderCircle, MousePointer2, PanelRightClose, PanelRightOpen, Plus, Redo2, RotateCcw, Save, StickyNote, Trash2, Undo2, Ungroup, Video, X } from 'lucide-react';
import { Canvas } from './canvas/Canvas';
import { Inspector } from './Inspector';
import { LibraryPanel } from './LibraryPanel';
import { MediaPreview } from './MediaPreview';
import { ServerControls } from './ServerControls';
import { PerformanceModeToggle } from './PerformanceMode';
import { fitCamera } from './canvas/geometry';
import { mediaLayout } from './canvas/mediaGeometry';
import { scrollPans, useScrollMode, type ScrollMode } from './canvas/useCanvasNavigation';
import { useCanvas } from './store';
import { samples } from './model';
import { loadBoard, returnToWorkspace, saveBoard, useConnection } from './api';
import { stopPlayback } from './playback';
import { boardId, isLanClient } from './navigation';
import { DeviceLogout } from './LanSession';
import { ThemeToggle } from './ThemeToggle';
import { SettingsMenu } from './SettingsMenu';

const ExportPanel = lazy(() => import('./ExportPanel'));
const FileClipboardButton = lazy(() => import('./FileClipboardButton'));
let initialized = false;
export function App() {
  const doc = useCanvas(s => s.doc), selected = useCanvas(s => s.selected), tool = useCanvas(s => s.tool), editable = useCanvas(s => s.editable);
  const past = useCanvas(s => s.past.length), future = useCanvas(s => s.future.length);
  const connection = useConnection(), [properties, setProperties] = useState(() => innerWidth > 800), [help, setHelp] = useState(false);
  const selectedGroups = useCanvas(s => s.selectedGroups);
  const [leaveError, setLeaveError] = useState('');
  const { mode: scrollMode, setMode: setScrollMode } = useScrollMode();
  const panWithScroll = scrollPans(scrollMode);
  const [exportScope, setExportScope] = useState<'selection' | 'board'>();
  const [exportVisible, setExportVisible] = useState(false);
  const openExport = (scope: 'selection' | 'board') => { setExportScope(scope); setExportVisible(true); };
  const grouped = selectedGroups.length > 0 || doc.items.some(i => selected.includes(i.id) && i.groupId);
  useEffect(() => { if (!initialized) { initialized = true; void loadBoard(); } }, []);
  useEffect(() => {
    const visibility = () => { if (document.hidden) stopPlayback(); };
    document.addEventListener('visibilitychange', visibility);
    return () => { document.removeEventListener('visibilitychange', visibility); stopPlayback(); };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input,textarea,select,[contenteditable=true]') || document.querySelector('.modal-backdrop')) return;
      const s = useCanvas.getState(), mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
      if (mod && key === 's') { e.preventDefault(); void saveBoard(); }
      else if (mod && key === 'z') { e.preventDefault(); if (e.shiftKey) s.redo(); else s.undo(); }
      else if (mod && key === 'y') { e.preventDefault(); s.redo(); }
      else if (mod && key === 'a') { e.preventDefault(); s.select(s.doc.items.map(i => i.id)); }
      else if (mod && key === 'g') { e.preventDefault(); if (e.shiftKey) s.ungroup(); else s.group(); }
      else if (key === 'delete' || key === 'backspace') { e.preventDefault(); s.remove(); }
      else if (key === 'escape') s.select([]);
      else if (!mod && key === 'n') s.add('note');
      else if (!mod && key === 'v') s.setTool('select');
      else if (!mod && key === 'h') s.setTool('hand');
      else if (!mod && key === 'f') { const r = document.querySelector('[data-canvas-host]')!.getBoundingClientRect(); s.setCamera(fitCamera([...s.doc.items.map(mediaLayout), ...s.doc.groups], r.width, r.height)); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (connection.status === 'saved' && boardId) sessionStorage.setItem('mshtv:last-board', boardId);
  }, [connection.status]);
  const leave = () => {
    setLeaveError('');
    void returnToWorkspace().catch(error => setLeaveError(error instanceof Error ? error.message : '无法返回工作空间。'));
  };
  const reload = () => { if (['dirty', 'error', 'saving', 'conflict'].includes(connection.status) && !window.confirm('重新加载会丢弃尚未保存的本地修改。继续？')) return; void loadBoard(); };
  return <div className="app-shell">
    <header className="app-header"><div className="brand">Msh<span>TV</span></div><span className="header-divider"/><button type="button" className="workspace-return" onClick={leave} aria-label="返回工作空间"><ArrowLeft size={15}/>工作空间</button><div className="breadcrumb"><ChevronRight size={13}/><strong title={doc.name}>{doc.name}</strong></div><div className="header-spacer"/>
      <div className={`connection ${connection.status}`} title={connection.message} aria-live="polite">{connection.status === 'saved' ? <Check size={13}/> : ['loading', 'saving'].includes(connection.status) ? <LoaderCircle size={13} className="spin"/> : <span className="status-dot"/>}<span>{connection.status === 'saved' ? '已保存到本机' : connection.status === 'dirty' ? '待保存' : connection.status === 'saving' ? '保存中' : connection.status === 'loading' ? '连接中' : connection.status === 'conflict' ? '版本冲突' : '连接或保存失败'}</span></div>
      <button className="icon-button" title="保存 (Ctrl+S)" aria-label="保存画布" disabled={connection.status === 'loading' || connection.status === 'saving' || connection.status === 'conflict'} onClick={() => void saveBoard()}><Save size={17}/></button>
      <button className="icon-button" title="重新加载后端画布" aria-label="重新加载" disabled={connection.status === 'saving'} onClick={reload}><RotateCcw size={17}/></button>
      <button className="icon-button" title="切换属性面板" aria-label="切换属性面板" onClick={() => setProperties(!properties)}>{properties ? <PanelRightClose size={18}/> : <PanelRightOpen size={18}/>}</button>
      <button className="icon-button" aria-label="导出选中内容" title={isLanClient ? '文件夹导出请在 Windows 主机操作' : '导出选中内容'} disabled={isLanClient || !selected.length && !selectedGroups.length && !exportScope} onClick={() => openExport('selection')}><FolderOutput size={17}/></button>
      <button className="icon-button" aria-label="导出整个画布" title={isLanClient ? '文件夹导出请在 Windows 主机操作' : '导出整个画布'} disabled={isLanClient || !doc.items.length && !exportScope} onClick={() => openExport('board')}><FolderOpen size={17}/></button>
      {!isLanClient && <Suspense fallback={null}><FileClipboardButton ready={editable} hasSelection={selected.length > 0 || selectedGroups.length > 0}/></Suspense>}
      {exportScope && <Suspense fallback={null}><ExportPanel initial={exportScope} visible={exportVisible} onClose={() => setExportVisible(false)}/></Suspense>}
      <PerformanceModeToggle connected={connection.status !== 'loading'}/>
      <ThemeToggle/>
      <SettingsMenu ready={connection.status !== 'loading'}/>
      {isLanClient ? <DeviceLogout/> : <ServerControls/>}
    </header>
    <div className="workspace">
      <LibraryPanel/>
      <main className="canvas-column">
        <div className="canvas-toolbar"><div className="tool-set"><button className={tool === 'select' ? 'active' : ''} aria-label="选择工具" title="选择 (V)" onClick={() => useCanvas.getState().setTool('select')}><MousePointer2 size={17}/></button><button className={tool === 'hand' ? 'active' : ''} aria-label="平移工具" title="平移 (H / 按住空格)" onClick={() => useCanvas.getState().setTool('hand')}><Hand size={17}/></button></div><span className="toolbar-divider"/><button aria-label="添加示例图片" title="添加示例图片" disabled={!editable} onClick={() => useCanvas.getState().add('image', samples[doc.items.length % samples.length].id)}><ImagePlus size={18}/></button><button aria-label="添加文字备注" title="文字备注 (N)" disabled={!editable} onClick={() => useCanvas.getState().add('note')}><StickyNote size={18}/></button><span className="toolbar-divider"/><button aria-label="撤销" title="撤销 (Ctrl+Z)" disabled={!editable || !past} onClick={() => useCanvas.getState().undo()}><Undo2 size={17}/></button><button aria-label="重做" title="重做 (Ctrl+Shift+Z)" disabled={!editable || !future} onClick={() => useCanvas.getState().redo()}><Redo2 size={17}/></button><span className="toolbar-divider"/><button aria-label="分组" title="分组 (Ctrl+G)" disabled={!editable || selected.length < 2} onClick={() => useCanvas.getState().group()}><Group size={17}/></button><button aria-label="解组" title="解组 (Ctrl+Shift+G)" disabled={!editable || !grouped} onClick={() => useCanvas.getState().ungroup()}><Ungroup size={17}/></button><button aria-label="删除选中" title="删除 (Delete)" disabled={!editable || (!selected.length && !selectedGroups.length)} onClick={() => useCanvas.getState().remove()}><Trash2 size={16}/></button><div className="header-spacer"/><button className="help-button" onClick={() => setHelp(!help)}>快捷键 <kbd>?</kbd></button></div>
        {['error', 'conflict'].includes(connection.status) && <div className="error-banner" role="alert"><span>{connection.message}</span>{connection.status === 'error' && <button onClick={() => acknowledgedRetry()}>重试连接 / 保存</button>}<button onClick={reload}>重新加载</button></div>}
        {leaveError && <div className="error-banner" role="alert">{leaveError}</div>}
        <Canvas/>
        <footer className="canvas-footer"><span><span className="tiny-dot"/>本机工作空间</span><span data-testid="item-count">{doc.items.length} 个元素{selected.length > 0 ? ` · 已选 ${selected.length} 项` : ''}</span><span className="header-spacer"/><span>{panWithScroll ? '双指平移 · 捏合缩放' : '滚轮缩放 · 空格拖动'} · Ctrl 多选</span></footer>
      </main>
      {properties && <aside className="properties-panel"><div className="panel-heading"><span>属性</span><button className="icon-button" aria-label="关闭属性面板" onClick={() => setProperties(false)}><X size={15}/></button></div>
        <Inspector/>
        <div className="properties-bottom"><span className="tiny-dot"/>自由组织，不限流程</div>
      </aside>}
    </div>
    <MediaPreview/>
    {help && <div className="modal-backdrop"><div className="help-dialog">
      <div className="panel-heading"><h2>画布快捷键</h2><button className="icon-button" aria-label="关闭快捷键" onClick={() => setHelp(false)}><X size={18}/></button></div>
      <label className="shortcut-row">滚动方式
        <select value={scrollMode} onChange={event => setScrollMode(event.target.value as ScrollMode)}>
          <option value="auto">自动</option><option value="trackpad">触控板 · 滚动平移</option><option value="mouse">鼠标 · 滚轮缩放</option>
        </select>
      </label>
      {[
        ['平移画布', panWithScroll ? '双指滑动 / 空格 + 拖动' : '空格 + 拖动 / 中键'],
        ['缩放', panWithScroll ? '捏合 / Ctrl 或 ⌘ + 滚动' : '鼠标滚轮 / 捏合'],
        ['框选 / 多选', '空白处拖动 / Ctrl'], ['选择 / 平移工具', 'V / H'], ['新建备注 / 适应全部', 'N / F'],
        ['全选 / 删除 / 取消选中', 'Ctrl+A / Delete / Esc'], ['分组 / 解组', 'Ctrl+G / Ctrl+Shift+G'],
        ['撤销 / 重做', 'Ctrl+Z / Ctrl+Shift+Z'], ['保存', 'Ctrl+S'], ['复制原文件（Windows 本机）', 'Ctrl+C'],
      ].map(([name, key]) => <div className="shortcut-row" key={name}><span>{name}</span><kbd>{key}</kbd></div>)}
      <p className="property-hint">macOS 上可使用 ⌘ 代替 Ctrl。撤销历史仅保留本次打开后的最近 60 次操作。</p>
    </div></div>}
  </div>;
}
function acknowledgedRetry() { if (useCanvas.getState().doc.items.length || useCanvas.getState().past.length) void saveBoard(); else void loadBoard(); }
