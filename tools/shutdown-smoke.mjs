// Isolated host only: never stop a server already running on the selected test port.
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname, '..'), url = 'http://127.0.0.1:5201';
mkdirSync(join(root, '.data'), { recursive: true }); const fixture = mkdtempSync(join(root, '.data/shutdown-')), data = join(fixture, 'database'), media = join(fixture, 'media'); mkdirSync(media);
assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=80x60', '-frames:v', '1', join(media, 'original.png')], { windowsHide: true }).status, 0);
const original = readFileSync(join(media, 'original.png'));
const dotnet = join(root, '.tools/dotnet/dotnet.exe'); let child, browser, headers, logs = '';
const binary = resolve(process.argv[2] ?? join(root, 'src/MshTV.Server/bin/Debug/net10.0/MshTV.Server.dll'));
async function until(predicate, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await predicate()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error('Timed out: ' + logs.slice(-3000)); }
async function start() {
  child = spawn(existsSync(dotnet) ? dotnet : 'dotnet', [binary, '--webroot', join(root, 'apps/web/dist')], { cwd: join(root, 'src/MshTV.Server'), windowsHide: true, env: { ...process.env, MSHTV_PORT: '5201', MSHTV_DATA_DIR: data }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', x => { logs += x; }); child.stderr.on('data', x => { logs += x; });
  await until(async () => { if (child.exitCode !== null) throw new Error(logs); try { return (await fetch(url + '/api/v1/health')).ok; } catch { return false; } });
  const session = await fetch(url + '/api/v1/session', { method: 'POST', headers: { Origin: url, 'X-MshTV-Bootstrap': '1' } }); assert.equal(session.status, 200);
  headers = { Origin: url, Cookie: session.headers.getSetCookie()[0].split(';')[0], 'X-CSRF-Token': (await session.json()).csrf, 'Content-Type': 'application/json' };
}
async function api(path, method = 'GET', body) { const response = await fetch(url + '/api/v1' + path, { method, headers, body: body ? JSON.stringify(body) : undefined }); assert.ok(response.ok, `${path}: ${response.status}`); return response.json(); }
try {
  let occupied = false; try { await fetch(url + '/api/v1/health'); occupied = true; } catch {}
  if (occupied) throw new Error('Port 5201 is busy; refusing to access an existing host.');
  await start();
  assert.equal((await fetch(url + '/api/v1/system/shutdown', { method: 'POST', headers: { Origin: url } })).status, 401);
  assert.equal((await fetch(url + '/api/v1/system/shutdown', { method: 'POST', headers: { Origin: url, Cookie: headers.Cookie } })).status, 403);
  assert.equal((await fetch(url + '/api/v1/system/shutdown', { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.invalid' } })).status, 403);
  const libraryRoot = await api('/library/roots', 'POST', { path: media }); let asset;
  await until(async () => { asset = (await api('/assets')).items[0]; return asset?.status === 'ready'; });
  await api(`/assets/${asset.id}?revision=${asset.revision}`, 'DELETE');
  const { chromium, expect } = createRequire(join(root, 'apps/web/package.json'))('@playwright/test');
  browser = await chromium.launch({ channel: process.env.MSHTV_TEST_BROWSER_CHANNEL });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } }); await page.goto(url + "/?board=main"); await expect(page.getByText('已保存到本机', { exact: true })).toBeVisible();
  await page.route('**/api/v1/boards/main/mutations', route => route.fulfill({ status: 503, contentType: 'application/problem+json', body: JSON.stringify({ title: '测试保存失败' }) }));
  await page.getByRole('button', { name: '添加文字备注', exact: true }).click(); await page.getByRole('button', { name: '关闭后端', exact: true }).click();
  await page.getByRole('button', { name: '保存并关闭后端', exact: true }).click();
  await expect(page.locator('.shutdown-dialog [role=alert]')).toContainText('保存失败'); assert.equal((await fetch(url + '/api/v1/health')).status, 200);
  await page.getByRole('button', { name: '取消', exact: true }).click(); await page.unroute('**/api/v1/boards/main/mutations');
  await page.getByRole('button', { name: '重试连接 / 保存', exact: true }).click(); await expect(page.getByText('已保存到本机', { exact: true })).toBeVisible();
  await page.route('**/api/v1/boards/main/mutations', async route => { await new Promise(r => setTimeout(r, 600)); await route.continue(); });
  await page.getByRole('button', { name: '添加文字备注', exact: true }).click(); await page.getByRole('button', { name: '关闭后端', exact: true }).click();
  await page.getByRole('button', { name: '保存并关闭后端', exact: true }).click();
  await expect(page.getByRole('heading', { name: '后端已关闭', exact: true })).toBeVisible({ timeout: 15000 });
  await until(async () => child.exitCode !== null); assert.equal(child.exitCode, 0);
  await page.screenshot({ path: join(fixture, 'backend-closed.png') }); await page.close();
  await start(); const board = await api('/boards/main'); assert.equal(board.document.items.filter(x => x.type === 'note').length, 2);
  assert.equal((await api(`/assets/${asset.id}`)).status, 'removed');
  await api(`/library/roots/${libraryRoot.id}/scan`, 'POST');
  await until(async () => (await api('/library/roots'))[0].lastScanAt > libraryRoot.lastScanAt);
  assert.equal((await api('/assets')).items.length, 0); assert.deepEqual(readFileSync(join(media, 'original.png')), original);
  const workspace = await browser.newPage();
  await workspace.goto(url);
  const power = workspace.getByRole('button', { name: '关闭后端', exact: true });
  const dialog = workspace.getByRole('dialog', { name: '关闭 MshTV 后端' });
  await power.click();
  await expect(dialog).toContainText('请先保存其他页面的修改');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  assert.equal((await fetch(url + '/api/v1/health')).status, 200);
  await power.click();
  await dialog.getByRole('button', { name: '确认关闭后端', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: '后端已关闭', exact: true })).toBeVisible();
  await until(() => child.exitCode !== null);
  assert.equal(child.exitCode, 0);
  console.log('PASS: workspace and editor shutdown, cancellation, authorization, save protection and restart persistence.');
} finally {
  await browser?.close(); if (child && child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
}
