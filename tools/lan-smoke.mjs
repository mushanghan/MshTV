import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { request as https } from 'node:https';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { checkServerIdentity } from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '..');
const binary = resolve(process.argv[2] ?? '.data/lan-build/MshTV.Server.dll');
const fixture = mkdtempSync(join(root, '.data', 'lan-smoke-'));
const source = join(fixture, 'source');
mkdirSync(source);
const local = 'http://127.0.0.1:5290';
const require = createRequire(join(root, 'apps/web/package.json'));
const { chromium, expect } = require('@playwright/test');
const WebSocket = require('ws');
let host, hostExit, admin, lan, authority, browser, remoteBrowser, socket, reserved;

async function until(check, label, count = 250) {
  for (let i = 0; i < count; i++) {
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  throw new Error('Timed out: ' + label);
}
async function start() {
  assert.equal(await fetch(local + '/api/v1/health').then(() => true).catch(() => false), false);
  host = spawn(join(root, '.tools/dotnet/dotnet.exe'), [binary, '--webroot', join(root, 'apps/web/dist')], {
    cwd: dirname(binary), env: { ...process.env, MSHTV_PORT: '5290', MSHTV_DATA_DIR: join(fixture, 'data') },
    windowsHide: true, stdio: ['ignore', 'ignore', 'inherit'],
  });
  hostExit = once(host, 'exit');
  await until(() => { assert.equal(host.exitCode, null); return fetch(local + '/api/v1/health').then(r => r.ok).catch(() => false); }, 'server ready');
  const session = await fetch(local + '/api/v1/session', { method: 'POST', headers: { Origin: local, 'X-MshTV-Bootstrap': '1' } });
  assert.equal(session.status, 200);
  admin = { Origin: local, Cookie: session.headers.getSetCookie()[0].split(';')[0], 'X-CSRF-Token': (await session.json()).csrf };
}
function localSend(path, method = 'GET', body) {
  return fetch(local + '/api/v1' + path, {
    method, headers: { ...admin, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function api(path, method, body) {
  const response = await localSend(path, method, body);
  if (!response.ok) throw new Error(path + ' ' + response.status + ' ' + await response.text());
  return response.json();
}
async function stop() {
  if (!host || host.exitCode !== null || host.signalCode) return;
  await api('/system/shutdown', 'POST', {}).catch(() => {});
  if (!await Promise.race([hostExit.then(() => true), delay(4000).then(() => false)])) { host.kill(); await hostExit; }
}
function remote(path, { method = 'GET', headers = {}, body, ca = authority } = {}) {
  return new Promise((resolveRequest, reject) => {
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = https(lan + '/api/v1' + path, {
      method, ca, agent: false, checkServerIdentity: (_, certificate) => checkServerIdentity(new URL(lan).hostname, certificate), headers: {
        Origin: lan, ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}), ...headers,
      },
    }, res => {
      const leaf = res.socket.getPeerCertificate()?.raw;
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const data = Buffer.concat(chunks);
        resolveRequest({ status: res.statusCode, headers: res.headers, leaf, data, json: () => JSON.parse(data.toString()) });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('HTTPS timeout')));
    req.end(bytes);
  });
}
async function pair(name) {
  const { code } = await api('/lan/code', 'POST', {});
  const result = await remote('/lan/pair', { method: 'POST', body: { code, device: name } });
  assert.equal(result.status, 200);
  assert.match(result.headers['set-cookie'][0], /Secure/i);
  assert.match(result.headers['set-cookie'][0], /HttpOnly/i);
  assert.match(result.headers['set-cookie'][0], /SameSite=Strict/i);
  assert.match(result.headers['set-cookie'][0], /Max-Age=31536000/i);
  return { Cookie: result.headers['set-cookie'][0].split(';')[0], 'X-CSRF-Token': result.json().csrf };
}
function fixtureMedia(name, args) {
  const result = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', ...args, join(source, name)], { windowsHide: true });
  assert.equal(result.status, 0, result.stderr?.toString());
}

try {
  fixtureMedia('画面.png', ['-f', 'lavfi', '-i', 'color=green:s=320x180', '-frames:v', '1', '-threads', '1']);
  fixtureMedia('片段.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-t', '4', '-c:v', 'libx264', '-threads', '1', '-movflags', '+faststart']);
  fixtureMedia('试听.wav', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'pcm_s16le']);
  await start();
  const initial = await api('/lan/status');
  assert.equal(initial.enabled, false);
  const adapter = initial.addresses[0];
  assert.ok(adapter, 'A private IPv4 adapter is required for the LAN smoke test.');
  reserved = createServer();
  reserved.listen(0, adapter.address);
  await once(reserved, 'listening');
  const port = reserved.address().port;
  lan = 'https://' + adapter.address + ':' + port;
  assert.equal((await localSend('/lan/settings', 'POST', { enabled: true, address: adapter.address, port })).status, 400);
  await new Promise(done => reserved.close(done)); reserved = null;
  await assert.rejects(remote('/health'));
  const rootRow = await api('/library/roots', 'POST', { path: source });
  const assets = await until(async () => {
    const items = (await api('/assets')).items;
    return items.length === 3 && items.every(item => item.status === 'ready') && items;
  }, 'source media ready');
  const video = assets.find(item => item.kind === 'video');
  const audio = assets.find(item => item.kind === 'audio');
  const image = assets.find(item => item.kind === 'image');
  browser = await chromium.launch({ channel: 'msedge' });
  const hostPage = await browser.newPage();
  await hostPage.goto(local);
  await hostPage.getByRole('button', { name: '设置', exact: true }).click();
  await hostPage.getByRole('button', { name: '局域网访问', exact: true }).click();
  const config = hostPage.getByRole('dialog', { name: '局域网访问' });
  await config.getByRole('checkbox', { name: '启用局域网访问' }).check();
  await config.getByLabel('监听网卡地址').selectOption(adapter.address);
  await config.getByLabel('HTTPS 端口').fill(String(port));
  await config.getByRole('button', { name: '保存局域网设置' }).click();
  await expect(config.getByText(/等待重启/)).toBeVisible();
  const cer = await localSend('/lan/certificate');
  assert.equal(cer.status, 200);
  authority = new X509Certificate(Buffer.from(await cer.arrayBuffer())).toString();
  await browser.close(); browser = null;
  await stop();
  reserved = createServer();
  reserved.listen(port, adapter.address);
  await once(reserved, 'listening');
  await start();
  assert.match((await api('/lan/status')).error, /端口/);
  assert.equal((await api('/lan/status')).activeUrl, null);
  await stop();
  await new Promise(done => reserved.close(done)); reserved = null;
  await start();
  assert.equal((await api('/lan/status')).activeUrl, lan);
  assert.equal((await api('/lan/test', 'POST', {})).reachable, true);
  const health = await remote('/health');
  assert.equal(health.status, 200);
  await assert.rejects(remote('/health', { ca: [] }));
  assert.equal((await remote('/health', { headers: { Host: 'localhost:' + port } })).status, 403);
  for (const path of ['/workspace', '/assets', '/media/' + video.id + '/source', '/media/' + image.id + '/thumb'])
    assert.equal((await remote(path)).status, 401);
  const spoofed = await remote('/session', { method: 'POST', headers: { ...admin, Origin: lan, 'X-MshTV-Bootstrap': '1' } });
  assert.equal(spoofed.status, 401);
  const unauthHub = new WebSocket(lan.replace(/^https/, 'wss') + '/api/v1/events', { ca: authority, origin: lan });
  unauthHub.on('error', () => {});
  assert.equal((await once(unauthHub, 'unexpected-response'))[1].statusCode, 401);
  unauthHub.terminate();

  const expired = await api('/lan/code', 'POST', {});
  const wrong = expired.code === '10000000' ? '10000001' : '10000000';
  for (let attempt = 0; attempt < 8; attempt++)
    assert.equal((await remote('/lan/pair', { method: 'POST', body: { code: wrong, device: 'blocked' } })).status, 401);
  assert.equal((await remote('/lan/pair', { method: 'POST', body: { code: expired.code, device: 'blocked' } })).status, 429);
  const token = await pair('协议验收');
  assert.equal((await remote('/workspace', { headers: token })).status, 200);
  const groupResponse = await remote('/workspace/groups', { method: 'POST', headers: token, body: { name: '远程隔离组' } });
  assert.equal(groupResponse.status, 200);
  const isolatedBoard = await remote('/workspace/boards', {
    method: 'POST', headers: token, body: { name: '隔离画布', groupId: groupResponse.json().id },
  });
  assert.equal(isolatedBoard.status, 200);
  assert.deepEqual((await remote('/assets?boardId=' + isolatedBoard.json().id, { headers: token })).json().items, []);
  assert.equal((await remote('/media/' + video.id + '/source?boardId=' + isolatedBoard.json().id, { headers: token })).status, 404);
  for (const [path, method] of [['/storage/status', 'GET'], ['/clipboard/capability', 'GET'], ['/exports/pick-folder', 'POST'],
    ['/library/roots', 'POST'], ['/system/shutdown', 'POST'], ['/lan/status', 'GET']])
    assert.equal((await remote(path, { headers: token, method, body: method === 'POST' ? {} : undefined })).status, 403);
  const sanitized = (await remote('/library/roots', { headers: token })).json().find(item => item.id === rootRow.id);
  assert.equal(sanitized.path, 'source');
  const range = await remote('/media/' + video.id + '/source', { headers: { ...token, Range: 'bytes=0-1023' } });
  assert.equal(range.status, 206);
  assert.equal(range.data.length, 1024);
  assert.match(range.headers['content-range'], /^bytes 0-1023\//);
  assert.equal((await remote('/media/' + audio.id + '/waveform', { headers: token })).status, 200);
  assert.equal((await remote('/media/' + image.id + '/thumb', { headers: token })).status, 200);

  // The Node checks above use the actual CA. Edge pins only this test server's public key in its isolated process.
  const spki = new X509Certificate(health.leaf).publicKey.export({ type: 'spki', format: 'der' });
  const hash = createHash('sha256').update(spki).digest('base64');
  remoteBrowser = await chromium.launch({ channel: 'msedge', args: ['--ignore-certificate-errors-spki-list=' + hash, '--no-proxy-server'] });
  const context = await remoteBrowser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  await page.goto(lan);
  const dialog = page.getByRole('dialog', { name: 'MshTV 局域网连接' });
  await expect(dialog).toBeVisible();
  const { code } = await api('/lan/code', 'POST', {});
  await dialog.getByLabel('设备名称').fill('Edge 局域网测试');
  await dialog.getByLabel('配对码').fill(code);
  await dialog.getByRole('button', { name: '连接工作空间' }).click();
  await expect(page.getByRole('heading', { name: '工作空间' })).toBeVisible();
  assert.equal((await remote('/lan/pair', { method: 'POST', body: { code, device: 'reuse' } })).status, 401);
  await page.getByRole('link', { name: '打开画布 自由画布' }).click();
  await expect(page.getByText('已保存到本机', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '导出整个画布' })).toBeDisabled();
  await page.getByRole('button', { name: '预览 '+video.name, exact: true }).click();
  const videoPlayer = page.locator('.media-dialog video');
  await videoPlayer.evaluate(async media => { await media.play(); });
  await page.waitForFunction(() => document.querySelector('.media-dialog video')?.currentTime > 0.1);
  await page.getByRole('button', { name: '关闭媒体预览' }).click();
  const audioRow = page.getByTestId('asset-'+audio.id);
  await audioRow.getByRole('button', { name: '播放 '+audio.name, exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.audio-element audio')?.currentTime > 0.1);
  await expect(audioRow.getByRole('img', { name: '音频波形' })).toBeVisible();
  await audioRow.getByRole('button', { name: '暂停 '+audio.name, exact: true }).click();

  socket = new WebSocket(lan.replace(/^https/, 'wss') + '/api/v1/events?boardId=main', {
    ca: authority, origin: lan, headers: { Cookie: token.Cookie },
  });
  await once(socket, 'open');
  const handshake = once(socket, 'message');
  socket.send(JSON.stringify({ protocol: 'json', version: 1 }) + '\u001e');
  assert.equal(String((await handshake)[0]), '{}\u001e');
  const update = new Promise((resolveUpdate, reject) => {
    const timer = setTimeout(() => reject(new Error('No authenticated SignalR notification')), 15000);
    socket.on('message', bytes => {
      if (String(bytes).includes('LibraryChanged')) { clearTimeout(timer); resolveUpdate(); }
    });
  });
  copyFileSync(join(source, '画面.png'), join(source, '新增.png'));
  await update;
  await expect(page.getByRole('button', { name: '预览 新增.png', exact: true })).toBeVisible({ timeout: 15000 });

  const board = await api('/boards/main');
  await context.setOffline(true);
  await page.getByRole('button', { name: '添加文字备注', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '保存失败' })).toBeVisible();
  assert.equal((await api('/boards/main')).revision, board.revision);
  await context.setOffline(false);
  await page.getByRole('button', { name: '重试连接 / 保存', exact: true }).click();
  await expect(page.getByText('已保存到本机', { exact: true })).toBeVisible();
  const saved = await api('/boards/main');
  assert.equal(saved.document.items.length, 1);
  const mutation = { baseRevision: board.revision, clientId: crypto.randomUUID(), mutationId: crypto.randomUUID(),
    operations: [{ kind: 'deleteItem', id: saved.document.items[0].id }] };
  const put = (workspaceVersion, headers = token) => remote('/boards/main/mutations', {
    method: 'POST', headers: { ...headers, 'X-MshTV-Workspace': workspaceVersion }, body: mutation,
  });
  assert.equal((await put(saved.workspaceVersion)).status, 409);
  assert.equal((await put('different-workspace')).status, 409);
  assert.equal((await put(saved.workspaceVersion, { Cookie: token.Cookie })).status, 403);
  assert.equal((await put(saved.workspaceVersion, { ...token, Origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await api('/boards/main')).document.items.length, 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('[data-canvas-host]')).toBeVisible();
  assert.equal(await page.locator('.app-shell').evaluate(element => element.clientWidth), 390);

  const id = (await api('/lan/status')).devices.find(device => device.name === '协议验收').id;
  const closed = once(socket, 'close');
  await api('/lan/devices/' + id, 'DELETE');
  assert.ok(await Promise.race([closed.then(() => true), delay(4000).then(() => false)]));
  socket = null;
  assert.equal((await remote('/workspace', { headers: token })).status, 401);

  const persistent = await pair('重启保留');
  const deviceFile = readFileSync(join(fixture, 'data', 'lan-devices.json'), 'utf8');
  assert.equal(deviceFile.includes(persistent.Cookie.split('=')[1]), false);
  assert.equal(deviceFile.includes(persistent['X-CSRF-Token']), false);
  const browserState = await context.storageState();
  const browserCookie = browserState.cookies.find(cookie => cookie.name === '__Host-mshtv-lan');
  assert.ok(browserCookie.expires > Date.now() / 1000);
  await context.close();
  await stop(); await start();
  const bootstrap = await remote('/session', {
    method: 'POST', headers: { Cookie: persistent.Cookie, 'X-MshTV-Bootstrap': '1' },
  });
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.json().csrf, persistent['X-CSRF-Token']);
  assert.match(bootstrap.headers['set-cookie'][0], /Max-Age=31536000/i);
  assert.equal((await remote('/workspace', { headers: token })).status, 401);
  assert.equal((await remote('/workspace', { headers: persistent })).status, 200);
  const rememberedNames = (await api('/lan/status')).devices.map(device => device.name).sort();
  assert.deepEqual(rememberedNames, ['Edge 局域网测试', '重启保留']);

  const reopened = await remoteBrowser.newContext({ storageState: browserState });
  const reopenedPage = await reopened.newPage();
  await reopenedPage.goto(lan);
  await expect(reopenedPage.getByRole('heading', { name: '工作空间' })).toBeVisible();
  await expect(reopenedPage.getByRole('dialog', { name: 'MshTV 局域网连接' })).toHaveCount(0);
  await reopenedPage.getByRole('button', { name: '退出设备连接', exact: true }).click();
  await expect(reopenedPage.getByLabel('配对码')).toBeVisible();
  await reopened.close();
  await stop(); await start();
  const oldBrowserSession = { Cookie: browserCookie.name + '=' + browserCookie.value };
  assert.equal((await remote('/workspace', { headers: oldBrowserSession })).status, 401);
  assert.equal((await remote('/workspace', { headers: persistent })).status, 200);

  await api('/lan/settings', 'POST', { enabled: false, address: adapter.address, port });
  assert.equal((await remote('/health')).status, 403);
  await stop(); await start();
  assert.equal((await api('/lan/status')).activeUrl, null);
  await assert.rejects(remote('/health'));
  assert.equal((await api('/boards/main')).document.items.length, 1);
  await api('/lan/settings', 'POST', { enabled: true, address: adapter.address, port });
  await stop(); await start();
  assert.equal((await api('/lan/status')).activeUrl, lan);
  assert.equal((await remote('/workspace', { headers: persistent })).status, 401);
  console.log('PASS private HTTPS listener, remembered browser after restart, durable logout/revocation, protected media, Range/audio/video, SignalR, offline retry, revision conflicts and loopback-only restart.');
} finally {
  socket?.terminate();
  await remoteBrowser?.close();
  await browser?.close();
  if (reserved) await new Promise(done => reserved.close(done));
  await stop();
}
