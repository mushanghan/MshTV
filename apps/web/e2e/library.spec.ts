import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync, unlinkSync, openSync, writeSync, closeSync, symlinkSync, utimesSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const dataRoot = resolve('../..', '.data'); mkdirSync(dataRoot, { recursive: true });
const fixture = mkdtempSync(join(dataRoot, 'library-fixture-'));
let imageBytes = Buffer.alloc(0);
function ffmpeg(args: string[]) { const r = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr || String(r.error)); }
test.beforeAll(() => {
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=teal:s=320x180', '-frames:v', '1', '-threads', '1', join(fixture, 'image.png')]);
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=24', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1', '-movflags', '+faststart', join(fixture, 'video.mp4')]);
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', join(fixture, 'audio.wav')]);
  imageBytes = readFileSync(join(fixture, 'image.png'));
});
async function api(page: Page, path: string, method = 'GET', body?: object) {
  return page.evaluate(async ({ path, method, body }) => {
    const session = method === 'GET' ? null : await (await fetch('/api/v1/session', { method: 'POST', headers: { 'X-MshTV-Bootstrap': '1' } })).json();
    const response = await fetch('/api/v1' + path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session?.csrf ?? '' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const result = await response.json().catch(() => ({})); if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(result)}`); return result;
  }, { path, method, body });
}
const items = async (page: Page) => (await api(page, '/assets?limit=200')).items as any[];
async function saved(page: Page) { await expect(page.getByText('已保存到本机', { exact: true })).toBeVisible(); }
async function cleanRoots(page: Page) { for (const root of await api(page, '/library/roots')) await api(page, `/library/roots/${root.id}?revision=${root.revision}`, 'DELETE'); }
async function scanned(page: Page, id: string, after = 0) {
  await expect.poll(async () => (await api(page, '/library/roots')).some((r: any) => r.id === id && r.lastScanAt > after && !r.baselinePending), { timeout: 20000 }).toBe(true);
}

test('folder scan watch previews drag coordinates references and missing files', async ({ page, browser }) => {
  test.setTimeout(120000); let events = 0;
  page.on('websocket', socket => socket.on('framereceived', event => { if (String(event.payload).includes('LibraryChanged')) events++; }));
  await page.goto('/?board=main'); await saved(page); await cleanRoots(page);
  await page.keyboard.press('Control+a'); await page.keyboard.press('Delete'); await saved(page);
  await page.getByRole('button', { name: '管理监控文件夹' }).click();
  await page.getByRole('textbox', { name: 'Windows 后端文件夹路径' }).fill(fixture); await page.getByRole('button', { name: '添加目录', exact: true }).click();
  await expect(page.getByText(fixture, { exact: true })).toBeVisible(); await page.getByRole('button', { name: '关闭文件夹管理' }).click();
  await expect.poll(async () => (await items(page)).filter(a => a.status === 'ready').length, { timeout: 35000 }).toBe(3);
  let assets = await items(page); const image = assets.find(a => a.name === 'image.png')!, video = assets.find(a => a.kind === 'video')!, audio = assets.find(a => a.kind === 'audio')!;
  expect(image.hasThumbnail).toBe(true); expect(video.hasThumbnail).toBe(true); expect(video.duration).toBeGreaterThan(1); expect(audio.duration).toBeGreaterThan(1);
  expect((await api(page, '/boards/main')).document.items).toHaveLength(0);
  await expect.poll(() => events).toBeGreaterThan(0);
  const range = await page.request.get(`/api/v1/media/${video.id}/source`, { headers: { Range: 'bytes=0-31' } }); expect(range.status()).toBe(206); expect((await range.body()).length).toBe(32);
  expect((await page.request.head(`/api/v1/media/${video.id}/source`)).status()).toBe(200);
  expect((await page.request.get(`/api/v1/media/${video.id}/source`, { headers: { Range: 'bytes=999999999-' } })).status()).toBe(416);
  const anonymous = await browser.newContext(); expect((await anonymous.request.get(`http://127.0.0.1:5193/api/v1/media/${image.id}/source`)).status()).toBe(401); await anonymous.close();
  await page.getByRole('button', { name: '预览 image.png', exact: true }).click(); await expect(page.locator('.large-image')).toBeVisible();
  await expect.poll(() => page.locator('.large-image').evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0); await page.getByRole('button', { name: '关闭媒体预览' }).click();
  await page.getByRole('button', { name: `预览 ${video.name}`, exact: true }).click();
  const player = page.locator('.media-dialog video');
  await player.evaluate(async (node: HTMLVideoElement) => { await node.play(); });
  await expect.poll(() => player.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeGreaterThan(0);
  await player.evaluate((node: HTMLVideoElement) => { node.pause(); node.currentTime = 1; });
  await page.getByRole('button', { name: '关闭媒体预览' }).click(); await expect(page.locator('video,audio')).toHaveCount(0);
  const host = page.locator('[data-canvas-host]');
  const imageRow = page.getByTestId(`asset-${image.id}`);
  const thumbnail = imageRow.locator('img');
  const mark = imageRow.locator('.asset-canvas-mark');
  await expect.poll(() => thumbnail.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await expect(mark).toHaveCount(0);
  const fileDropRequests: string[] = [];
  page.on('request', request => {
    const { pathname } = new URL(request.url());
    if (pathname === '/api/v1/assets/import' || pathname === '/api/v1/assets/drop-candidates') fileDropRequests.push(pathname);
  });
  await thumbnail.dragTo(host, { targetPosition: { x: 340, y: 260 } }); await saved(page);
  await expect(mark).toBeVisible();
  await expect(page.getByRole('button', { name: '预览 image.png', exact: true })).toHaveAccessibleDescription('已添加到画布');
  await expect(page.getByTestId(`asset-${video.id}`).locator('.asset-canvas-mark')).toHaveCount(0);
  await expect.poll(async () => (await api(page, '/boards/main')).document.items.length).toBe(1);
  let board = await api(page, '/boards/main'); expect(board.document.items[0].assetId).toBe(image.id); expect(board.document.items[0].x).toBeCloseTo(240, 0); expect(board.document.items[0].y).toBeCloseTo(160, 0);
  const rect = (await host.boundingBox())!;
  const mixedDrag = await page.evaluateHandle(id => {
    const data = new DataTransfer();
    data.setData('application/x-mshtv-asset', id);
    data.items.add(new File(['thumbnail data'], 'thumb.webp', { type: 'image/webp' }));
    return data;
  }, image.id);
  await host.dispatchEvent('drop', { dataTransfer: mixedDrag, clientX: rect.x + 480, clientY: rect.y + 340 });
  await mixedDrag.dispose();
  await expect.poll(async () => (await api(page, '/boards/main')).document.items.length).toBe(2);
  expect((await api(page, '/boards/main')).document.items[1].assetId).toBe(image.id);
  await page.keyboard.press('Control+z'); await saved(page);
  await expect.poll(async () => (await api(page, '/boards/main')).document.items.length).toBe(1);
  await expect(mark).toBeVisible();
  await page.keyboard.press('Control+Shift+z'); await saved(page);
  await expect.poll(async () => (await api(page, '/boards/main')).document.items.length).toBe(2);
  expect(fileDropRequests).toEqual([]);
  expect((await items(page)).map(asset => asset.id).sort()).toEqual(assets.map(asset => asset.id).sort());
  await page.mouse.move(rect.x + 200, rect.y + 100); await page.mouse.wheel(0, -100); await expect(page.getByTitle('重置到 100%')).toHaveText('135%');
  await page.getByTestId(`asset-${video.id}`).dragTo(host, { targetPosition: { x: 400, y: 300 } }); await saved(page);
  await expect.poll(async () => (await api(page, '/boards/main')).document.items.length).toBe(3);
  const scale = Math.exp(.3), cameraX = 200 - 100 * scale;
  board = await api(page, '/boards/main'); expect(board.document.items[2].x).toBeCloseTo((400 - cameraX) / scale, 0); expect(board.document.items[2].y).toBeCloseTo(200 / scale, 0);
  await page.getByTestId(`asset-${audio.id}`).dragTo(host, { targetPosition: { x: 520, y: 180 } }); await saved(page);
  await expect.poll(async () => (await api(page, '/boards/main')).document.items.length).toBe(4);
  await page.reload(); await saved(page); board = await api(page, '/boards/main'); expect(board.document.items.filter((i: any) => i.assetId === image.id)).toHaveLength(2); expect(board.document.items).toHaveLength(4);
  await expect(mark).toBeVisible();
  const revision = board.revision, initialEvents = events;
  copyFileSync(join(fixture, 'image.png'), join(fixture, 'new.png'));
  await expect(page.getByRole('button', { name: '预览 new.png', exact: true })).toBeVisible({ timeout: 15000 }); await expect.poll(() => events).toBeGreaterThan(initialEvents);
  mkdirSync(join(fixture, 'moved')); renameSync(join(fixture, 'video.mp4'), join(fixture, 'moved', 'renamed.mp4'));
  await expect.poll(async () => (await api(page, `/assets/${video.id}`)).name, { timeout: 15000 }).toBe('renamed.mp4');
  unlinkSync(join(fixture, 'image.png'));
  await expect.poll(async () => (await api(page, `/assets/${image.id}`)).status, { timeout: 15000 }).toBe('missing');
  await expect(page.getByTestId(`asset-${image.id}`)).toContainText('文件缺失', { timeout: 15000 });
  expect((await api(page, '/boards/main')).revision).toBe(revision);
  await page.getByRole('button', { name: '预览 image.png', exact: true }).click(); await expect(page.locator('.media-dialog')).toContainText('文件缺失'); await page.getByRole('button', { name: '关闭媒体预览' }).click();
  await page.screenshot({ path: 'test-results/library-canvas.png', fullPage: true });
  await page.keyboard.press('Control+a'); await page.keyboard.press('Delete'); await saved(page); expect(readFileSync(join(fixture, 'audio.wav')).length).toBeGreaterThan(1000);
  await expect(mark).toHaveCount(0);
});

test('stable writing pause rescan pagination unsupported media and path boundaries', async ({ page }) => {
  test.setTimeout(120000); await page.goto('/?board=main'); await saved(page);
  for (const root of await api(page, '/library/roots')) await api(page, `/library/roots/${root.id}?revision=${root.revision}`, 'DELETE');
  const rootPath = mkdtempSync(join(dataRoot, 'library-safety-'));
  const root = await api(page, '/library/roots', 'POST', { path: rootPath });
  const bytes = imageBytes; const fd = openSync(join(rootPath, 'writing.png'), 'w'); writeSync(fd, bytes.subarray(0, 30));
  try {
    await expect.poll(async () => (await items(page)).some(a => a.name === 'writing.png'), { timeout: 10000 }).toBe(true);
    const asset = (await items(page)).find(a => a.name === 'writing.png'); expect(asset.status).toBe('pending');
    // Hold the writer beyond the stability window: stable size alone must not publish the partial file.
    await page.waitForTimeout(3500); expect((await api(page, `/assets/${asset.id}`)).status).toBe('pending');
    expect((await page.request.get(`/api/v1/media/${asset.id}/source`)).status()).toBe(409);
    writeSync(fd, bytes.subarray(30));
  } finally { closeSync(fd); }
  await expect.poll(async () => (await items(page)).find(a => a.name === 'writing.png')?.status, { timeout: 20000 }).toBe('ready');
  writeFileSync(join(rootPath, 'unsupported.mp4'), 'not a video');
  await expect.poll(async () => (await items(page)).find(a => a.name === 'unsupported.mp4')?.status, { timeout: 20000 }).toBe('ready');
  await page.getByRole('button', { name: '预览 unsupported.mp4', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('当前视频格式不支持浏览器预览'); await page.getByRole('button', { name: '关闭媒体预览' }).click();
  await api(page, `/library/roots/${root.id}`, 'PATCH', { enabled: false, revision: root.revision });
  const stale = await page.evaluate(async root => { const s = await (await fetch('/api/v1/session', { method: 'POST', headers: { 'X-MshTV-Bootstrap': '1' } })).json(); return (await fetch(`/api/v1/library/roots/${root.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': s.csrf }, body: JSON.stringify({ enabled: true, revision: root.revision }) })).status; }, root);
  expect(stale).toBe(409);
  copyFileSync(join(rootPath, 'writing.png'), join(rootPath, 'paused.png'));
  await expect.poll(async () => (await api(page, '/library/roots'))[0].enabled).toBe(false);
  await page.waitForTimeout(1800); expect((await api(page, '/assets?q=paused')).items).toHaveLength(0);
  // Explicitly rescan a paused source: scans work without re-enabling its watcher.
  await api(page, `/library/roots/${root.id}/scan`, 'POST');
  await expect.poll(async () => (await items(page)).some(a => a.name === 'paused.png'), { timeout: 12000 }).toBe(true);
  const first = await api(page, '/assets?limit=1'), second = await api(page, '/assets?limit=1&cursor=' + encodeURIComponent(first.nextCursor)); expect(first.items[0].id).not.toBe(second.items[0].id);
  expect((await api(page, '/assets?kind=video')).items.every((a: any) => a.kind === 'video')).toBe(true);
  expect((await api(page, '/assets?q=paused')).items.map((a: any) => a.name)).toEqual(['paused.png']);
  const response = await page.evaluate(async path => { const s = await (await fetch('/api/v1/session', { method: 'POST', headers: { 'X-MshTV-Bootstrap': '1' } })).json(); return (await fetch('/api/v1/library/roots', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': s.csrf }, body: JSON.stringify({ path }) })).status; }, join(rootPath, '..'));
  expect(response).toBe(400);
  const outside = mkdtempSync(join(dataRoot, 'outside-')); copyFileSync(join(rootPath, 'writing.png'), join(outside, 'private.png'));
  const junction = join(rootPath, 'escape'); symlinkSync(outside, junction, 'junction');
  const beforeScan = (await api(page, '/library/roots'))[0].lastScanAt;
  await api(page, `/library/roots/${root.id}/scan`, 'POST');
  await expect.poll(async () => (await api(page, '/library/roots'))[0].lastScanAt).toBeGreaterThan(beforeScan);
  expect((await api(page, '/assets?q=private')).items).toHaveLength(0);
  // Replace an already indexed parent with a junction while the watcher is paused.
  // The source endpoint must validate the opened path rather than trust the saved relative path.
  const checked = join(rootPath, 'checked'); mkdirSync(checked); copyFileSync(join(rootPath, 'writing.png'), join(checked, 'secret.png'));
  await api(page, `/library/roots/${root.id}/scan`, 'POST');
  await expect.poll(async () => (await api(page, '/assets?q=secret')).items[0]?.status, { timeout: 20000 }).toBe('ready');
  const guarded = (await api(page, '/assets?q=secret')).items[0];
  const moved = mkdtempSync(join(dataRoot, 'moved-safe-')); renameSync(checked, join(moved, 'original'));
  writeFileSync(join(outside, 'secret.png'), 'unauthorized private bytes'); symlinkSync(outside, checked, 'junction');
  expect((await page.request.get(`/api/v1/media/${guarded.id}/source`)).status()).toBe(404);
  const asset = (await items(page)).find(a => a.name === 'writing.png'); const currentRoot = (await api(page, '/library/roots'))[0]; await api(page, `/library/roots/${root.id}?revision=${currentRoot.revision}`, 'DELETE');
  expect((await page.request.get(`/api/v1/media/${asset.id}/source`)).status()).toBe(410); expect(readFileSync(join(rootPath, 'writing.png'))).toEqual(bytes);
});

test('subfolder option controls scan and watch while existing canvas references remain', async ({ page }) => {
  test.setTimeout(120000); await page.goto('/?board=main'); await saved(page); await cleanRoots(page);
  const directory = mkdtempSync(join(dataRoot, 'scope-options-')); mkdirSync(join(directory, 'child'));
  writeFileSync(join(directory, 'top.png'), imageBytes); writeFileSync(join(directory, 'child', 'before.png'), imageBytes);
  await page.getByRole('button', { name: '管理监控文件夹' }).click();
  const addOptions = page.getByRole('group', { name: '新文件夹监控选项', exact: true });
  await expect(addOptions.getByRole('checkbox', { name: '包含子文件夹', exact: true })).toBeChecked();
  await expect(addOptions.getByRole('checkbox', { name: '只计入新文件', exact: true })).not.toBeChecked();
  await addOptions.getByRole('checkbox', { name: '包含子文件夹', exact: true }).uncheck();
  await page.getByRole('textbox', { name: 'Windows 后端文件夹路径' }).fill(directory); await page.getByRole('button', { name: '添加目录', exact: true }).click();
  await expect(page.getByText(directory, { exact: true })).toBeVisible();
  const root = (await api(page, '/library/roots'))[0]; expect(root.includeSubdirectories).toBe(false); await scanned(page, root.id);
  expect((await items(page)).map(a => a.name)).toEqual(['top.png']);
  writeFileSync(join(directory, 'child', 'new-child.png'), imageBytes);
  const before = (await api(page, '/library/roots'))[0].lastScanAt; await api(page, `/library/roots/${root.id}/scan`, 'POST'); await scanned(page, root.id, before);
  expect((await api(page, '/assets?q=child')).items).toHaveLength(0);
  const options = page.getByRole('group', { name: `监控选项 ${directory}`, exact: true });
  await options.getByRole('checkbox', { name: '包含子文件夹', exact: true }).check();
  await expect.poll(async () => (await items(page)).filter(a => a.status === 'ready').length, { timeout: 20000 }).toBe(3);
  const child = (await items(page)).find(a => a.name === 'before.png');
  await page.getByRole('button', { name: '关闭文件夹管理' }).click();
  await page.getByTestId(`asset-${child.id}`).dragTo(page.locator('[data-canvas-host]'), { targetPosition: { x: 300, y: 200 } });
  await expect.poll(async () => (await api(page, '/boards/main')).document.items.some((i: any) => i.assetId === child.id)).toBe(true);
  await page.getByRole('button', { name: '管理监控文件夹' }).click();
  const priorScan = (await api(page, '/library/roots'))[0].lastScanAt;
  await options.getByRole('checkbox', { name: '包含子文件夹', exact: true }).uncheck(); await scanned(page, root.id, priorScan);
  expect((await api(page, `/assets/${child.id}`)).status).toBe('ready');
  writeFileSync(join(directory, 'child', 'excluded.png'), imageBytes); writeFileSync(join(directory, 'top-after.png'), imageBytes);
  await expect.poll(async () => (await api(page, '/assets?q=top-after')).items.length, { timeout: 15000 }).toBe(1);
  expect((await api(page, '/assets?q=excluded')).items).toHaveLength(0);
  await page.reload(); await saved(page); await page.getByRole('button', { name: '管理监控文件夹' }).click();
  await expect(options.getByRole('checkbox', { name: '包含子文件夹', exact: true })).not.toBeChecked();
  expect((await api(page, '/boards/main')).document.items.some((i: any) => i.assetId === child.id)).toBe(true);
  expect(readFileSync(join(directory, 'child', 'before.png'))).toEqual(imageBytes);
});

test('new-only baselines survive rescans and option changes without using file timestamps', async ({ page }) => {
  test.setTimeout(150000); await page.goto('/?board=main'); await saved(page); await cleanRoots(page);
  const directory = mkdtempSync(join(dataRoot, 'new-options-')); mkdirSync(join(directory, 'child'));
  writeFileSync(join(directory, 'old.png'), imageBytes); writeFileSync(join(directory, 'child', 'old-child.png'), imageBytes);
  await page.getByRole('button', { name: '管理监控文件夹' }).click();
  await page.getByRole('group', { name: '新文件夹监控选项', exact: true }).getByRole('checkbox', { name: '只计入新文件', exact: true }).check();
  await page.getByRole('textbox', { name: 'Windows 后端文件夹路径' }).fill(directory); await page.getByRole('button', { name: '添加目录', exact: true }).click();
  await expect(page.getByText(directory, { exact: true })).toBeVisible();
  const root = (await api(page, '/library/roots'))[0]; await scanned(page, root.id); expect(await items(page)).toHaveLength(0);
  renameSync(join(directory, 'old.png'), join(directory, 'renamed-old.png')); utimesSync(join(directory, 'child', 'old-child.png'), new Date(), new Date());
  const before = (await api(page, '/library/roots'))[0].lastScanAt; await api(page, `/library/roots/${root.id}/scan`, 'POST'); await scanned(page, root.id, before); expect(await items(page)).toHaveLength(0);
  for (const relative of ['new.png', join('child', 'new-child.png')]) { const name = join(directory, relative); writeFileSync(name, imageBytes); utimesSync(name, new Date('2020-01-01'), new Date('2020-01-01')); }
  await expect.poll(async () => (await items(page)).filter(a => a.status === 'ready').length, { timeout: 20000 }).toBe(2);
  const added = (await items(page)).find(a => a.name === 'new.png');
  const options = page.getByRole('group', { name: `监控选项 ${directory}`, exact: true });
  // Expanding scope in new-only mode must establish a new baseline, not ingest old subfolders.
  await options.getByRole('checkbox', { name: '包含子文件夹', exact: true }).uncheck();
  await expect.poll(async () => (await api(page, '/library/roots'))[0].includeSubdirectories).toBe(false); await scanned(page, root.id, before);
  writeFileSync(join(directory, 'child', 'scope-old.png'), imageBytes);
  await options.getByRole('checkbox', { name: '包含子文件夹', exact: true }).check();
  await expect.poll(async () => (await api(page, '/library/roots'))[0].includeSubdirectories).toBe(true); await scanned(page, root.id, before);
  expect((await api(page, '/assets?q=scope-old')).items).toHaveLength(0);
  expect((await api(page, `/assets/${added.id}`)).status).toBe('ready');
  await page.screenshot({ path: 'test-results/monitor-options.png', fullPage: true });
  await options.getByRole('checkbox', { name: '只计入新文件', exact: true }).uncheck();
  await expect.poll(async () => (await items(page)).filter(a => a.status === 'ready').length, { timeout: 20000 }).toBe(5);
  // Turning new-only on for an existing paused root preserves indexed assets and ignores currently unindexed files.
  const row = page.locator('.root-row').filter({ hasText: directory }); await row.getByRole('button', { name: '暂停', exact: true }).click();
  writeFileSync(join(directory, 'ignored-on-change.png'), imageBytes);
  const last = (await api(page, '/library/roots'))[0].lastScanAt;
  await options.getByRole('checkbox', { name: '只计入新文件', exact: true }).check(); await scanned(page, root.id, last);
  const beforeManual = (await api(page, '/library/roots'))[0].lastScanAt;
  await api(page, `/library/roots/${root.id}/scan`, 'POST');
  await scanned(page, root.id, beforeManual);
  expect((await api(page, '/assets?q=ignored-on-change')).items).toHaveLength(0); expect((await items(page)).length).toBe(5);
  await row.getByRole('button', { name: '启用', exact: true }).click(); writeFileSync(join(directory, 'after-change.png'), imageBytes);
  await expect.poll(async () => (await api(page, '/assets?q=after-change')).items.length, { timeout: 15000 }).toBe(1);
  await page.reload(); await saved(page); await page.getByRole('button', { name: '管理监控文件夹' }).click();
  await expect(options.getByRole('checkbox', { name: '只计入新文件', exact: true })).toBeChecked();
  expect((await api(page, `/assets/${added.id}`)).id).toBe(added.id);
});

test('duplicate registration cannot silently discard unchecked scope; existing records are distinct from new arrivals', async ({ page }) => {
  test.setTimeout(90000); await page.goto('/?board=main'); await saved(page); await cleanRoots(page);
  const directory = mkdtempSync(join(dataRoot, 'duplicate-scope-')); mkdirSync(join(directory, 'child', 'deep'), { recursive: true });
  writeFileSync(join(directory, 'top.png'), imageBytes); writeFileSync(join(directory, 'child', 'deep', 'old-nested.png'), imageBytes);
  const root = await api(page, '/library/roots', 'POST', { path: directory });
  await expect.poll(async () => (await items(page)).filter(a => a.status === 'ready').length, { timeout: 20000 }).toBe(2);
  await page.getByRole('button', { name: '管理监控文件夹' }).click();
  await page.getByRole('group', { name: '新文件夹监控选项', exact: true }).getByRole('checkbox', { name: '包含子文件夹', exact: true }).uncheck();
  await page.getByRole('textbox', { name: 'Windows 后端文件夹路径' }).fill(directory); await page.getByRole('button', { name: '添加目录', exact: true }).click();
  await expect(page.locator('.folder-dialog [role=alert]')).toContainText('上方选项只用于新目录');
  expect((await api(page, '/library/roots'))[0].includeSubdirectories).toBe(true);
  const row = page.locator('.root-row').filter({ hasText: directory });
  await expect(row.locator('.root-scan-scope')).toContainText('当前文件夹及全部子文件夹');
  const before = (await api(page, '/library/roots'))[0].lastScanAt;
  await row.getByRole('checkbox', { name: '包含子文件夹', exact: true }).uncheck();
  await scanned(page, root.id, before); await expect(row.locator('.root-scan-scope')).toContainText('不扫描子文件夹');
  writeFileSync(join(directory, 'new-top.png'), imageBytes); writeFileSync(join(directory, 'child', 'deep', 'must-not-import.png'), imageBytes);
  await expect.poll(async () => (await api(page, '/assets?q=new-top')).items.length, { timeout: 15000 }).toBe(1);
  const stamp = (await api(page, '/library/roots'))[0].lastScanAt; await api(page, `/library/roots/${root.id}/scan`, 'POST'); await scanned(page, root.id, stamp);
  expect((await api(page, '/assets?q=must-not-import')).items).toHaveLength(0);
  expect((await api(page, '/assets?q=old-nested')).items).toHaveLength(1);
  await page.getByRole('button', { name: '关闭文件夹管理' }).click();
  const old = (await api(page, '/assets?q=old-nested')).items[0];
  await expect(page.getByTestId(`asset-${old.id}`)).toContainText('当前不监控子目录');
  await page.getByRole('button', { name: '管理监控文件夹' }).click();
  await page.screenshot({ path: 'test-results/monitor-scope-clarity.png', fullPage: true });
});

test('a frontend served by an older backend cannot submit unsupported monitor options', async ({ page }) => {
  await page.route('**/api/v1/health', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ name: 'MshTV', status: 'ok' }) }));
  await page.goto('/?board=main'); await saved(page);
  let submissions = 0; page.on('request', req => { if (new URL(req.url()).pathname === '/api/v1/library/roots' && req.method() === 'POST') submissions++; });
  await page.getByRole('button', { name: '管理监控文件夹' }).click();
  await expect(page.locator('.folder-dialog [role=alert]')).toContainText('前后端版本不匹配');
  await expect(page.getByRole('button', { name: '添加目录', exact: true })).toBeDisabled();
  await expect(page.getByRole('group', { name: '新文件夹监控选项', exact: true }).getByRole('checkbox', { name: '包含子文件夹', exact: true })).toBeDisabled();
  expect(submissions).toBe(0);
});

test('re-adding a deleted folder restores only the chosen scope and respects new-only', async ({ page }) => {
  test.setTimeout(120000); await page.goto('/?board=main'); await saved(page); await cleanRoots(page);
  const directory = mkdtempSync(join(dataRoot, 'restore-scope-')); mkdirSync(join(directory, 'child', 'deep'), { recursive: true });
  writeFileSync(join(directory, 'top.png'), imageBytes); writeFileSync(join(directory, 'child', 'deep', 'nested.png'), imageBytes);
  const root = await api(page, '/library/roots', 'POST', { path: directory });
  await expect.poll(async () => (await items(page)).filter(a => a.status === 'ready').length, { timeout: 20000 }).toBe(2);
  const original = await items(page), nested = original.find(a => a.name === 'nested.png'), top = original.find(a => a.name === 'top.png');
  await api(page, `/library/roots/${root.id}/library?revision=${root.revision}`, 'DELETE');
  await page.getByRole('button', { name: '管理监控文件夹' }).click();
  const options = page.getByRole('group', { name: '新文件夹监控选项', exact: true });
  await options.getByRole('checkbox', { name: '包含子文件夹', exact: true }).uncheck();
  await page.getByRole('textbox', { name: 'Windows 后端文件夹路径' }).fill(directory); await page.getByRole('button', { name: '添加目录', exact: true }).click();
  await expect(page.getByText(directory, { exact: true })).toBeVisible();
  await expect.poll(async () => (await api(page, `/assets/${top.id}`)).status, { timeout: 20000 }).toBe('ready');
  expect((await api(page, '/library/roots'))[0].includeSubdirectories).toBe(false);
  expect((await api(page, `/assets/${nested.id}`)).status).toBe('removed');
  expect((await items(page)).map(a => a.id)).toEqual([top.id]);
  expect((await page.request.get(`/api/v1/media/${nested.id}/source`)).status()).toBe(410);
  writeFileSync(join(directory, 'child', 'deep', 'new-nested.png'), imageBytes); writeFileSync(join(directory, 'new-top.png'), imageBytes);
  await expect.poll(async () => (await api(page, '/assets?q=new-top')).items.length, { timeout: 15000 }).toBe(1);
  const stamp = (await api(page, '/library/roots'))[0].lastScanAt; await api(page, `/library/roots/${root.id}/scan`, 'POST'); await scanned(page, root.id, stamp);
  expect((await api(page, '/assets?q=nested')).items).toHaveLength(0);
  await page.reload(); await saved(page);
  expect((await api(page, '/library/roots'))[0].includeSubdirectories).toBe(false); expect((await api(page, '/assets?q=nested')).items).toHaveLength(0);
  const current = (await api(page, '/library/roots'))[0]; await api(page, `/library/roots/${root.id}/library?revision=${current.revision}`, 'DELETE');
  await api(page, '/library/roots', 'POST', { path: directory, includeSubdirectories: true, newFilesOnly: true });
  await scanned(page, root.id, stamp); expect(await items(page)).toHaveLength(0);
  expect((await api(page, `/assets/${top.id}`)).status).toBe('removed'); expect((await api(page, `/assets/${nested.id}`)).status).toBe('removed');
  writeFileSync(join(directory, 'fresh-after-baseline.png'), imageBytes);
  await expect.poll(async () => (await api(page, '/assets?q=fresh-after-baseline')).items.length, { timeout: 15000 }).toBe(1);
  expect(readFileSync(join(directory, 'child', 'deep', 'nested.png'))).toEqual(imageBytes);
});
