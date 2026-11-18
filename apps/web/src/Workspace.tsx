import { useEffect, useRef, useState, type DragEvent, type FormEvent, type MouseEvent } from 'react';
import { ArrowLeft, ChevronRight, Folder, Layers, MoreHorizontal, Pin, Plus, Search, Trash2, X } from 'lucide-react';
import { connectSession, request } from './api';
import { boardUrl, isLanClient } from './navigation';
import { InlineDeleteButton } from './InlineDeleteButton';
import { ServerControls } from './ServerControls';
import { DeviceLogout } from './LanSession';
import { ThemeToggle } from './ThemeToggle';
import { SettingsMenu } from './SettingsMenu';
import { useTheme } from './theme';

interface BoardCard { id: string; name: string; groupId: string | null; revision: number; createdAt: number; modifiedAt: number; deletedAt: number | null; pinned: boolean }
interface GroupCard { id: string; name: string; revision: number; createdAt: number; deletedAt: number | null; boardCount: number }
interface WorkspaceData { boards: BoardCard[]; groups: GroupCard[] }
type Edit = 'rename' | 'copy' | 'move' | 'restore';
type QuickEdit = 'move' | 'delete' | 'pin' | 'purge';
type Target = { kind: 'boards'; row: BoardCard } | { kind: 'groups'; row: GroupCard };
type Action = { kind: 'new-board'; groupId: string | null } | { kind: 'new-group' } | { kind: Edit; target: Target };
const titles: Record<Action['kind'], string> = {
  'new-board': '新建画布', 'new-group': '新建画布组', rename: '重命名', copy: '复制画布',
  move: '移动画布', restore: '恢复',
};
const BOARD_DRAG_TYPE = 'application/x-mshtv-board';
const timestamp = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' });

export default function Workspace() {
  const lightTheme = useTheme(state => state.theme === 'light');
  const [data, setData] = useState<WorkspaceData>();
  const [groupId, setGroupId] = useState<string | null>(null);
  const [trash, setTrash] = useState(false);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'recent' | 'old'>('recent');
  const [action, setAction] = useState<Action>();
  const [name, setName] = useState('');
  const [destination, setDestination] = useState('');
  const [menu, setMenu] = useState('');
  const [createMenu, setCreateMenu] = useState<{ x: number; y: number } | null>(null);
  const draggedBoard = useRef<BoardCard | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dropGroup, setDropGroup] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dialogError, setDialogError] = useState('');
  const projectInput = useRef<HTMLInputElement>(null);

  const read = () => request<WorkspaceData>('/workspace');
  const refresh = () => { setError(''); void read().then(setData).catch(e => setError(e.message)); };
  useEffect(() => {
    document.title = 'MshTV · 工作空间';
    let active = true;
    void connectSession().then(read).then(value => { if (active) setData(value); })
      .catch(e => { if (active) setError(e.message); });
    window.addEventListener('pageshow', refreshWorkspace);
    window.addEventListener('focus', refresh);
    function refreshWorkspace(event: PageTransitionEvent) { if (event.persisted) refresh(); }
    return () => { active = false; window.removeEventListener('pageshow', refreshWorkspace); window.removeEventListener('focus', refresh); };
  }, []);

  const liveGroups = data?.groups.filter(group => !group.deletedAt) ?? [];
  const group = liveGroups.find(row => row.id === groupId);
  const activeBoards = data?.boards.filter(board => !board.deletedAt && (!board.groupId || liveGroups.some(group => group.id === board.groupId))) ?? [];
  const last = activeBoards.find(board => board.id === sessionStorage.getItem('mshtv:last-board'));
  const matches = (row: { name: string }) => row.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const groups = (trash ? data?.groups.filter(row => row.deletedAt) ?? [] : group ? [] : liveGroups).filter(matches);
  const boards = (trash ? data?.boards.filter(row => row.deletedAt) ?? [] :
    activeBoards.filter(board => group ? board.groupId === group.id : !board.groupId || board.pinned || query.trim()))
    .filter(matches).sort((a, b) => Number(b.pinned) - Number(a.pinned) ||
      (sort === 'recent' ? b.modifiedAt - a.modifiedAt : a.modifiedAt - b.modifiedAt));

  function navigate(nextGroup: string | null, recycled = false) {
    setGroupId(nextGroup); setTrash(recycled); setQuery(''); setMenu(''); setCreateMenu(null);
  }

  function open(next: Action) {
    setMenu(''); setCreateMenu(null); setDialogError('');
    setName(next.kind === 'rename' ? next.target.row.name : next.kind === 'copy' ? next.target.row.name.slice(0, 95) + ' 副本' : '');
    setDestination(next.kind === 'move' && next.target.kind === 'boards' ? next.target.row.groupId ?? '' : '');
    setAction(next);
  }

  async function edit(target: Target, operation: Edit | QuickEdit, body: Record<string, unknown> = {}) {
    return request('/workspace/' + target.kind + '/' + encodeURIComponent(target.row.id), {
      method: 'PATCH', body: JSON.stringify({ action: operation, revision: target.row.revision, ...body }),
    });
  }

  async function finish(event: FormEvent) {
    event.preventDefault();
    if (!action || busy) return;
    setBusy(true); setDialogError('');
    try {
      if (action.kind === 'new-board' || action.kind === 'new-group') {
        const isBoard = action.kind === 'new-board';
        const created = await request<{ id: string }>('/workspace/' + (isBoard ? 'boards' : 'groups'), {
          method: 'POST', body: JSON.stringify({ name, groupId: isBoard ? action.groupId : null }),
        });
        if (isBoard) { location.assign(boardUrl(created.id)); return; }
        navigate(created.id);
      } else {
        const fields = action.kind === 'move' ? { groupId: destination || null } :
          action.kind === 'rename' || action.kind === 'copy' ? { name } : {};
        await edit(action.target, action.kind, fields);
      }
      setData(await read());
      setAction(undefined);
    } catch (e) {
      if ((e as { status?: number }).status === 409) {
        const latest = await read().catch(() => undefined);
        if (latest) {
          setData(latest);
          if ('target' in action) {
            const target = action.target;
            if (target.kind === 'boards') {
              const row = latest.boards.find(board => board.id === target.row.id);
              if (row) setAction({ ...action, target: { kind: 'boards', row } });
            } else {
              const row = latest.groups.find(group => group.id === target.row.id);
              if (row) setAction({ ...action, target: { kind: 'groups', row } });
            }
          }
        }
      }
      setDialogError(e instanceof Error ? e.message : '操作失败。');
    } finally { setBusy(false); }
  }

  async function quickEdit(target: Target, operation: QuickEdit, fields: Record<string, unknown> = {}) {
    if (busy) return;
    setBusy(true); setError(''); setMenu('');
    try { await edit(target, operation, fields); setData(await read()); }
    catch (e) {
      if ((e as { status?: number }).status === 409) {
        const latest = await read().catch(() => undefined);
        if (latest) setData(latest);
      }
      setError(e instanceof Error ? e.message : '操作失败。');
    }
    finally { setBusy(false); }
  }

  async function importProject(file: File) {
    setBusy(true); setError('');
    try {
      if (file.size > 32 * 1024 * 1024) throw new Error('工程文件大小不能超过 32 MiB。');
      const body = await file.text();
      let project: unknown;
      try { project = JSON.parse(body); }
      catch { throw new Error('无法读取工程文件。'); }
      const board = await request<BoardCard>('/workspace/projects', { method: 'POST', body: JSON.stringify(project) });
      location.assign(boardUrl(board.id));
    } catch (e) { setError(e instanceof Error ? e.message : '导入工程失败。'); }
    finally { setBusy(false); }
  }

  function showCreateMenu(event: MouseEvent<HTMLDivElement>) {
    const element = event.target;
    if (trash || busy || action || !data || !(element instanceof Element)) return;
    if (element !== event.currentTarget && !element.closest('.workspace-main')) return;
    if (element.closest('article, button, a, label, input, select, .workspace-title, .workspace-filters, [role="alert"]')) return;
    event.preventDefault();
    setMenu('');
    setCreateMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 176)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 86)),
    });
  }

  function startDrag(event: DragEvent<HTMLElement>, board: BoardCard) {
    if (busy || trash || (event.target instanceof Element && event.target.closest('button'))) {
      event.preventDefault();
      return;
    }
    setMenu(''); setCreateMenu(null);
    draggedBoard.current = board;
    setDragging(true);
    event.dataTransfer.setData(BOARD_DRAG_TYPE, board.id);
    event.dataTransfer.effectAllowed = 'move';
  }

  function clearDrag() {
    draggedBoard.current = null;
    setDragging(false);
    setDropGroup(null);
  }

  function canDrop(event: DragEvent<HTMLElement>, group: GroupCard) {
    const source = draggedBoard.current;
    return source && !busy && !trash && source.groupId !== group.id &&
      event.dataTransfer.types.includes(BOARD_DRAG_TYPE) ? source : null;
  }

  function dropBoard(event: DragEvent<HTMLElement>, group: GroupCard) {
    const source = canDrop(event, group);
    if (!source) return;
    event.preventDefault();
    const draggedId = event.dataTransfer.getData(BOARD_DRAG_TYPE);
    clearDrag();
    if (draggedId === source.id) void quickEdit({ kind: 'boards', row: source }, 'move', { groupId: group.id });
  }

  function actions(target: Target) {
    const key = target.row.id;
    const entries: Edit[] = target.kind === 'boards' ? ['rename', 'copy', 'move'] : ['rename'];
    return <div className="workspace-menu-holder">
      <button type="button" className="icon-button" disabled={busy} aria-label={target.row.name + '的操作'} aria-expanded={menu === key}
        onClick={() => setMenu(menu === key ? '' : key)}><MoreHorizontal size={18}/></button>
      {menu === key && <div className="workspace-menu">
        {entries.map(kind => <button type="button" key={kind} onClick={() => open({ kind, target })}>{titles[kind]}</button>)}
        {target.kind === 'boards' && <a href={'/api/v1/workspace/boards/' + encodeURIComponent(key) + '/project'}
          download onClick={() => setMenu('')}>下载工程文件</a>}
        {target.kind === 'boards' && target.row.groupId && <button type="button"
          onClick={() => void quickEdit(target, 'move', { groupId: null })}>移出为独立画布</button>}
      </div>}
    </div>;
  }

  function recycle(target: Target) {
    const kind = target.kind === 'groups' ? '画布组' : '画布';
    return <InlineDeleteButton key={target.row.revision} className="icon-button workspace-recycle" disabled={busy}
      title={target.kind === 'groups' ? `回收画布组及组内 ${target.row.boardCount} 张画布，共享监控将暂停` : '移入回收站'}
      label={`回收${kind} ${target.row.name}`}
      confirmation={target.kind === 'groups' ? `确认回收组及 ${target.row.boardCount} 张画布` : '确认回收'}
      onConfirm={() => void quickEdit(target, 'delete')}><Trash2 size={15}/></InlineDeleteButton>;
  }

  function trashActions(target: Target) {
    const grouped = target.kind === 'groups';
    const kind = grouped ? '画布组' : '画布';
    const confirmation = target.kind === 'groups' ? `确认删除组及 ${target.row.boardCount} 张画布` : '确认彻底删除';
    return <div className="workspace-trash-actions">
      <button type="button" className="workspace-button" disabled={busy}
        onClick={() => open({ kind: 'restore', target })}>恢复{kind}</button>
      <InlineDeleteButton key={target.row.revision} className="workspace-button workspace-purge" disabled={busy}
        title="彻底删除后无法从回收站恢复。原始素材和导入副本保留。"
        label={`彻底删除${kind} ${target.row.name}`} confirmation={confirmation}
        onConfirm={() => void quickEdit(target, 'purge')}>彻底删除</InlineDeleteButton>
    </div>;
  }

  const naming = action && ['new-board', 'new-group', 'rename', 'copy'].includes(action.kind);
  const target = action && 'target' in action ? action.target : undefined;
  return <div className="workspace-home" data-trash={trash || undefined} data-dragging={dragging || undefined} onDoubleClick={showCreateMenu} onPointerDown={event => {
    if (!(event.target instanceof Element)) return;
    if (createMenu && !event.target.closest('.workspace-create-menu')) setCreateMenu(null);
    if (menu && !event.target.closest('.workspace-menu-holder')) setMenu('');
  }} onKeyDown={event => {
    if (event.key === 'Escape' && !busy) { setMenu(''); setCreateMenu(null); setAction(undefined); }
  }}>
    <header className="app-header">
      <div className="brand">Msh<span>TV</span></div>
      <span className="header-divider"/>
      <button type="button" className="workspace-return" onClick={() => navigate(null)}>工作空间</button>
      {(group || trash) && <><ChevronRight size={14}/><strong>{trash ? '回收站' : group?.name}</strong></>}
      <div className="header-spacer"/>
      {last && <a className="workspace-button" href={boardUrl(last.id)}>返回画布</a>}
      <button type="button" className="workspace-button" aria-pressed={trash} onClick={() => navigate(null, !trash)}><Trash2 size={15}/>回收站</button>
      <ThemeToggle/>
      <SettingsMenu ready={Boolean(data)}/>
      {isLanClient ? <DeviceLogout/> : <ServerControls workspace disabled={!data || busy}/>}
    </header>
    <main className="workspace-main" onScroll={() => { if (createMenu) setCreateMenu(null); }}>
      <div className="workspace-title">
        <div>{(group || trash) && <button type="button" className="workspace-return" onClick={() => navigate(null)}><ArrowLeft size={15}/>全部画布</button>}
          <h1>{trash ? '回收站' : group?.name ?? '工作空间'}</h1></div>
        {!trash && <div className="workspace-actions">
          {!group && <><button type="button" className="workspace-button" disabled={busy || !data}
            onClick={() => projectInput.current?.click()}>导入工程</button>
            <input hidden ref={projectInput} type="file" accept=".mshtv" onChange={e => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = '';
              if (file) void importProject(file);
            }}/></>}
          {!group && <button type="button" className="workspace-button" disabled={!data} onClick={() => open({ kind: 'new-group' })}><Folder size={16}/>新建画布组</button>}
          <button type="button" className="workspace-button primary" disabled={!data} onClick={() => open({ kind: 'new-board', groupId: group?.id ?? null })}><Plus size={17}/>{group ? '新建画布' : '新建独立画布'}</button>
        </div>}
      </div>
      <div className="workspace-filters">
        <label className="library-search"><Search size={16}/><input aria-label="搜索工作空间" value={query} placeholder="搜索名称" onChange={event => setQuery(event.target.value)}/></label>
        <select aria-label="画布排序" value={sort} onChange={event => setSort(event.target.value as typeof sort)}><option value="recent">最近编辑</option><option value="old">最早编辑</option></select>
      </div>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button type="button" onClick={refresh}>重新读取</button></div>}
      {!data && !error && <p role="status">正在读取工作空间…</p>}
      {data && !groups.length && !boards.length && <p className="workspace-empty">{query ? '没有匹配的内容。' : trash ? '回收站为空。' : '这里还没有画布。'}</p>}
      {groups.length > 0 && <section className="workspace-grid" aria-label="画布组">
        {groups.map(row => <article className="workspace-group-card" key={row.id} data-drop-active={dropGroup === row.id || undefined}
          onDragOver={event => {
            if (!canDrop(event, row)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            if (dropGroup !== row.id) setDropGroup(row.id);
          }}
          onDragLeave={event => {
            if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
            setDropGroup(current => current === row.id ? null : current);
          }}
          onDrop={event => dropBoard(event, row)}>
          {trash ? <div className="workspace-group-label"><Folder size={19}/><strong>{row.name}</strong></div> :
            <button type="button" className="workspace-group-open" aria-label={'打开画布组 ' + row.name} onClick={() => navigate(row.id)}><Folder size={19}/><strong>{row.name}</strong></button>}
          <small>{row.boardCount} 张画布 · 共享素材库</small>
          {trash ? trashActions({ kind: 'groups', row }) :
            <div className="workspace-group-actions">{actions({ kind: 'groups', row })}{recycle({ kind: 'groups', row })}</div>}
        </article>)}
      </section>}
      {boards.length > 0 && <section className="workspace-grid" aria-label="画布">
        {boards.map(row => <article className="workspace-board-card" key={row.id} draggable={!trash && !busy}
          onDragStart={event => startDrag(event, row)} onDragEnd={clearDrag}>
          {!trash && <a className="workspace-cover" draggable={false} href={boardUrl(row.id)} aria-label={'打开画布 ' + row.name}>
            <img loading="lazy" draggable={false} alt="" src={'/api/v1/workspace/boards/' + encodeURIComponent(row.id) + '/cover?r=' + row.revision + (lightTheme ? '&theme=light' : '')}/>
          </a>}
          <div className="workspace-card-body">
            <div className="workspace-card-title">
              {!trash ? <a draggable={false} href={boardUrl(row.id)}>{row.name}</a> : <strong>{row.name}</strong>}
              {!trash && <><button type="button" className="icon-button" disabled={busy} aria-label={row.pinned ? '取消置顶 ' + row.name : '置顶 ' + row.name}
                aria-pressed={row.pinned} onClick={() => void quickEdit({ kind: 'boards', row }, 'pin', { pinned: !row.pinned })}><Pin size={15}/></button>
                {actions({ kind: 'boards', row })}{recycle({ kind: 'boards', row })}</>}
            </div>
            {row.groupId && <small><Layers size={12}/>{data?.groups.find(group => group.id === row.groupId)?.name ?? '画布组'}</small>}
            <small>创建 {timestamp.format(row.createdAt)}</small>
            <small>{trash && row.deletedAt ? '删除 ' + timestamp.format(row.deletedAt) : '编辑 ' + timestamp.format(row.modifiedAt)}</small>
            {trash && trashActions({ kind: 'boards', row })}
          </div>
        </article>)}
      </section>}
    </main>
    {createMenu && <div className="workspace-menu workspace-create-menu" role="group" aria-label="创建菜单"
      style={{ left: createMenu.x, top: createMenu.y }}>
      <button type="button" autoFocus onClick={() => open({ kind: 'new-board', groupId: group?.id ?? null })}><Plus size={15}/>新建画布</button>
      {!group && <button type="button" onClick={() => open({ kind: 'new-group' })}><Folder size={15}/>新建画布组</button>}
    </div>}
    {action && <div className="modal-backdrop"><form className="workspace-dialog" role="dialog" aria-modal="true" aria-label={titles[action.kind]} onSubmit={finish}>
      <div className="panel-heading"><h2>{titles[action.kind]}</h2><button aria-label="关闭窗口" className="icon-button" type="button" disabled={busy} onClick={() => setAction(undefined)}><X size={18}/></button></div>
      {naming && <label>名称<input aria-label="名称" autoFocus required maxLength={100} value={name} onChange={event => setName(event.target.value)}/></label>}
      {action.kind === 'move' && target?.kind === 'boards' && <>
        <label>目标<select aria-label="目标画布组" value={destination} onChange={event => setDestination(event.target.value)}>
          <option value="">独立画布</option>{liveGroups.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
        </select></label>
        <p>{target.row.groupId ? '会带上本画布正在引用的素材，原画布组保留素材和监控设置。' : '独立素材库和监控来源会合并到目标画布组，同路径监控沿用目标组的设置。'}</p>
      </>}
      {action.kind === 'restore' && <p>恢复「{target?.row.name}」？</p>}
      {dialogError && <p role="alert">{dialogError}</p>}
      <div className="dialog-actions">
        <button className="workspace-button" type="button" disabled={busy} onClick={() => setAction(undefined)}>取消</button>
        <button className="workspace-button primary" type="submit" disabled={busy || action.kind === 'move' && action.target.kind === 'boards' &&
          destination === (action.target.row.groupId ?? '')}>{busy ? '正在处理…' : titles[action.kind]}</button>
      </div>
    </form></div>}
  </div>;
}
