import { useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { diffDocuments, type BoardDocument, type BoardSnapshot } from './model';
import { useCanvas } from './store';
import { trackBoardCamera } from './canvas/boardCamera';
import { boardId, isLanClient, scopedApiUrl } from './navigation';
type Status = 'loading' | 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';
let state: { status: Status; message: string; revision: number } = { status: 'loading', message: '正在连接本地后端…', revision: 0 };
const listeners = new Set<() => void>();
function report(status: Status, message: string, revision = state.revision) { state = { status, message, revision }; listeners.forEach(fn => fn()); }
const connectionSnapshot = () => state;
export function useConnection() { return useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, connectionSnapshot); }
let csrf = '', acknowledged: BoardDocument, running = false, timer: ReturnType<typeof setTimeout>;
let workspaceVersion = '';
export const useLanSession = create<{ state: 'checking' | 'pair' | 'connected' | 'offline'; opened: boolean }>(() => ({ state: 'checking', opened: false }));
let pending: { baseRevision: number; clientId: string; mutationId: string; operations: ReturnType<typeof diffDocuments>; target: BoardDocument } | null = null;
const clientId = crypto.randomUUID();
export async function request<T>(path: string, init?: RequestInit, retry = true): Promise<T> {
  const response = await fetch(scopedApiUrl('/api/v1' + path), { ...init, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...init?.headers }, signal: init?.signal ?? AbortSignal.timeout(12000) }).catch(error => {
    if (error instanceof TypeError || error?.name === 'TimeoutError') throw new Error('无法连接 MshTV 主机，请检查网络后重试。');
    throw error;
  });
  if (response.status === 401 && retry && path !== '/session' && path !== '/lan/pair') {
    const session = await request<{ csrf: string }>('/session', { method: 'POST', headers: { 'X-MshTV-Bootstrap': '1' }, body: '{}' }, false);
    csrf = session.csrf; return request<T>(path, init, false);
  }
  if (isLanClient && response.status === 401 && path !== '/lan/pair') useLanSession.setState({ state: 'pair' });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw Object.assign(new Error(body.title ?? `请求失败 (${response.status})`), { status: response.status }); }
  return response.json();
}
export async function connectSession() {
  const session = await request<{ csrf: string }>('/session', { method: 'POST', headers: { 'X-MshTV-Bootstrap': '1' }, body: '{}' });
  csrf = session.csrf;
  if (isLanClient) useLanSession.setState({ state: 'connected', opened: true });
}
export async function pairDevice(device: string, code: string) {
  const session = await request<{ csrf: string }>('/lan/pair', { method: 'POST', body: JSON.stringify({ device, code }) }, false);
  csrf = session.csrf;
  useLanSession.setState({ state: 'connected', opened: true });
}
export async function disconnectDevice() {
  if (boardId && acknowledged) await flushBoard('退出设备');
  await request('/lan/logout', { method: 'POST', body: '{}' });
  location.replace('/');
}
export async function loadBoard() {
  if (running) return;
  clearTimeout(timer); report('loading', '正在加载画布…'); useCanvas.setState({ editable: false });
  try {
    await connectSession();
    const board = await request<BoardSnapshot & { workspaceVersion?: string }>(`/boards/${encodeURIComponent(boardId ?? 'main')}`);
    workspaceVersion = board.workspaceVersion ?? '';
    trackBoardCamera(workspaceVersion, board.id);
    acknowledged = board.document; pending = null;
    useCanvas.getState().replace(board.document); useCanvas.setState({ editable: true });
    report('saved', '已保存到本机 SQLite', board.revision);
  } catch (error) { report('error', error instanceof Error ? error.message : '连接失败'); }
}
export async function saveBoard() {
  clearTimeout(timer);
  if (running || !acknowledged || state.status === 'conflict' || state.status === 'loading') return;
  const target = useCanvas.getState().doc;
  if (!pending) {
    const operations = diffDocuments(acknowledged, target);
    if (!operations.length) { report('saved', '已保存到本机 SQLite'); return; }
    if (operations.length > 500) { report('error', '本轮修改超过 500 项，请重新加载后分批编辑。'); useCanvas.setState({ editable: false }); return; }
    pending = { baseRevision: state.revision, clientId, mutationId: crypto.randomUUID(), operations, target };
  }
  running = true; report('saving', '正在保存…');
  try {
    const { target: sent, ...payload } = pending;
    const result = await request<{ revision: number }>(`/boards/${encodeURIComponent(boardId ?? 'main')}/mutations`,
      { method: 'POST', headers: { 'X-MshTV-Workspace': workspaceVersion }, body: JSON.stringify(payload) });
    acknowledged = sent; pending = null;
    useCanvas.setState({ editable: true }); report('saved', '已保存到本机 SQLite', result.revision);
    if (diffDocuments(acknowledged, useCanvas.getState().doc).length) { report('dirty', '待保存'); timer = setTimeout(() => void saveBoard(), 200); }
  } catch (error) {
    const conflict = (error as { status?: number }).status === 409;
    const changedWorkspace = conflict && error instanceof Error && error.message.includes('工作目录');
    report(conflict ? 'conflict' : 'error', changedWorkspace ? '主机工作目录已切换。请先核对本页修改，再重新打开画布。' :
      conflict ? '其他页面已修改画布。本地修改仍保留；重新加载会丢弃本地修改。' : '保存失败，本地修改尚未保存。请检查后端并重试。');
    useCanvas.setState({ editable: false });
  } finally { running = false; }
}
useCanvas.subscribe((next, prev) => {
  if (next.doc === prev.doc || !next.editable || !acknowledged) return;
  clearTimeout(timer); report('dirty', '待保存'); timer = setTimeout(() => void saveBoard(), 500);
});
export async function flushBoard(action = '关闭后端') {
  useCanvas.getState().finishEditing();
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (state.status === 'loading' || state.status === 'conflict') throw new Error(`画布尚未加载或存在保存冲突，请先处理后再${action}。`);
    if (running) { await new Promise(resolve => setTimeout(resolve, 40)); continue; }
    await saveBoard();
    const confirmed = connectionSnapshot();
    if (confirmed.status === 'error' || confirmed.status === 'conflict') throw new Error(confirmed.message);
    if (!running && !pending && acknowledged && !diffDocuments(acknowledged, useCanvas.getState().doc).length) return confirmed.revision;
  }
  throw new Error(`保存未完成，已取消${action}。`);
}
export async function returnToWorkspace() {
  if (acknowledged && (state.status !== 'saved' || useCanvas.getState().editing)) await flushBoard('返回工作空间');
  location.assign('/');
}
window.addEventListener('beforeunload', event => { if (['dirty', 'saving', 'error', 'conflict'].includes(state.status) && acknowledged) { event.preventDefault(); } });
