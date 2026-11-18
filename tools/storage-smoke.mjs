import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '..');
const binary = resolve(process.argv[2] ?? '.data/storage-build/MshTV.Server.dll');
const origin = 'http://127.0.0.1:5281';
const base = mkdtempSync(join(root, '.data', 'storage-smoke-'));
const data = join(base, 'data'), target = join(base, 'target'), unavailable = join(base, 'unavailable');
const source = join(base, 'original');
const workDirectory = join(base, '新工作目录'), occupied = join(base, 'occupied');
for (const path of [target, source, unavailable, workDirectory, occupied]) mkdirSync(path);
const original = join(source, '原素材.png');
assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=64x64',
  '-frames:v', '1', '-threads', '1', original], { windowsHide: true }).status, 0);
const bytes = readFileSync(original);
const { chromium } = createRequire(join(root, 'apps/web/package.json'))('@playwright/test');
let child, exit, headers, browser;

async function until(read) {
  for (let i = 0; i < 240; i++) {
    const result = await read();
    if (result) return result;
    await sleep(100);
  }
  throw Error('Test timed out');
}
async function start() {
  assert.ok(!(await fetch(origin + '/api/v1/health').then(() => true).catch(() => false)));
  child = spawn(join(root, '.tools/dotnet/dotnet.exe'), [binary, '--webroot', join(root, 'apps/web/dist')], {
    cwd: dirname(binary), env: { ...process.env, MSHTV_PORT: '5281', MSHTV_DATA_DIR: data },
    windowsHide: true, stdio: ['ignore', 'ignore', 'inherit'],
  });
  exit = once(child, 'exit');
  await until(() => { assert.equal(child.exitCode, null); return fetch(origin + '/api/v1/health').then(r => r.ok).catch(() => false); });
  const session = await fetch(origin + '/api/v1/session', { method: 'POST', headers: { Origin: origin, 'X-MshTV-Bootstrap': '1' } });
  assert.equal(session.status, 200);
  headers = { Origin: origin, Cookie: session.headers.getSetCookie()[0].split(';')[0], 'X-CSRF-Token': (await session.json()).csrf };
}
const send = (path, init = {}) => fetch(origin + '/api/v1' + path, { ...init, headers: { ...headers, ...init.headers } });
async function api(path, body) {
  const result = await send(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!result.ok) throw Error(path + ' ' + result.status + ' ' + await result.text());
  return result.json();
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await api('/system/shutdown', {}).catch(() => {});
  if (!await Promise.race([exit.then(() => true), sleep(3000).then(() => false)])) { child.kill(); await exit; }
}
async function restart() { await stop(); await start(); return api('/storage/status'); }
const uuid = () => crypto.randomUUID();
const card = (id, assetId) => ({ id, assetId, type: 'image', title: '校验卡片', text: '', x: 9, y: 12, width: 120, height: 100, groupId: null });

try {
  await start();
  const watched = await api('/library/roots', { path: source });
  const upload = await send('/assets/import?name=' + encodeURIComponent('应用副本.png'), {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
  });
  assert.equal(upload.status, 200);
  const imported = await upload.json();
  const indexed = await until(async () => {
    const assets = (await api('/assets')).items;
    return assets.length === 2 && assets.every(asset => asset.status === 'ready' && asset.hasThumbnail) && assets;
  });
  const external = indexed.find(asset => asset.rootId === watched.id);
  const items = [card(uuid(), imported.id), card(uuid(), external.id)];
  await api('/boards/main/mutations', {
    baseRevision: 0, clientId: uuid(), mutationId: uuid(),
    operations: items.map(item => ({ kind: 'putItem', item })),
  });
  const project = await send('/workspace/boards/main/project');
  assert.match(project.headers.get('content-disposition'), /\.mshtv/);
  const manifest = await project.json();
  assert.deepEqual(manifest.document.items, items.map(item => ({ ...item, noteSpans: null })));
  assert.ok(!JSON.stringify(manifest).includes('canvas.db'));
  const reopened = await api('/workspace/projects', manifest);
  assert.deepEqual((await api('/boards/' + reopened.id)).document.items, manifest.document.items);
  assert.equal((await send('/workspace/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...manifest, libraryId: uuid() }) })).status, 409);

  const before = await api('/storage/check', {});
  assert.equal(before.sqlite, true);
  assert.equal(before.broken, 0);
  assert.equal(before.space.imports, bytes.length);
  assert.equal(before.space.external, bytes.length);
  assert.ok(before.space.cache > 0);
  const cacheSentinel = join(data, 'media-cache', 'unowned.webp');
  writeFileSync(cacheSentinel, 'unowned file');
  assert.ok((await api('/storage/clear-cache', {})).removed > 0);
  assert.equal(readFileSync(cacheSentinel, 'utf8'), 'unowned file');
  assert.deepEqual(readFileSync(original), bytes);
  assert.ok(!(await api('/storage/check', {})).space.cache);
  assert.equal((await send('/storage/clear-cache', { method: 'POST', headers: { 'X-CSRF-Token': 'wrong' } })).status, 403);
  await until(async () => (await send('/media/' + imported.id + '/thumb')).status === 200);
  assert.equal((await send('/storage/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation: 'backup', parent: source }) })).status, 400);
  console.log('PASS project round-trip, reference validation, size reporting and cache-only cleanup');

  browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(origin);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '存储与维护', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '存储与维护' });
  await dialog.getByRole('button', { name: '立即检查' }).click();
  await dialog.getByText(/数据库检查通过/).waitFor();
  await dialog.getByText(data, { exact: true }).waitFor();
  assert.equal(await dialog.getByText('备份保存位置', { exact: true }).count(), 0);
  await dialog.getByRole('button', { name: '备份与恢复', exact: true }).click();
  await dialog.getByRole('heading', { name: '整库备份与恢复' }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: '更改工作目录', exact: true }).count(), 0);
  await dialog.getByRole('button', { name: '存储设置', exact: true }).click();
  await dialog.getByRole('button', { name: '更改工作目录', exact: true }).click();
  await dialog.getByRole('textbox', { name: '新工作目录', exact: true }).fill(workDirectory);
  await dialog.getByRole('button', { name: '保存目录设置', exact: true }).click();
  await dialog.getByText('重启后执行更改工作目录 · ' + workDirectory, { exact: true }).waitFor();
  assert.equal((await api('/storage/status')).directory, data);
  await dialog.getByRole('button', { name: '取消待执行任务', exact: true }).click();
  await dialog.getByRole('button', { name: '取消待执行任务', exact: true }).waitFor({ state: 'hidden' });
  await dialog.getByRole('button', { name: '关闭存储与维护' }).click();
  await page.getByRole('article').filter({ hasText: '自由画布' }).first().getByRole('button', { name: '自由画布的操作' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: '下载工程文件' }).click();
  assert.ok((await download).suggestedFilename().endsWith('.mshtv'));
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '导入工程', exact: true }).click();
  await (await chooser).setFiles({
    name: '工作面板测试.mshtv', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(manifest)),
  });
  await page.getByText('已保存到本机', { exact: true }).waitFor();
  await page.getByTestId('item-count').getByText(/2 个元素/).waitFor();
  await browser.close(); browser = null;

  await api('/storage/jobs', { operation: 'backup', parent: target });
  let status = await restart();
  assert.equal(status.last.error, null, JSON.stringify(status.last));
  const backup = status.last.directory;
  assert.equal(status.directory, data);
  assert.ok(existsSync(join(backup, 'mshtv-backup-v1')));
  const backupImport = readdirSync(join(backup, 'imports'))[0];
  assert.deepEqual(readFileSync(join(backup, 'imports', backupImport)), bytes);

  await api('/storage/jobs', { operation: 'migrate', targetDirectory: unavailable });
  renameSync(unavailable, unavailable + '-moved');
  status = await restart();
  assert.ok(status.last.error);
  assert.equal(status.directory, data);
  assert.deepEqual((await api('/boards/main')).document.items, manifest.document.items);

  await api('/storage/jobs', { operation: 'migrate', targetDirectory: occupied });
  const sentinel = join(occupied, 'existing.txt');
  writeFileSync(sentinel, 'keep this file');
  status = await restart();
  assert.match(status.last.error, /空文件夹/);
  assert.equal(status.directory, data);
  assert.equal(readFileSync(sentinel, 'utf8'), 'keep this file');
  assert.equal(existsSync(join(occupied, 'canvas.db')), false);

  await api('/storage/jobs', { operation: 'migrate', targetDirectory: workDirectory });
  status = await restart();
  assert.equal(status.last.error, null, JSON.stringify(status.last));
  const migrated = status.directory;
  assert.equal(migrated, workDirectory);
  assert.ok(existsSync(join(data, 'canvas.db')));
  assert.deepEqual((await api('/boards/main')).document.items, manifest.document.items);
  assert.equal((await api('/library/roots'))[0].id, watched.id);
  for (const asset of [external, imported]) {
    const response = await send('/media/' + asset.id + '/source');
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  }

  await api('/storage/jobs', { operation: 'restore', parent: target, backup });
  status = await restart();
  assert.equal(status.last.error, null, JSON.stringify(status.last));
  assert.notEqual(status.directory, migrated);
  assert.ok(existsSync(join(migrated, 'canvas.db')));
  assert.deepEqual((await api('/boards/main')).document.items, manifest.document.items);
  const restored = await send('/media/' + imported.id + '/source');
  assert.equal(restored.status, 200);
  assert.deepEqual(Buffer.from(await restored.arrayBuffer()), bytes);
  assert.deepEqual(readFileSync(original), bytes);
  console.log('PASS Windows UI, backup, failed migration fallback, migration and restore with unchanged source bytes');
} finally { await browser?.close(); await stop(); }
