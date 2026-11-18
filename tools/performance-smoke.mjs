import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';

// Use an isolated checkout build and a new data directory on every run.
const root = resolve(import.meta.dirname, '..');
const { chromium } = createRequire(join(root, 'apps/web/package.json'))('@playwright/test');
const server = resolve(process.argv[2] ?? join(root, 'src/MshTV.Server/bin/Release/net10.0/MshTV.Server.dll'));
const web = resolve(process.argv[3] ?? join(root, 'apps/web/dist'));
const full = process.argv.includes('--full');
mkdirSync(join(root, '.data'), { recursive: true });
const fixture = mkdtempSync(join(root, '.data/perf-run-'));
const data = join(fixture, 'data'), source = join(fixture, 'indexed'), incoming = join(fixture, 'incoming');
const database = join(data, 'canvas.db');
const origin = 'http://127.0.0.1:5263';
const png = join(fixture, 'original.png'), mp4 = join(fixture, 'video.mp4'), thumb = join(fixture, 'thumb.webp');
const result = { fixture, seed: full ? 100000 : 5000, library: {}, canvas: {} };
let child, browser, headers;

function ffmpeg(args, path) {
  const run = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', ...args, path], { windowsHide: true });
  assert.equal(run.status, 0, run.stderr?.toString() ?? run.error?.message);
}

async function waitFor(check, seconds = 25) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(100);
  }
  throw new Error('Timed out waiting for performance fixture');
}

async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise(done => child.once('exit', done));
  child.kill();
  await exit;
}

async function start() {
  const sdk = join(root, '.tools/dotnet/dotnet.exe');
  child = spawn(existsSync(sdk) ? sdk : 'dotnet', [server, '--webroot', web], {
    cwd: dirname(server), windowsHide: true, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, MSHTV_PORT: '5263', MSHTV_DATA_DIR: data },
  });
  await waitFor(async () => {
    assert.equal(child.exitCode, null, 'Isolated server exited');
    return fetch(origin + '/api/v1/health').then(r => r.ok).catch(() => false);
  });
  const session = await fetch(origin + '/api/v1/session', {
    method: 'POST', headers: { Origin: origin, 'X-MshTV-Bootstrap': '1' },
  });
  assert.equal(session.status, 200);
  headers = { Origin: origin, Cookie: session.headers.getSetCookie()[0].split(';')[0],
    'X-CSRF-Token': (await session.json()).csrf, 'Content-Type': 'application/json' };
}

async function api(path, body) {
  const response = await fetch(origin + '/api/v1' + path, {
    headers, method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

function p95(samples) {
  return Math.round(samples.toSorted((a, b) => a - b)[Math.ceil(samples.length * .95) - 1] * 10) / 10;
}

async function latency(action, count = 20) {
  await action();
  const times = [];
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    await action();
    times.push(performance.now() - start);
  }
  return p95(times);
}

function seedAssets() {
  const db = new DatabaseSync(database);
  const main = crypto.randomUUID(), extra = crypto.randomUUID();
  const insertRoot = db.prepare('INSERT INTO LibraryRoots (Id,Path,Enabled,Removed,Online,LastScanAt) VALUES (?,?,0,0,1,0)');
  const insert = db.prepare(`INSERT INTO LibraryAssets
    (Id,RootId,RelativePath,PathKey,PhysicalPath,Name,Kind,Extension,Size,ModifiedAt,AddedAt,StableSince,RetryAt,LeaseUntil,
     Version,Status,SeenScan,Width,Height,Duration,HasThumbnail,HasPreview)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0,0,1,'ready','',512,288,?, ?,0)`);
  const link = db.prepare("INSERT INTO LibraryMembers (LibraryId,AssetId,RootId,Removed,Missing,Revision,SeenScan) VALUES ('main',?,?,0,0,0,'')");
  const assets = [];
  try {
    db.exec('BEGIN');
    insertRoot.run(main, source);
    insertRoot.run(extra, join(source, 'extra'));
    for (let i = 0; i < result.seed; i++) {
      const id = crypto.randomUUID(), video = i < 20, assetRoot = i < 1000 ? main : extra;
      const extension = video ? '.mp4' : '.png', kind = video ? 'video' : 'image';
      const name = `frame-${String(i).padStart(6, '0')}${extension}`;
      const path = join(i < 1000 ? source : join(source, 'extra'), name);
      // The first 1000 have actual media and cached thumbnails. The rest are metadata-only list records.
      const populated = i < 1000;
      if (populated) {
        copyFileSync(video ? mp4 : png, path);
        copyFileSync(thumb, join(data, 'media-cache', `${id}-1-v1-thumb.webp`));
      }
      const file = populated ? statSync(path) : null;
      // Keep real files first in default sorting so browser paging uses the real thumbnails.
      const order = 1750000000000 - i;
      insert.run(id, assetRoot, name, name.toUpperCase(), path, name, kind, extension, file?.size ?? 5000,
        file ? Math.trunc(file.mtimeMs) : order, order, video ? 8 : null, Number(populated));
      link.run(id, assetRoot);
      if (i < 320) assets.push({ id, kind, name });
    }
    db.exec('COMMIT');
    return { main, assets };
  } finally { db.close(); }
}

function prepareBoard(items) {
  const db = new DatabaseSync(database);
  try {
    db.prepare('UPDATE Boards SET Revision=Revision+1, DocumentJson=? WHERE Id=?').run(
      JSON.stringify({ schemaVersion: 1, name: '性能测试', items, groups: [] }), 'main');
  } finally { db.close(); }
}

const heap = async cdp => {
  const { usedSize } = await cdp.send('Runtime.getHeapUsage');
  return Math.round(usedSize / 2 ** 20 * 10) / 10;
};
const workingSet = pid => {
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).WorkingSet64`],
    { windowsHide: true, encoding: 'utf8' });
  return Math.round(Number(ps.stdout.trim()) / 2 ** 20);
};

async function canvasCase(pool, count, label) {
  const columns = count <= 100 ? 10 : 20;
  const items = Array.from({ length: count }, (_, i) => {
    const asset = pool[i % pool.length];
    return {
      id: crypto.randomUUID(), assetId: asset.id, type: asset.kind, title: asset.name, text: '', groupId: null,
      x: (i % columns) * 132 + (i >= 300 ? 15000 : 0), y: Math.floor(i / columns) * 111,
      width: 120, height: 106,
    };
  });
  prepareBoard(items);
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  try {
    await page.addInitScript(() => performance.setResourceTimingBufferSize(3000));
    const began = performance.now();
    await page.goto(origin + "/?board=main");
    await page.getByText('已保存到本机', { exact: true }).waitFor();
    await page.locator('.asset-row').first().waitFor();
    const firstMs = Math.round(performance.now() - began);
    const surface = await page.locator('.konvajs-content').boundingBox();
    const x = surface.x + 150, y = surface.y + 138;
    let playerPeak = 0, afterPan = 0;
    if (label === 'mixed') {
      await page.mouse.click(x, y);
      await page.locator('.canvas-playback video').waitFor();
      await page.waitForFunction(() => !document.querySelector('.canvas-playback video').paused &&
        document.querySelector('.canvas-playback video').currentTime > .1);
      playerPeak = await page.locator('audio[src],video[src]').count();
    }
    const dragStart = performance.now();
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 35, y + 22, { steps: 14 });
    const dragInputMs = Math.round(performance.now() - dragStart);
    const savedAt = performance.now();
    await page.mouse.up();
    await waitFor(async () => (await api('/boards/main')).document.items[0].x === 35);
    const saveConfirmedMs = Math.round(performance.now() - savedAt);
    if (label === 'mixed') {
      await page.mouse.move(x, y);
      await page.mouse.down({ button: 'middle' });
      await page.mouse.move(surface.x + surface.width - 50, surface.y + surface.height - 50, { steps: 12 });
      await page.mouse.up({ button: 'middle' });
      // The first card moved to the right edge; a second pan takes it fully outside.
      await page.mouse.move(x, y);
      await page.mouse.down({ button: 'middle' });
      await page.mouse.move(x + 550, y + 150, { steps: 10 });
      await page.mouse.up({ button: 'middle' });
      await page.waitForFunction(() => !document.querySelector('.canvas-playback video'));
      afterPan = await page.locator('audio[src],video[src]').count();
    }
    await page.keyboard.press('Escape');
    if (count <= 300) await page.getByRole('button', { name: '适应全部' }).click();
    const boardIds = [...new Set(items.slice(0, 300).map(item => item.assetId))];
    if (count <= 300) await page.waitForFunction(ids => {
      const names = new Set(performance.getEntriesByType('resource')
        .map(entry => entry.name.match(/\/media\/([^/]+)\/thumb\?/)?.[1]));
      return ids.every(id => names.has(id));
    }, boardIds, { timeout: 20000 });
    await sleep(350);
    const frames = await page.evaluate(async () => {
      const stage = document.querySelector('.konvajs-content');
      const rect = stage.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      const next = () => new Promise(resolve => requestAnimationFrame(resolve));
      const mouse = (type, clientX, clientY) => stage.dispatchEvent(new MouseEvent(type, { clientX, clientY, button: 1, bubbles: true, cancelable: true }));
      const series = async move => {
        const samples = [];
        let previous = await next();
        for (let i = 0; i < 60; i++) {
          // A burst of four input events before each presented frame.
          for (let j = 0; j < 4; j++) move(i, j);
          const now = await next();
          samples.push(now - previous);
          previous = now;
        }
        return samples;
      };
      mouse('mousedown', x, y);
      const pan = await series((i, j) => mouse('mousemove', x + (i * 4 + j) % 110, y + i % 20));
      mouse('mouseup', x, y);
      const zoom = await series((i, j) => stage.dispatchEvent(new WheelEvent('wheel', {
        clientX: x + j, clientY: y, deltaY: i % 2 ? -6 : 6, bubbles: true, cancelable: true,
      })));
      return { pan, zoom };
    });
    const cdp = await page.context().newCDPSession(page);
    const refreshThumbRequests = async () => {
      const requests = () => page.evaluate(() => performance.getEntriesByType('resource').filter(entry => entry.name.includes('/thumb?')).length);
      const before = await requests();
      await sleep(11000);
      return (await requests()) - before;
    };
    let revision = (await api('/boards/main')).revision;
    const clientId = crypto.randomUUID();
    let xOffset = 36;
    const saveP95Ms = await latency(async () => {
      const saved = await api('/boards/main/mutations', { baseRevision: revision, clientId, mutationId: crypto.randomUUID(),
        operations: [{ kind: 'putItem', item: { ...items[0], x: xOffset++ } }] });
      revision = saved.revision;
    });
    return { firstMs, panP95Ms: p95(frames.pan), zoomP95Ms: p95(frames.zoom),
      dragInputMs, saveConfirmedMs, saveP95Ms, jsHeapMiB: await heap(cdp), playerPeak, afterPan,
      refreshThumbRequests: count === 300 ? await refreshThumbRequests() : undefined };
  } finally { await page.close(); }
}

async function librarySoak() {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  try {
    await page.goto(origin + "/?board=main");
    await page.locator('.asset-row').first().waitFor();
    const session = await page.context().newCDPSession(page);
    const measure = async () => { await session.send('HeapProfiler.collectGarbage'); return heap(session); };
    const before = await measure();
    const pageButton = (name) => page.getByRole('button', { name, exact: true });
    for (const direction of ['下一页', '上一页']) for (let i = 0; i < 19; i++) {
      const previous = await page.locator('.asset-row').first().innerText();
      await pageButton(direction).click();
      await page.waitForFunction(text => document.querySelector('.asset-row')?.innerText !== text, previous);
    }
    await sleep(1000);
    return { jsHeapBeforeMiB: before, jsHeapAfterMiB: await measure(), maxPlayers: await page.locator('audio[src],video[src]').count() };
  } finally { await page.close(); }
}

try {
  let occupied = false;
  try { await fetch(origin + '/api/v1/health'); occupied = true; } catch {}
  assert.equal(occupied, false, 'Port 5263 already has a service');
  for (const path of [source, join(source, 'extra'), incoming]) mkdirSync(path, { recursive: true });
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=512x288', '-frames:v', '1', '-threads', '1'], png);
  ffmpeg(['-i', png, '-vf', 'scale=256:-1', '-threads', '1'], thumb);
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=512x288:rate=24', '-t', '8', '-c:v', 'libx264', '-threads', '1', '-movflags', '+faststart'], mp4);
  await start();
  await stop();
  const { main, assets } = seedAssets();
  await start();
  for (const [label, filter] of [['1000', `&rootId=${main}`], [String(result.seed), '']]) {
    result.library[label] = {
      listP95Ms: await latency(() => api('/assets?limit=100' + filter)),
      filteredP95Ms: await latency(() => api('/assets?limit=50&q=frame-000&kind=image&sort=modified' + filter)),
      noMatchP95Ms: await latency(() => api('/assets?limit=50&q=无匹配' + filter)),
    };
  }
  console.log('Library', result.library);
  browser = await chromium.launch({ channel: 'msedge' });
  result.edge = browser.version();
  result.canvas.images100 = await canvasCase(assets.slice(20, 120), 100, 'images');
  result.canvas.images300 = await canvasCase(assets.slice(20), 300, 'images');
  result.canvas.mixed = await canvasCase(assets.slice(0, 70), 70, 'mixed');
  if (full) result.canvas.items10000 = await canvasCase(assets.slice(20), 10000, 'full');
  console.log('Canvas', result.canvas);
  result.soak = await librarySoak();
  console.log('Paging', result.soak);
  for (let i = 0; i < 5000; i++) copyFileSync(png, join(incoming, `scan-${i}.png`));
  const scanStart = performance.now();
  const watched = await api('/library/roots', { path: incoming });
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const scanned = db.prepare('SELECT LastScanAt, Online, Error FROM LibraryRoots WHERE Id=?');
    const count = db.prepare('SELECT COUNT(*) AS total FROM LibraryAssets WHERE RootId=?');
    await waitFor(() => {
      const row = scanned.get(watched.id);
      assert.ok(!row.Error, row.Error);
      return row.LastScanAt && row.Online && count.get(watched.id).total === 5000;
    }, 100);
    result.scan = { indexed5000Ms: Math.round(performance.now() - scanStart), backendWorkingSetMiB: workingSet(child.pid) };
  } finally { db.close(); }
  const path = join(fixture, 'result.json');
  writeFileSync(path, JSON.stringify(result, null, 2) + '\n');
  console.log('Result', path, result);
} finally {
  await browser?.close();
  await stop();
}
