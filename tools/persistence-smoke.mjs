import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { once } from 'node:events';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname, '..');
mkdirSync(resolve(root, '.data'), { recursive: true });
const data = mkdtempSync(resolve(root, '.data/persistence-'));
const executable = resolve(root, '.tools/dotnet/dotnet.exe');
const url = 'http://127.0.0.1:5199';
let child, logs = '';
async function start() {
  child = spawn(existsSync(executable) ? executable : 'dotnet', [resolve(root, 'src/MshTV.Server/bin/Debug/net10.0/MshTV.Server.dll')], { cwd: resolve(root, 'src/MshTV.Server'), env: { ...process.env, MSHTV_PORT: '5199', MSHTV_DATA_DIR: data }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', x => { logs += x; }); child.stderr.on('data', x => { logs += x; });
  for (let n = 0; n < 100; n++) { if (child.exitCode !== null) throw new Error(logs); try { if ((await fetch(url + '/api/v1/health')).ok) return; } catch {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error('Startup timeout: ' + logs);
}
async function stop() { if (child && child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; } }
async function session() {
  const response = await fetch(url + '/api/v1/session', { method: 'POST', headers: { Origin: url, 'X-MshTV-Bootstrap': '1' } });
  assert.equal(response.status, 200); const cookie = response.headers.getSetCookie()[0].split(';')[0];
  return { Cookie: cookie, Origin: url, 'X-CSRF-Token': (await response.json()).csrf, 'Content-Type': 'application/json' };
}
try {
  let occupied = false;
  try { await fetch(url + '/api/v1/health'); occupied = true; } catch {}
  if (occupied) throw new Error('Test port 5199 is already in use; refusing to access an existing server.');
  await start();
  assert.equal((await fetch(url + '/api/v1/boards/main')).status, 401);
  const modeUrl = url + '/api/v1/settings/performance';
  assert.equal((await fetch(modeUrl)).status, 401);
  let headers = await session();
  assert.deepEqual(await (await fetch(modeUrl, { headers })).json(), { enabled: false, revision: 1, analysisLimit: 6 });
  const enable = { method: 'PUT', body: JSON.stringify({ enabled: true, revision: 1 }) };
  const untrusted = await fetch(modeUrl, { ...enable, headers: { Cookie: headers.Cookie, Origin: url, 'Content-Type': 'application/json' } });
  assert.equal(untrusted.status, 403);
  const modeSaved = await fetch(modeUrl, { ...enable, headers });
  assert.equal(modeSaved.status, 200);
  assert.deepEqual(await modeSaved.json(), { enabled: true, revision: 2, analysisLimit: 2 });
  assert.equal((await fetch(modeUrl, { ...enable, headers })).status, 409);
  const itemId = crypto.randomUUID();
  const mutation = { baseRevision: 0, clientId: crypto.randomUUID(), mutationId: crypto.randomUUID(), operations: [{ kind: 'putItem', item: { id: itemId, type: 'note', assetId: null, title: '恢复测试', text: '确认保存后强制重启', x: -123, y: 456, width: 320, height: 200, groupId: null } }] };
  const saved = await fetch(url + '/api/v1/boards/main/mutations', { method: 'POST', headers, body: JSON.stringify(mutation) }); assert.equal(saved.status, 200);
  await stop(); await start(); headers = await session();
  assert.deepEqual(await (await fetch(modeUrl, { headers })).json(), { enabled: true, revision: 2, analysisLimit: 2 });
  const board = await (await fetch(url + '/api/v1/boards/main', { headers })).json();
  assert.equal(board.revision, 1); assert.equal(board.document.items[0].id, itemId); assert.equal(board.document.items[0].x, -123);
  const retry = await fetch(url + '/api/v1/boards/main/mutations', { method: 'POST', headers, body: JSON.stringify(mutation) }); assert.equal(retry.status, 200); assert.equal((await retry.json()).revision, 1);
  console.log('PASS: confirmed data, idempotency receipt and performance mode survive forced backend restart.');
} finally { await stop(); }
