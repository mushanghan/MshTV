import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, renameSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';

async function api(page: Page, path: string, body?: object) {
  return page.evaluate(async ({ path, body }) => {
    let headers: Record<string, string> = {};
    if (body) {
      const session = await (await fetch('/api/v1/session', { method: 'POST', headers: { 'X-MshTV-Bootstrap': '1' } })).json();
      headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf };
    }
    const response = await fetch('/api/v1' + path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(result));
    return result;
  }, { path, body });
}

async function dropFiles(page: Page, paths: string[], x: number, y: number) {
  const session = await page.context().newCDPSession(page);
  const data = { items: [], files: paths, dragOperationsMask: 1 };
  try {
    for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
      await session.send('Input.dispatchDragEvent', { type, x, y, data });
    }
  } finally { await session.detach(); }
}

test('image cards fit portrait, landscape and square previews and preserve the ratio through resize and reload', async ({ page }) => {
  const fixture = mkdtempSync(resolve('../..', '.data/image-aspect-'));
  for (const [name, size] of [['portrait', '360x640'], ['panorama', '960x240'], ['square', '512x512']]) {
    const result = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=' + size, '-frames:v', '1', '-threads', '1', join(fixture, name + '.png')], { windowsHide: true });
    expect(result.status, result.stderr?.toString()).toBe(0);
  }
  const saved = () => expect(page.getByText('已保存到本机', { exact: true })).toBeVisible();
  await page.goto('/?board=main'); await saved();
  const board = await api(page, '/workspace/boards', { name: '图片比例回归' });
  const boardPath = '/boards/' + board.id, scope = '?boardId=' + board.id;
  await page.goto('/?board=' + board.id); await saved();
  await api(page, '/library/roots' + scope, { path: fixture });
  await expect.poll(async () => (await api(page, '/assets' + scope)).items.filter((a: any) => a.status === 'ready' && a.hasThumbnail).length, { timeout: 15000 }).toBe(3);
  const host = page.locator('[data-canvas-host]'), rect = (await host.boundingBox())!;
  const getRatio = (id: string) => page.evaluate(id => {
    const card = (window as any).Konva.stages[0].findOne('#' + id);
    const image = card?.findOne('Image');
    if (!image) return 0;
    return (card.width() - 14) / (card.height() - 47);
  }, id);
  const ratios = [9 / 16, 4, 1];
  for (const [i, name] of ['portrait', 'panorama', 'square'].entries()) {
    await page.getByText(name + '.png', { exact: true }).dragTo(host, { targetPosition: { x: i === 0 ? 72 : 385, y: i === 2 ? 251 : 91 } });
    await saved();
    const item = (await api(page, boardPath)).document.items[i];
    expect((item.width - 14) / (item.height - 47)).toBeCloseTo(ratios[i], 5);
    await expect.poll(() => getRatio(item.id)).toBeCloseTo(ratios[i], 5);
  }
  const portrait = (await api(page, boardPath)).document.items[0];
  await page.mouse.click(rect.x + 112, rect.y + 138);
  const anchor = await page.evaluate(id => (window as any).Konva.stages[0].find('Transformer').find((node: any) =>
    node.nodes().some((card: any) => card.id() === id)).findOne('.bottom-right').getAbsolutePosition(), portrait.id);
  await page.mouse.move(rect.x + anchor.x, rect.y + anchor.y);
  await page.mouse.down(); await page.mouse.move(rect.x + anchor.x + 42, rect.y + anchor.y + 78, { steps: 8 }); await page.mouse.up();
  await saved();
  const resized = await api(page, boardPath);
  expect(resized.document.items[0].width).toBeGreaterThan(portrait.width + 20);
  expect((resized.document.items[0].width - 14) / (resized.document.items[0].height - 47)).toBeCloseTo(ratios[0], 5);
  await page.reload(); await saved();
  await expect.poll(() => getRatio(portrait.id)).toBeCloseTo(ratios[0], 5);
  expect((await api(page, boardPath)).document).toEqual(resized.document);

  await api(page, boardPath + '/mutations', { baseRevision: resized.revision, clientId: crypto.randomUUID(), mutationId: crypto.randomUUID(),
    operations: [{ kind: 'putItem', item: { ...portrait, width: 320, height: 220 } }] });
  const legacy = await api(page, boardPath);
  await page.reload(); await saved();
  await expect.poll(() => getRatio(portrait.id)).toBeCloseTo(ratios[0], 5);
  expect(await api(page, boardPath)).toEqual(legacy);
});

test('large RGBA images render and visible cards use sharper previews without upscaling smaller originals', async ({ page }) => {
  test.setTimeout(90000);
  const data = resolve('../..', '.data'); mkdirSync(data, { recursive: true });
  const fixture = mkdtempSync(join(data, 'image-drop-'));
  const large = join(fixture, 'large-rgba.png'), small = join(fixture, 'small.png');
  for (const [path, filter] of [[large, 'color=orange:s=7680x5120,format=rgba'], [small, 'testsrc2=s=720x480']]) {
    const generated = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', filter, '-frames:v', '1', '-threads', '1', path], { windowsHide: true });
    expect(generated.status, generated.stderr.toString()).toBe(0);
  }
  await page.goto('/?board=main'); await expect(page.getByText('已保存到本机', { exact: true })).toBeVisible();
  const before = (await api(page, '/boards/main')).document.items.length;
  const host = (await page.locator('[data-canvas-host]').boundingBox())!;
  await dropFiles(page, [large, small], host.x + 90, host.y + 100);
  await expect.poll(async () => (await api(page, '/boards/main')).document.items.length).toBe(before + 2);
  const cards = (await api(page, '/boards/main')).document.items.slice(-2);
  const drawnWidth = (id: string) => page.evaluate(id => {
    const image = (window as any).Konva.stages[0].find('Image').find((node: any) => node.getParent()?.id() === id);
    return image?.image()?.naturalWidth;
  }, id);
  for (const [index, expectedWidth] of [2048, 720].entries()) {
    const card = cards[index];
    await expect.poll(async () => {
      const asset = await api(page, `/assets/${card.assetId}`);
      return asset.hasThumbnail && asset.hasPreview;
    }, { timeout: 30000 }).toBe(true);
    await expect.poll(() => drawnWidth(card.id), { timeout: 15000 }).toBe(expectedWidth);
  }
  await page.mouse.move(host.x + 90, host.y + 100);
  await page.mouse.wheel(0, 120);
  for (const card of cards) await expect.poll(() => drawnWidth(card.id)).toBe(256);
});

test('a high-resolution JPEG that is detected as image2 still produces a usable preview', async ({ page }) => {
  const data = resolve('../..', '.data'); mkdirSync(data, { recursive: true });
  const fixture = mkdtempSync(join(data, 'jpeg-drop-'));
  const file = join(fixture, 'large-camera.jpg');
  const generated = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=6754x4490', '-frames:v', '1', '-threads', '1', file], { windowsHide: true });
  expect(generated.status, generated.stderr.toString()).toBe(0);

  await page.goto('/?board=main'); await expect(page.getByText('已保存到本机', { exact: true })).toBeVisible();
  const before = (await api(page, '/boards/main')).document.items.length;
  const host = (await page.locator('[data-canvas-host]').boundingBox())!;
  await dropFiles(page, [file], host.x + 170, host.y + 130);
  await expect.poll(async () => (await api(page, '/boards/main')).document.items.length).toBe(before + 1);
  const card = (await api(page, '/boards/main')).document.items.at(-1);
  await expect.poll(() => api(page, `/assets/${card.assetId}`), { timeout: 20000 }).toMatchObject({
    width: 6754, height: 4490, hasThumbnail: true, hasPreview: true, error: null,
  });
  await page.mouse.dblclick(host.x + 240, host.y + 175);
  const preview = page.getByRole('img', { name: 'large-camera.jpg', exact: true }).filter({ visible: true });
  await expect(preview).toHaveAttribute('src', /\/preview\?v=/);
  await expect.poll(() => preview.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(2048);
});

test('a drop from an unregistered folder creates a usable asset and an interrupted transfer creates none', async ({ page }, testInfo) => {
  test.setTimeout(90000);
  const data = resolve('../..', '.data'); mkdirSync(data, { recursive: true });
  const fixture = mkdtempSync(join(data, 'fresh-drop-'));
  const file = join(fixture, 'unregistered sound.wav');
  expect(spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=550', '-t', '1', file], { windowsHide: true }).status).toBe(0);
  const original = readFileSync(file);
  await page.goto('/?board=main'); await expect(page.getByText('已保存到本机', { exact: true })).toBeVisible();
  const watchedBefore = (await api(page, '/library/roots')).map((row: any) => row.id);
  const before = (await api(page, '/boards/main')).document.items.length;
  const host = (await page.locator('[data-canvas-host]').boundingBox())!;
  await dropFiles(page, [file], host.x + 340, host.y + 290);
  await expect.poll(async () => (await api(page, '/boards/main')).document.items.length).toBe(before + 1);
  const card = (await api(page, '/boards/main')).document.items.at(-1);
  expect(card).toMatchObject({ title: 'unregistered sound.wav', x: 240, y: 190 });
  expect((await api(page, '/library/roots')).map((row: any) => row.id)).toEqual(watchedBefore);
  const root = (await api(page, '/library/roots?includeImports=true')).find((row: any) => row.managed);
  expect((await api(page, `/assets/${card.assetId}`)).rootId).toBe(root.id);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const imports = page.getByRole('button', { name: '拖入导入', exact: true });
  const assetRow = page.getByTestId(`asset-${card.assetId}`);
  await expect(imports).toHaveCSS('border-top-color', 'rgb(170, 178, 189)');
  await expect(assetRow).toHaveCSS('border-top-color', 'rgb(170, 178, 189)');
  await expect(assetRow.locator('.asset-thumbnail')).toHaveCSS('border-top-style', 'solid');
  await imports.hover();
  await expect(imports).toHaveCSS('box-shadow', /0px 6px 9px -5px/);
  expect(await imports.evaluate(button => button.closest('nav')!.getBoundingClientRect().bottom - button.getBoundingClientRect().bottom)).toBeGreaterThanOrEqual(8);
  await page.locator('.library-panel').screenshot({ path: testInfo.outputPath('light-library-import-hover.png') });
  await imports.click();
  await expect(imports).toHaveAttribute('aria-pressed', 'true');
  await expect(assetRow).toBeVisible();
  await expect.poll(async () => (await api(page, `/assets/${card.assetId}`)).status, { timeout: 20000 }).toBe('ready');
  expect(await (await page.request.get(`/api/v1/media/${card.assetId}/source`)).body()).toEqual(original);
  expect(readFileSync(file)).toEqual(original);

  const csrf = await page.evaluate(async () => {
    const response = await fetch('/api/v1/session', { method: 'POST', headers: { 'X-MshTV-Bootstrap': '1' } });
    return (await response.json()).csrf;
  });
  const cookie = (await page.context().cookies()).map(value => `${value.name}=${value.value}`).join('; ');
  const backend = 'http://127.0.0.1:5198';
  const headers = { Origin: backend, Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/octet-stream' };
  const invalid = await fetch(`${backend}/api/v1/assets/import?name=${encodeURIComponent('../escape.png')}`, { method: 'POST', headers, body: original });
  expect(invalid.status).toBe(400);
  const unauthenticated = await fetch(`${backend}/api/v1/assets/import?name=unauthenticated.wav`, {
    method: 'POST', headers: { Origin: backend, 'Content-Type': 'application/octet-stream' }, body: original,
  });
  expect(unauthenticated.status).toBe(401);
  const interrupted = httpRequest(`${backend}/api/v1/assets/import?name=interrupted.wav`, {
    method: 'POST', headers: { ...headers, 'Content-Length': 4 * 1024 * 1024 },
  });
  interrupted.on('error', () => {});
  const staged = () => readdirSync(root.path).some(name => name.startsWith('.part-'));
  try {
    interrupted.write(Buffer.alloc(65536));
    await expect.poll(staged).toBe(true);
  } finally { interrupted.destroy(); }
  await expect.poll(staged).toBe(false);
  expect((await api(page, '/assets?q=interrupted')).items).toHaveLength(0);
});

test('desktop drops reuse verified assets and import outside or ambiguous files in place', async ({ page }) => {
  test.setTimeout(120000);
  const data = resolve('../..', '.data'); mkdirSync(data, { recursive: true });
  const fixture = mkdtempSync(join(data, 'local-drop-'));
  const source = join(fixture, 'source'), duplicate = join(fixture, 'duplicate'), outside = join(fixture, 'outside');
  for (const directory of [source, duplicate, outside]) mkdirSync(directory);
  const picture = join(source, 'take.png'), audio = join(source, 'sound.wav');
  expect(spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=orange:s=120x80', '-frames:v', '1', picture], { windowsHide: true }).status).toBe(0);
  expect(spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1', audio], { windowsHide: true }).status).toBe(0);
  // A difference beyond the first 4 MiB must also prevent a match.
  appendFileSync(picture, Buffer.alloc(4 * 1024 * 1024 + 16));
  const original = readFileSync(picture);
  const changed = Buffer.from(original); changed[changed.length - 1] ^= 1;
  writeFileSync(join(outside, 'take.png'), changed);
  copyFileSync(picture, join(duplicate, 'take.png'));

  await page.goto('/?board=main'); await expect(page.getByText('已保存到本机', { exact: true })).toBeVisible();
  const root = await api(page, '/library/roots', { path: source });
  const list = () => api(page, `/assets?rootId=${root.id}`);
  await expect.poll(async () => (await list()).items.filter((asset: any) => asset.status === 'ready').length, { timeout: 20000 }).toBe(2);
  const assets = (await list()).items;
  const imageId = assets.find((asset: any) => asset.name === 'take.png').id;
  const audioId = assets.find((asset: any) => asset.name === 'sound.wav').id;
  const before = (await api(page, '/boards/main')).document.items.length;
  const host = (await page.locator('[data-canvas-host]').boundingBox())!;
  await page.mouse.move(host.x + 200, host.y + 100);
  await page.mouse.wheel(0, -100);
  await expect(page.getByTitle('重置到 100%')).toHaveText('135%');
  await dropFiles(page, [picture, audio], host.x + 370, host.y + 280);
  const count = async () => (await api(page, '/boards/main')).document.items.length;
  await expect.poll(count).toBe(before + 2);
  const added = (await api(page, '/boards/main')).document.items.slice(-2);
  const scale = Math.exp(.3);
  expect(added.map((item: any) => item.assetId)).toEqual([imageId, audioId]);
  expect(added[0].x).toBeCloseTo((370 - (200 - 100 * scale)) / scale, 0);
  expect(added[0].y).toBeCloseTo(180 / scale, 0);
  expect(added[1].x - added[0].x).toBeCloseTo(336, 5);
  expect((await list()).items).toHaveLength(2);

  await page.keyboard.press('Control+z'); await expect.poll(count).toBe(before);
  await page.keyboard.press('Control+Shift+z'); await expect.poll(count).toBe(before + 2);
  await page.reload(); await expect(page.getByText('已保存到本机', { exact: true })).toBeVisible();
  expect((await api(page, '/boards/main')).document.items.slice(-2)).toEqual(added);
  await expect(page.getByTitle('重置到 100%')).toHaveText('135%');

  await dropFiles(page, [join(outside, 'take.png')], host.x + 370, host.y + 280);
  await expect.poll(count).toBe(before + 3);
  const importedCard = (await api(page, '/boards/main')).document.items.at(-1);
  expect(importedCard.assetId).not.toBe(imageId);
  expect(importedCard.x).toBeCloseTo(added[0].x, 0);
  expect(importedCard.y).toBeCloseTo(added[0].y, 0);
  const importRoot = (await api(page, '/library/roots?includeImports=true')).find((row: any) => row.managed);
  expect((await api(page, '/library/roots')).map((row: any) => row.id)).not.toContain(importRoot.id);
  await expect(page.getByRole('button', { name: '拖入导入', exact: true })).toBeVisible();
  await expect.poll(async () => (await api(page, `/assets/${importedCard.assetId}`)).status, { timeout: 20000 }).toBe('ready');
  const imported = (await api(page, `/assets?rootId=${importRoot.id}`)).items;
  expect(imported.find((row: any) => row.id === importedCard.assetId)?.name).toBe('take.png');

  await dropFiles(page, [join(outside, 'take.png')], host.x + 390, host.y + 300);
  await expect.poll(count).toBe(before + 4);
  expect((await api(page, '/boards/main')).document.items.at(-1).assetId).toBe(importedCard.assetId);
  expect((await api(page, `/assets?rootId=${importRoot.id}`)).items).toHaveLength(imported.length);
  renameSync(join(outside, 'take.png'), join(outside, 'moved-take.png'));
  await page.reload(); await expect(page.getByText('已保存到本机', { exact: true })).toBeVisible();
  const sourceResponse = await page.request.get(`/api/v1/media/${importedCard.assetId}/source`, { headers: { Range: `bytes=${changed.length - 1}-` } });
  expect(sourceResponse.status()).toBe(206);
  expect(await sourceResponse.body()).toEqual(changed.subarray(-1));
  expect((await api(page, '/boards/main')).document.items.some((item: any) => item.id === importedCard.id)).toBe(true);

  const other = await api(page, '/library/roots', { path: duplicate });
  await expect.poll(async () => (await api(page, `/assets?rootId=${other.id}`)).items[0]?.status, { timeout: 20000 }).toBe('ready');
  await dropFiles(page, [picture], host.x + 370, host.y + 280);
  await expect.poll(count).toBe(before + 5);
  const ambiguous = (await api(page, '/boards/main')).document.items.at(-1);
  expect((await api(page, `/assets/${ambiguous.assetId}`)).rootId).toBe(importRoot.id);
  expect(ambiguous.assetId).not.toBe(importedCard.assetId);
  expect((await api(page, `/assets?rootId=${importRoot.id}`)).items).toHaveLength(imported.length + 1);
  expect(readdirSync(importRoot.path).some(file => file.startsWith('.part-'))).toBe(false);

  await dropFiles(page, [audio], 60, 25);
  await expect.poll(count).toBe(before + 6);
  const last = (await api(page, '/boards/main')).document.items.at(-1);
  expect(last.assetId).toBe(audioId);
  expect(last.x).toBeCloseTo((host.width / 2 - (200 - 100 * scale)) / scale, 0);
  expect(last.y).toBeCloseTo((host.height / 2 - 100) / scale, 0);
  expect(readFileSync(picture)).toEqual(original);
});
