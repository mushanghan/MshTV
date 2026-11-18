import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, statSync, writeFileSync, unlinkSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

async function api(page: Page, path: string, body?: object) {
  return page.evaluate(async ({ path, body }) => {
    const session = body ? await (await fetch('/api/v1/session', { method: 'POST', headers: { 'X-MshTV-Bootstrap': '1' } })).json() : null;
    const response = await fetch('/api/v1' + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session?.csrf ?? '' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json().catch(() => null) };
  }, { path, body });
}

function generate(path: string, args: string[]) {
  const result = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', ...args, path], { windowsHide: true });
  expect(result.status, result.stderr.toString()).toBe(0);
}

test('exports selected items and groups and the saved board to separate Windows folders', async ({ page }) => {
  test.setTimeout(90000);
  const data = resolve('../..', '.data'); mkdirSync(data, { recursive: true });
  const fixture = mkdtempSync(join(data, 'export-ui-'));
  const source = join(fixture, 'source'), target = join(fixture, 'target');
  mkdirSync(join(source, 'a'), { recursive: true }); mkdirSync(join(source, 'b')); mkdirSync(target);
  const first = join(source, 'a', '图像.png'), second = join(source, 'b', '图像.png');
  const video = join(source, 'film.mp4'), audio = join(source, 'sound.wav'), missing = join(source, 'missing.png');
  generate(first, ['-f', 'lavfi', '-i', 'color=red:s=32x32', '-frames:v', '1', '-threads', '1']);
  generate(second, ['-f', 'lavfi', '-i', 'color=blue:s=32x32', '-frames:v', '1', '-threads', '1']);
  generate(video, ['-f', 'lavfi', '-i', 'color=green:s=64x64:r=10', '-t', '1', '-c:v', 'libx264', '-threads', '1']);
  generate(audio, ['-f', 'lavfi', '-i', 'sine=duration=1']);
  writeFileSync(missing, readFileSync(first));

  await page.goto('/?board=main');
  const saved = page.getByText('已保存到本机', { exact: true });
  await expect(saved).toBeVisible();
  const { data: root, status } = await api(page, '/library/roots', { path: source, includeSubdirectories: true });
  expect(status).toBe(200);
  const assets = async () => (await api(page, `/assets?rootId=${root.id}`)).data.items as any[];
  await expect.poll(async () => (await assets()).filter(asset => asset.status === 'ready').length, { timeout: 25000 }).toBe(5);
  const rows = await assets();
  const a = rows.find(asset => asset.folder === 'a'), b = rows.find(asset => asset.folder === 'b');
  const v = rows.find(asset => asset.kind === 'video'), s = rows.find(asset => asset.kind === 'audio'), m = rows.find(asset => asset.name === 'missing.png');
  const groupA = { id: crypto.randomUUID(), name: '镜头 / A', x: 20, y: 20, width: 280, height: 255 };
  const groupB = { ...groupA, id: crypto.randomUUID(), name: '镜头 \\ A', x: 360 };
  const item = (asset: any, x: number, y: number, groupId: string | null) => ({
    id: crypto.randomUUID(), type: asset.kind, assetId: asset.id, title: '自定义卡片名称', text: '', x, y, groupId, width: 110, height: 90,
  });
  const cards = [item(a, 40, 65, groupA.id), item(a, 40, 165, groupA.id), item(b, 166, 65, groupA.id),
    item(a, 380, 65, groupB.id), item(v, 510, 65, groupB.id), item(s, 40, 320, null), item(m, 510, 165, groupB.id)];
  const board = (await api(page, '/boards/main')).data;
  const { status: mutation } = await api(page, '/boards/main/mutations', {
    baseRevision: board.revision, clientId: crypto.randomUUID(), mutationId: crypto.randomUUID(),
    operations: [...[groupA, groupB].map(group => ({ kind: 'putGroup', group })),
      ...cards.map(item => ({ kind: 'putItem', item }))],
  });
  expect(mutation).toBe(200);
  await page.reload(); await expect(saved).toBeVisible();
  const host = (await page.locator('[data-canvas-host]').boundingBox())!;
  const click = (x: number, y: number) => page.mouse.click(host.x + 100 + x, host.y + 100 + y);
  const selected = page.getByRole('button', { name: '导出选中内容', exact: true });
  const all = page.getByRole('button', { name: '导出整个画布', exact: true });
  const dialog = page.getByRole('dialog', { name: '导出原始素材' });
  const setup = async (name: string) => {
    await dialog.getByLabel('Windows 导出目标目录').fill(target);
    await dialog.getByLabel('导出文件夹名称').fill(name);
  };
  const start = () => dialog.getByRole('button', { name: '开始导出', exact: true }).click();
  const done = async (success: number, failure = 0) => {
    await expect(dialog.getByRole('status')).toContainText(`成功 ${success} · 失败 ${failure} · 未完成 0`);
    await expect(dialog.getByRole('status')).toContainText('导出完成');
  };
  const again = async () => {
    await dialog.getByRole('button', { name: '再次导出' }).click();
    await dialog.getByRole('button', { name: '关闭导出窗口' }).click();
  };
  await click(groupA.x + 18, groupA.y + 15);
  await page.getByRole('button', { name: '选中组内元素' }).click();
  await expect(page.getByTestId('item-count')).toContainText('已选 3 项');
  await click(groupA.x + 18, groupA.y + 15);
  await selected.click();
  await expect(dialog.getByLabel('导出范围').locator('option:checked')).toHaveText('选中内容 · 2 个文件');
  const picker = dialog.getByRole('button', { name: '选择文件夹', exact: true });
  const parent = dialog.getByLabel('Windows 导出目标目录');
  const route = '**/api/v1/exports/pick-folder';
  await page.route(route, async request => {
    expect(request.request().postDataJSON()).toEqual({ initialDirectory: '' });
    await request.fulfill({ json: { path: target } });
  }, { times: 1 });
  await parent.fill('');
  await picker.click();
  await expect(parent).toHaveValue(target);
  await page.route(route, async request => {
    expect(request.request().postDataJSON()).toEqual({ initialDirectory: target });
    await request.fulfill({ json: { path: null } });
  }, { times: 1 });
  await picker.click();
  await expect(picker).toBeEnabled();
  await expect(parent).toHaveValue(target);
  await dialog.getByLabel('导出文件夹名称').fill('单组');
  await start(); await done(2);
  expect(readFileSync(join(target, '单组', '镜头 _ A', '图像.png'))).toEqual(readFileSync(first));
  expect(readFileSync(join(target, '单组', '镜头 _ A', '图像 (2).png'))).toEqual(readFileSync(second));
  await again();

  await click(groupA.x + 18, groupA.y + 15);
  await page.keyboard.down('Control');
  await click(groupB.x + 18, groupB.y + 15);
  await page.keyboard.up('Control');
  await expect(page.getByText('已选 2 个分组', { exact: true })).toBeVisible();
  await selected.click(); await setup('多组'); await start(); await done(5);
  expect(readFileSync(join(target, '多组', '镜头 _ A (2)', 'film.mp4'))).toEqual(readFileSync(video));
  expect(readFileSync(join(target, '多组', '镜头 _ A (2)', '图像.png'))).toEqual(readFileSync(first));
  await again();

  await click(cards[2].x + 15, cards[2].y + 15);
  await page.keyboard.down('Control'); await click(cards[3].x + 15, cards[3].y + 15); await page.keyboard.up('Control');
  await selected.click();
  await expect(dialog.getByLabel('导出范围').locator('option:checked')).toHaveText('选中内容 · 2 个文件');
  await setup('部分'); await start(); await done(2);
  expect(readdirSync(join(target, '部分', '镜头 _ A'))).toEqual(['图像.png']);
  expect(readFileSync(join(target, '部分', '镜头 _ A', '图像.png'))).toEqual(readFileSync(second));
  await again();

  unlinkSync(missing);
  await all.click();
  await setup('多组'); await start(); await done(5, 1);
  const output = join(target, '多组 (2)');
  await expect(dialog.getByText(output, { exact: false })).toBeVisible();
  await expect(dialog.getByText(/missing.png.*原文件缺失/)).toBeVisible();
  expect(readFileSync(join(output, '未分组素材', 'sound.wav'))).toEqual(readFileSync(audio));
  expect(readFileSync(join(output, '导出报告.txt'), 'utf8')).toContain('成功 5 · 失败 1');
  expect(readFileSync(join(target, '多组', '镜头 _ A (2)', 'missing.png'))).toEqual(readFileSync(first));
  expect((await api(page, '/boards/main')).data.revision).toBe(board.revision + 1);
  const opened = page.waitForResponse(response => response.url().endsWith('/open') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: '在 Windows 中打开文件夹' }).click();
  expect((await opened).status()).toBe(200);
  await page.reload(); await expect(saved).toBeVisible();
  await all.click();
  await expect(dialog.getByLabel('Windows 导出目标目录')).toHaveValue(target);
  const outside = join(fixture, 'junction'); symlinkSync(target, outside, 'junction');
  const invalid = { revision: board.revision + 1, scope: 'board', name: '拒绝测试' };
  for (const parent of [outside, source, target + '\\..', target + ':ads', 'C:relative']) {
    expect((await api(page, '/exports', { ...invalid, parent })).status).toBe(400);
  }
  expect((await api(page, '/exports', { ...invalid, parent: target, name: '..' })).status).toBe(400);
  expect((await api(page, '/exports', { ...invalid, revision: board.revision, parent: target })).status).toBe(409);
});

test('streams a large original with live progress while the canvas remains editable, then cancels safely', async ({ page, browser }) => {
  test.setTimeout(90000);
  const fixture = mkdtempSync(join(resolve('../..', '.data'), 'export-stream-'));
  const source = join(fixture, 'source'), target = join(fixture, 'target');
  mkdirSync(source); mkdirSync(target);
  const first = join(source, 'first.png'), large = join(source, 'large.mp4');
  generate(first, ['-f', 'lavfi', '-i', 'color=red:s=32x32', '-frames:v', '1', '-threads', '1']);
  generate(large, ['-f', 'lavfi', '-i', 'color=green:s=64x64:r=10', '-t', '1', '-c:v', 'libx264', '-threads', '1', '-movflags', '+faststart']);
  const sourceBytes = 6 * 1024 ** 3;
  const handle = openSync(large, 'r+');
  try { ftruncateSync(handle, sourceBytes); } finally { closeSync(handle); }
  const original = statSync(large);
  await page.goto('/?board=main');
  const saved = page.getByText('已保存到本机', { exact: true });
  await expect(saved).toBeVisible();
  const { data: root } = await api(page, '/library/roots', { path: source });
  const assets = async () => (await api(page, `/assets?rootId=${root.id}`)).data.items as any[];
  await expect.poll(async () => (await assets()).filter(asset => asset.status === 'ready').length, { timeout: 25000 }).toBe(2);
  const rows = (await assets()).sort((a, b) => a.size - b.size);
  const board = (await api(page, '/boards/main')).data;
  const itemIds = rows.map(() => crypto.randomUUID());
  expect((await api(page, '/boards/main/mutations', {
    baseRevision: board.revision, clientId: crypto.randomUUID(), mutationId: crypto.randomUUID(),
    operations: rows.map((asset, index) => ({ kind: 'putItem', item: {
      id: itemIds[index], type: asset.kind, assetId: asset.id, title: asset.name, text: '',
      x: 20 + index * 130, y: 30, width: 120, height: 90, groupId: null,
    } })),
  })).status).toBe(200);
  await page.reload(); await expect(saved).toBeVisible();

  const base = 'http://127.0.0.1:5193';
  const other = await browser.newContext();
  let jobPath: string | undefined;
  try {
    const anonymous = await other.request.get(base + '/api/v1/exports/00000000-0000-0000-0000-000000000001');
    expect(anonymous.status()).toBe(401);
    const session = await other.request.post(base + '/api/v1/session', { headers: { Origin: base, 'X-MshTV-Bootstrap': '1' } });
    expect(session.ok()).toBe(true);

    const requestBody = { revision: board.revision + 1, scope: 'selection', itemIds, parent: target, name: '大文件' };
    const missingCsrf = await page.request.post(base + '/api/v1/exports', { headers: { Origin: base }, data: requestBody });
    expect(missingCsrf.status()).toBe(403);
    const { status, data: job } = await api(page, '/exports', requestBody);
    expect(status).toBe(202);
    jobPath = `/exports/${job.id}`;
    expect((await other.request.get(base + '/api/v1' + jobPath)).status()).toBe(404);
    await expect.poll(async () => {
      const { data: progress } = await api(page, jobPath!);
      return progress.current === 'large.mp4' && progress.status === 'running' && progress.copiedBytes > 0;
    }, { intervals: [30, 60, 100], timeout: 6000 }).toBe(true);

    await page.getByRole('button', { name: '添加文字备注', exact: true }).click();
    await expect(page.getByTestId('item-count')).toContainText(`${board.document.items.length + 3} 个元素`);
    expect((await api(page, jobPath + '/cancel', {})).status).toBe(200);
    await expect.poll(async () => (await api(page, jobPath!)).data.status).toBe('cancelled');
    const finished = (await api(page, jobPath)).data;
    expect(finished).toMatchObject({ total: 2, succeeded: 1, failed: 0 });
    const folder = join(target, '大文件', '未分组素材');
    expect(readdirSync(folder)).toEqual(['first.png']);
    expect(readFileSync(join(folder, 'first.png'))).toEqual(readFileSync(first));
    expect(statSync(large).size).toBe(original.size);
    expect(statSync(large).mtimeMs).toBe(original.mtimeMs);
    expect(readFileSync(join(target, '大文件', '导出报告.txt'), 'utf8')).toContain('已取消');
    await expect.poll(async () => (await api(page, '/boards/main')).data.revision).toBe(board.revision + 2);
  } finally {
    await other.close();
    if (jobPath) {
      await api(page, jobPath + '/cancel', {});
      await expect.poll(async () => (await api(page, jobPath!)).data?.status).not.toMatch(/running|queued/);
    }
    unlinkSync(large);
  }
});
