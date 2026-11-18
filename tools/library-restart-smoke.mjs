// Runs only against newly created application data and media owned by this test.
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, copyFileSync, renameSync, readFileSync, utimesSync } from 'node:fs';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname, '..');
mkdirSync(resolve(root, '.data'), { recursive: true });
const fixture = mkdtempSync(resolve(root, '.data/library-restart-'));
const data = join(fixture, 'database'), source = join(fixture, 'source'), other = join(fixture, 'other');
mkdirSync(source); mkdirSync(other);
const ffmpeg = process.env.MSHTV_FFMPEG_DIR ? join(process.env.MSHTV_FFMPEG_DIR, 'ffmpeg.exe') : 'ffmpeg';
const generated = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=80x60', '-frames:v', '1', join(source, 'first.png')], { windowsHide: true });
assert.equal(generated.status, 0, 'A local ffmpeg is required for this test fixture.');
const original = readFileSync(join(source, 'first.png'));
const dotnet = resolve(root, '.tools/dotnet/dotnet.exe'), url = 'http://127.0.0.1:5200';
let child, headers, logs = '';
async function start() {
  child = spawn(existsSync(dotnet) ? dotnet : 'dotnet', [resolve(root, 'src/MshTV.Server/bin/Debug/net10.0/MshTV.Server.dll')], { cwd: resolve(root, 'src/MshTV.Server'), env: { ...process.env, MSHTV_PORT: '5200', MSHTV_DATA_DIR: data }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', x => { logs += x; }); child.stderr.on('data', x => { logs += x; });
  await until(async () => { if (child.exitCode !== null) throw new Error(logs); try { return (await fetch(url + '/api/v1/health')).ok; } catch { return false; } });
  const response = await fetch(url + '/api/v1/session', { method: 'POST', headers: { Origin: url, 'X-MshTV-Bootstrap': '1' } });
  assert.equal(response.status, 200);
  headers = { Cookie: response.headers.getSetCookie()[0].split(';')[0], Origin: url, 'X-CSRF-Token': (await response.json()).csrf, 'Content-Type': 'application/json' };
}
async function stop() { if (child && child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; } }
async function api(path, method = 'GET', body) {
  const response = await fetch(url + '/api/v1' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${await response.clone().text()}`);
  return response.json();
}
async function until(predicate, timeout = 35000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await new Promise(r => setTimeout(r, 200)); }
  throw new Error('Timed out: ' + logs.slice(-3000));
}
try {
  let occupied = false; try { await fetch(url + '/api/v1/health'); occupied = true; } catch {}
  if (occupied) throw new Error('Port 5200 is already in use; refusing to access an existing server.');
  await start();
  const libraryRoot = await api('/library/roots', 'POST', { path: source });
  let asset;
  await until(async () => { asset = (await api('/assets')).items.find(x => x.name === 'first.png'); return asset?.status === 'ready'; });
  const id = asset.id, itemId = crypto.randomUUID();
  await api('/boards/main/mutations', 'POST', { baseRevision: 0, clientId: crypto.randomUUID(), mutationId: crypto.randomUUID(), operations: [{ kind: 'putItem', item: { id: itemId, type: 'image', assetId: id, title: 'first.png', text: '', x: 120, y: -60, width: 320, height: 240, groupId: null } }] });
  copyFileSync(join(source, 'first.png'), join(other, 'ignored-before.png'));
  const paused = await api('/library/roots', 'POST', { path: other, includeSubdirectories: false, newFilesOnly: true });
  await until(async () => (await api('/library/roots')).some(x => x.id === paused.id && x.lastScanAt > 0 && !x.baselinePending));
  await api(`/library/roots/${paused.id}`, 'PATCH', { enabled: false, revision: paused.revision });
  await stop();
  copyFileSync(join(source, 'first.png'), join(other, 'arrived-offline.png')); utimesSync(join(other, 'arrived-offline.png'), new Date('2020-01-01'), new Date('2020-01-01'));
  await start();
  const roots = await api('/library/roots');
  assert.equal(roots.find(x => x.id === libraryRoot.id).enabled, true);
  assert.equal(roots.find(x => x.id === paused.id).enabled, false);
  assert.equal(roots.find(x => x.id === paused.id).includeSubdirectories, false); assert.equal(roots.find(x => x.id === paused.id).newFilesOnly, true);
  await api(`/library/roots/${paused.id}/scan`, 'POST');
  await until(async () => (await api('/assets?q=arrived-offline')).items[0]?.status === 'ready');
  assert.equal((await api('/assets?q=ignored-before')).items.length, 0);
  const board = await api('/boards/main'); assert.equal(board.document.items[0].id, itemId); assert.equal(board.document.items[0].assetId, id);
  assert.equal((await api(`/assets/${id}`)).id, id);
  copyFileSync(join(source, 'first.png'), join(source, 'after-restart.png'));
  await until(async () => (await api('/assets?q=after-restart')).items[0]?.status === 'ready');
  // Moving within the same Windows volume to another registered root retains the stable asset reference.
  renameSync(join(source, 'first.png'), join(other, 'moved.png'));
  await api(`/library/roots/${paused.id}/scan`, 'POST');
  await until(async () => (await api(`/assets/${id}`)).name === 'moved.png');
  assert.deepEqual(readFileSync(join(other, 'moved.png')), original);
  // A disconnected root is not interpreted as every file having been deleted.
  renameSync(source, source + '-offline');
  await api(`/library/roots/${libraryRoot.id}/scan`, 'POST');
  await until(async () => !(await api('/library/roots')).find(x => x.id === libraryRoot.id).online);
  assert.equal((await api('/assets?q=after-restart')).items[0].status, 'offline');
  renameSync(source + '-offline', source);
  await api(`/library/roots/${libraryRoot.id}/scan`, 'POST');
  await until(async () => (await api('/assets?q=after-restart')).items[0]?.status === 'ready');
  console.log('PASS: references, roots, pause, recursive/new-only options and baseline persist; offline arrivals, restored watcher, cross-root move and recovery work.');
} finally { await stop(); }
