import { test, expect, type Page } from '@playwright/test';
async function snapshot(page: Page) { return page.evaluate(async () => (await fetch('/api/v1/boards/main')).json()); }
async function saved(page: Page) { await expect(page.getByText('已保存到本机', { exact: true })).toBeVisible(); }
test.beforeEach(async ({ page }) => {
  await page.goto('/?board=main'); await saved(page);
  // Every test uses the fresh test-only server, then clears the previous test's document through real UI.
  await page.keyboard.press('Control+a'); await page.keyboard.press('Delete'); await saved(page);
  // Boards remain after their last member leaves; clear them explicitly in this isolated test database.
  const cleared = await page.evaluate(async () => {
    const board = await (await fetch('/api/v1/boards/main')).json();
    if (!board.document.groups.length) return false;
    const session = await (await fetch('/api/v1/session', { method: 'POST', headers: { 'X-MshTV-Bootstrap': '1' } })).json();
    const response = await fetch('/api/v1/boards/main/mutations', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf }, body: JSON.stringify({ baseRevision: board.revision, clientId: crypto.randomUUID(), mutationId: crypto.randomUUID(), operations: board.document.groups.map((g: any) => ({ kind: 'deleteGroup', id: g.id })) }) });
    if (!response.ok) throw new Error('Could not reset test board'); return true;
  });
  if (cleared) { await page.reload(); await saved(page); }
});
test('add, drag, proportional resize, undo/redo, reload', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.getByRole('button', { name: '添加示例图片', exact: true }).click(); await saved(page);
  const first = (await snapshot(page)).document.items[0];
  const host = (await page.locator('[data-canvas-host]').boundingBox())!;
  const x = host.x + first.x + 100 + first.width / 2, y = host.y + first.y + 100 + first.height / 2;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 96, y + 63, { steps: 12 }); await page.mouse.up(); await saved(page);
  const moved = (await snapshot(page)).document.items[0]; expect(moved.x - first.x).toBeCloseTo(96, 0); expect(moved.y - first.y).toBeCloseTo(63, 0);
  // Bottom right Konva transformer corner.
  await page.mouse.move(host.x + moved.x + 100 + moved.width, host.y + moved.y + 100 + moved.height);
  await page.mouse.down(); await page.mouse.move(host.x + moved.x + 100 + moved.width + 80, host.y + moved.y + 100 + moved.height + 55, { steps: 10 }); await page.mouse.up(); await saved(page);
  const resized = (await snapshot(page)).document.items[0]; expect(resized.width).toBeGreaterThan(moved.width + 30); expect((resized.width - 14) / (resized.height - 47)).toBeCloseTo(16 / 9, 5);
  await page.getByRole('button', { name: '撤销', exact: true }).click(); await saved(page); expect((await snapshot(page)).document.items[0].width).toBeCloseTo(first.width, 0);
  await page.getByRole('button', { name: '重做', exact: true }).click(); await saved(page);
  await page.reload(); await saved(page); expect((await snapshot(page)).document.items[0].width).toBeCloseTo(resized.width, 0);
  await page.screenshot({ path: 'test-results/canvas.png', fullPage: true }); expect(errors).toEqual([]);
});
test('notes, multiselect, group move, ungroup and deletion', async ({ page }) => {
  await page.getByRole('button', { name: '添加文字备注', exact: true }).click(); await saved(page);
  let board = await snapshot(page); const note = board.document.items[0]; const h = (await page.locator('[data-canvas-host]').boundingBox())!;
  await page.mouse.dblclick(h.x + 100 + note.x + 35, h.y + 100 + note.y + 35);
  await expect(page.getByRole('textbox', { name: '备注内容' })).toBeFocused();
  await page.getByRole('textbox', { name: '备注内容' }).fill('镜头 01\n先记录构图，再整理素材。');
  await page.getByRole('textbox', { name: '备注内容' }).press('Control+Enter'); await saved(page);
  expect((await snapshot(page)).document.items[0].text).toContain('镜头 01');
  await page.getByRole('button', { name: '视频占位卡片' }).click(); await saved(page);
  await page.keyboard.press('Control+a'); await page.getByRole('button', { name: '分组', exact: true }).click(); await saved(page);
  board = await snapshot(page); expect(board.document.groups).toHaveLength(1); expect(board.document.items.every((i: any) => i.groupId)).toBe(true);
  const item = board.document.items[1]; const x = h.x + 100 + item.x + 130, y = h.y + 100 + item.y + 80;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 75, y - 25, { steps: 10 }); await page.mouse.up(); await saved(page);
  const moved = await snapshot(page);
  expect(moved.document.items[0]).toEqual(board.document.items[0]);
  expect(moved.document.items[1].x - board.document.items[1].x).toBeCloseTo(75, 0);
  expect(moved.document.groups).toEqual(board.document.groups);
  await page.getByRole('button', { name: '解组', exact: true }).click(); await saved(page); expect((await snapshot(page)).document.groups).toHaveLength(0);
  await page.keyboard.press('Control+a'); await page.keyboard.press('Delete'); await saved(page); expect((await snapshot(page)).document.items).toHaveLength(0);
  await page.keyboard.press('Control+z'); await saved(page); expect((await snapshot(page)).document.items).toHaveLength(2);
});
test('wheel, hand panning, box select, fit all and reset', async ({ page }) => {
  await page.getByRole('button', { name: '添加示例图片', exact: true }).click(); await saved(page);
  const h = (await page.locator('[data-canvas-host]').boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2); await page.mouse.wheel(0, -100);
  await expect(page.getByTitle('重置到 100%')).not.toHaveText('100%');
  await page.getByTitle('重置到 100%').click(); await expect(page.getByTitle('重置到 100%')).toHaveText('100%');
  await page.getByRole('button', { name: '适应全部', exact: true }).click();
  const beforeMiddlePan = await snapshot(page);
  const middleX = h.x + h.width / 2, middleY = h.y + h.height / 2;
  await page.mouse.move(middleX, middleY);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(middleX + 80, middleY + 65, { steps: 8 });
  await page.mouse.up({ button: 'middle' });
  await saved(page);
  expect(await snapshot(page)).toEqual(beforeMiddlePan);
  await page.getByRole('button', { name: '适应全部' }).click();
  await page.keyboard.press('Escape'); await page.mouse.move(h.x + 5, h.y + 45); await page.mouse.down(); await page.mouse.move(h.x + h.width - 8, h.y + h.height - 55, { steps: 10 }); await page.mouse.up();
  await expect(page.getByTestId('item-count')).toContainText('已选 1 项');
  const before = await snapshot(page); await page.keyboard.down('Space'); await page.mouse.move(h.x + 80, h.y + 90); await page.mouse.down(); await page.mouse.move(h.x + 190, h.y + 170, { steps: 10 }); await page.mouse.up(); await page.keyboard.up('Space');
  expect(await snapshot(page)).toEqual(before);
});
test('Mac scroll pans and both pinch event styles zoom the canvas around its pointer', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 0 });
  });
  await page.reload(); await saved(page);
  await page.getByRole('button', { name: '添加示例图片', exact: true }).click(); await saved(page);
  const board = await snapshot(page);
  const camera = () => page.evaluate(() => {
    const stage = (window as any).Konva.stages[0];
    return { x: stage.x(), y: stage.y(), scale: stage.scaleX() };
  });
  const host = page.locator('[data-canvas-host]');
  const surface = host.locator('.konvajs-content');
  const box = (await host.boundingBox())!;
  const pointer = { x: 180, y: 155 };
  await page.mouse.move(box.x + pointer.x, box.y + pointer.y);
  const start = await camera();
  await page.mouse.wheel(36, -58);
  await expect.poll(camera).toEqual({ x: start.x - 36, y: start.y + 58, scale: start.scale });
  const panned = await camera();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -50);
  await page.keyboard.up('Control');
  await expect.poll(async () => (await camera()).scale).toBeGreaterThan(panned.scale);
  const chromium = await camera();
  const world = (view: typeof start) => ({ x: (pointer.x - view.x) / view.scale, y: (pointer.y - view.y) / view.scale });
  expect(world(chromium).x).toBeCloseTo(world(panned).x, 5);
  expect(world(chromium).y).toBeCloseTo(world(panned).y, 5);

  const prevented = await surface.evaluate(element => {
    const gesture = (type: string, scale: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'scale', { value: scale });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const started = gesture('gesturestart', 1);
    const moved = gesture('gesturechange', 1.2);
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -90, ctrlKey: true, bubbles: true, cancelable: true }));
    gesture('gesturechange', 1.5);
    return [started, moved, gesture('gestureend', 1.5)];
  });
  expect(prevented).toEqual([true, true, true]);
  await expect.poll(async () => (await camera()).scale).toBeCloseTo(chromium.scale * 1.5, 5);
  const safari = await camera();
  expect(world(safari).x).toBeCloseTo(world(chromium).x, 5);
  expect(world(safari).y).toBeCloseTo(world(chromium).y, 5);
  expect(await snapshot(page)).toEqual(board);

  await page.getByRole('button', { name: '快捷键' }).click();
  await page.getByLabel('滚动方式').selectOption('mouse');
  await page.reload(); await saved(page);
  await page.getByRole('button', { name: '快捷键' }).click();
  await expect(page.getByLabel('滚动方式')).toHaveValue('mouse');
  await page.getByRole('button', { name: '关闭快捷键' }).click();
  await page.mouse.move(box.x + pointer.x, box.y + pointer.y);
  await page.mouse.wheel(0, -80);
  await expect(page.getByTitle('重置到 100%')).not.toHaveText('100%');
});
test('conflicting browser writes are rejected and pending local changes retained', async ({ page, browser }) => {
  const context = await browser.newContext(); const other = await context.newPage();
  await other.goto('http://127.0.0.1:5193/?board=main'); await saved(other);
  await page.getByRole('button', { name: '添加示例图片', exact: true }).click(); await saved(page);
  await other.getByRole('button', { name: '添加文字备注', exact: true }).click();
  await expect(other.getByRole('alert')).toContainText('其他页面已修改'); await expect(other.getByTestId('item-count')).toContainText('1 个元素');
  expect((await snapshot(page)).document.items[0].type).toBe('image'); await context.close();
});
test('mutation idempotency, validation and CSRF protection', async ({ page }) => {
  const results = await page.evaluate(async () => {
    const session = await (await fetch('/api/v1/session', { method: 'POST', headers: { 'X-MshTV-Bootstrap': '1' } })).json();
    const board = await (await fetch('/api/v1/boards/main')).json();
    const mutation = { baseRevision: board.revision, clientId: crypto.randomUUID(), mutationId: crypto.randomUUID(), operations: [{ kind: 'putItem', item: { id: crypto.randomUUID(), type: 'note', assetId: null, title: '接口测试', text: 'hello', x: -150, y: 200, width: 320, height: 200, groupId: null } }] };
    const send = (payload: unknown, csrf = session.csrf) => fetch('/api/v1/boards/main/mutations', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(payload) });
    const first = await send(mutation), duplicate = await send(mutation);
    const firstResult = await first.json(), secondResult = await duplicate.json();
    const csrf = await send(mutation, ''), changed = await send({ ...mutation, operations: [] });
    const invalid = await send({ ...mutation, baseRevision: firstResult.revision, mutationId: crypto.randomUUID(), operations: [{ kind: 'putItem', item: { ...mutation.operations[0].item, width: -10 } }] });
    const conflict = await send({ ...mutation, mutationId: crypto.randomUUID() });
    const invalidSpan = await send({ ...mutation, baseRevision: firstResult.revision, mutationId: crypto.randomUUID(), operations: [{ kind: 'putItem', item: { ...mutation.operations[0].item, noteSpans: [{ from: 0, to: 99, red: true }] } }] });
    const overlapSpan = await send({ ...mutation, baseRevision: firstResult.revision, mutationId: crypto.randomUUID(), operations: [{ kind: 'putItem', item: { ...mutation.operations[0].item, noteSpans: [{ from: 0, to: 3, red: true }, { from: 2, to: 5, underline: true }] } }] });
    const splitEmoji = await send({ ...mutation, baseRevision: firstResult.revision, mutationId: crypto.randomUUID(), operations: [{ kind: 'putItem', item: { ...mutation.operations[0].item, text: 'a😀b', noteSpans: [{ from: 2, to: 3, bold: true }] } }] });
    return { first: first.status, second: duplicate.status, firstResult, secondResult, csrf: csrf.status, changed: changed.status, invalid: invalid.status, conflict: conflict.status, invalidSpan: invalidSpan.status, overlapSpan: overlapSpan.status, splitEmoji: splitEmoji.status };
  });
  expect(results.first).toBe(200); expect(results.second).toBe(200); expect(results.firstResult).toEqual(results.secondResult);
  expect(results.csrf).toBe(403); expect(results.changed).toBe(400); expect(results.invalid).toBe(400); expect(results.conflict).toBe(409);
  expect(results.invalidSpan).toBe(400); expect(results.overlapSpan).toBe(400); expect(results.splitEmoji).toBe(400);
});
test('same browser tabs keep valid sessions; offline changes can retry', async ({ page, context }) => {
  const other = await context.newPage(); await other.goto('http://127.0.0.1:5193/?board=main'); await saved(other);
  await page.getByRole('button', { name: '添加示例图片', exact: true }).click(); await saved(page);
  await page.route('**/api/v1/boards/main/mutations', route => route.abort());
  await page.getByRole('button', { name: '添加文字备注', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('保存失败');
  await page.unroute('**/api/v1/boards/main/mutations'); await page.getByRole('button', { name: '重试连接 / 保存' }).click(); await saved(page);
  expect((await snapshot(page)).document.items).toHaveLength(2); await other.close();
});
test('note dimensions resize freely while glyphs stay fixed during and after dragging', async ({ page }) => {
  await page.getByRole('button', { name: '添加文字备注', exact: true }).click(); await saved(page);
  const initial = (await snapshot(page)).document.items[0], initialHost = (await page.locator('[data-canvas-host]').boundingBox())!;
  await page.mouse.dblclick(initialHost.x + 100 + initial.x + 35, initialHost.y + 100 + initial.y + 35);
  await page.getByRole('textbox', { name: '备注内容' }).fill('双击编辑文字\n记录灵感、镜头与想法。');
  await page.getByRole('textbox', { name: '备注内容' }).press('Control+Enter'); await saved(page);
  const note = (await snapshot(page)).document.items[0];
  const host = (await page.locator('[data-canvas-host]').boundingBox())!;
  const left = host.x + 100 + note.x, top = host.y + 100 + note.y;
  const anchorPoint = (anchor: string) => page.evaluate(({ anchor, id }) => {
    const stage = (window as any).Konva.stages[0];
    return stage.find('Transformer').find((node: any) => node.nodes().some((card: any) => card.id() === id))
      .findOne('.' + anchor).getAbsolutePosition();
  }, { anchor, id: note.id });
  await expect.poll(() => page.evaluate(id => (window as any).Konva.stages[0].findOne('#' + id).offsetY(), note.id)).toBe(3);
  // Compare the actual rendered first line, not just its configured fontSize.
  const clip = { x: left + 18, y: top + 18, width: 110, height: 25 };
  const glyphs = await page.screenshot({ clip });
  const glyphSize = async (png: Buffer) => page.evaluate(async base64 => {
    const image = new Image(); image.src = 'data:image/png;base64,' + base64; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    let minX = image.width, maxX = -1, minY = image.height, maxY = -1;
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      const offset = (y * image.width + x) * 4;
      if (pixels[offset] > 180 && pixels[offset + 1] > 180) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    }
    return { width: maxX - minX + 1, height: maxY - minY + 1 };
  }, png.toString('base64'));
  const originalGlyphSize = await glyphSize(glyphs);
  const expectFixedGlyphs = async () => {
    const actual = await glyphSize(await page.screenshot({ clip }));
    expect(originalGlyphSize.height).toBeGreaterThan(8);
    expect(Math.abs(actual.width - originalGlyphSize.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(actual.height - originalGlyphSize.height)).toBeLessThanOrEqual(1);
  };
  const edge = await anchorPoint('middle-right');
  await page.mouse.move(host.x + edge.x, host.y + edge.y);
  await page.mouse.down(); await page.mouse.move(host.x + edge.x + 140, host.y + edge.y, { steps: 12 });
  await expectFixedGlyphs();
  await page.mouse.up(); await saved(page);
  const wider = (await snapshot(page)).document.items[0];
  expect(wider.width - note.width).toBeCloseTo(140, 0); expect(wider.height).toBeCloseTo(note.height, 0);
  await expectFixedGlyphs();
  const corner = await anchorPoint('bottom-right');
  await page.mouse.move(host.x + corner.x, host.y + corner.y);
  await page.mouse.down(); await page.mouse.move(host.x + corner.x + 40, host.y + corner.y + 90, { steps: 12 });
  await expectFixedGlyphs();
  await page.mouse.up(); await saved(page);
  const taller = (await snapshot(page)).document.items[0];
  expect(taller.height - wider.height).toBeCloseTo(90, 0); expect(taller.width - wider.width).toBeCloseTo(40, 0);
  expect(taller.x).toBeCloseTo(note.x, 0); expect(taller.y).toBeCloseTo(note.y, 0);
  expect(taller.width / taller.height).not.toBeCloseTo(note.width / note.height, 1);
  await page.getByRole('button', { name: '撤销', exact: true }).click(); await saved(page);
  expect((await snapshot(page)).document.items[0].height).toBeCloseTo(wider.height, 0);
  await page.getByRole('button', { name: '重做', exact: true }).click(); await saved(page);
  await page.reload(); await saved(page);
  expect((await snapshot(page)).document.items[0]).toEqual(taller);
  await expectFixedGlyphs();
});

test('group board moves members, resizes independently, and accepts cards dropped in and out', async ({ page }) => {
  await page.getByRole('button', { name: '添加示例图片', exact: true }).click(); await saved(page);
  await page.getByRole('button', { name: '视频占位卡片' }).click(); await saved(page);
  await page.keyboard.press('Control+a'); await page.getByRole('button', { name: '分组', exact: true }).click(); await saved(page);
  const host = (await page.locator('[data-canvas-host]').boundingBox())!;
  const screen = (x: number, y: number) => ({ x: host.x + 100 + x, y: host.y + 100 + y });
  const drag = async (x: number, y: number, dx: number, dy: number) => {
    const p = screen(x, y); await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(p.x + dx, p.y + dy, { steps: 12 }); await page.mouse.up(); await saved(page);
  };
  let board = await snapshot(page), group = board.document.groups[0];
  const beforeMove = board;
  await drag(group.x + 18, group.y + 16, 65, 35);
  board = await snapshot(page); group = board.document.groups[0];
  expect(group.x - beforeMove.document.groups[0].x).toBeCloseTo(65, 0);
  for (let i = 0; i < 2; i++) { expect(board.document.items[i].x - beforeMove.document.items[i].x).toBeCloseTo(65, 0); expect(board.document.items[i].y - beforeMove.document.items[i].y).toBeCloseTo(35, 0); }
  const beforeResize = board;
  await drag(group.x + group.width, group.y + group.height, 105, 60);
  board = await snapshot(page); group = board.document.groups[0];
  expect(group.width - beforeResize.document.groups[0].width).toBeCloseTo(105, 0);
  expect(group.height - beforeResize.document.groups[0].height).toBeCloseTo(60, 0);
  expect(board.document.items).toEqual(beforeResize.document.items);
  const video = board.document.items[1];
  await drag(video.x + video.width / 2, video.y + video.height / 2, group.x - 90 - (video.x + video.width / 2), 0);
  const outside = await snapshot(page);
  expect(outside.document.items[1].groupId).toBeNull(); expect(outside.document.items[0]).toEqual(board.document.items[0]);
  expect(outside.document.groups).toEqual(board.document.groups);
  await page.keyboard.press('Control+z'); await saved(page); expect((await snapshot(page)).document.items[1].groupId).toBe(group.id);
  await page.keyboard.press('Control+Shift+z'); await saved(page); expect((await snapshot(page)).document.items[1].groupId).toBeNull();
  const out = (await snapshot(page)).document.items[1];
  await drag(out.x + 25, out.y + 25, group.x + group.width / 2 - (out.x + out.width / 2), 0);
  board = await snapshot(page); expect(board.document.items[1].groupId).toBe(group.id);
  const input = page.getByRole('textbox', { name: '分组名称' });
  const p = screen(group.x + 16, group.y + 16); await page.mouse.click(p.x, p.y);
  await input.fill('镜头参考'); await input.press('Tab'); await saved(page);
  const inlineName = page.getByRole('textbox', { name: '画布分组名称' });
  const clickTitle = async (doubleClick: boolean) => {
    const title = await page.evaluate(() => (window as any).Konva.stages[0].findOne('.group-label')
      .getAbsoluteTransform().point({ x: 10, y: 7 }));
    if (doubleClick) await page.mouse.dblclick(host.x + title.x, host.y + title.y);
    else await page.mouse.click(host.x + title.x, host.y + title.y);
  };
  await clickTitle(false);
  await expect(inlineName).toHaveCount(0);
  await clickTitle(true);
  await expect(inlineName).toBeFocused();
  await expect(inlineName).toHaveValue('镜头参考');
  await inlineName.fill('  镜头 03 · 外景  '); await inlineName.press('Enter'); await saved(page);
  expect((await snapshot(page)).document.groups[0].name).toBe('镜头 03 · 外景');
  await page.keyboard.press('Control+z'); await saved(page);
  expect((await snapshot(page)).document.groups[0].name).toBe('镜头参考');
  await page.keyboard.press('Control+Shift+z'); await saved(page);
  expect((await snapshot(page)).document.groups[0].name).toBe('镜头 03 · 外景');
  await clickTitle(true);
  await inlineName.fill('   '); await inlineName.press('Enter'); await saved(page);
  expect((await snapshot(page)).document.groups[0].name).toBe('镜头 03 · 外景');
  await clickTitle(true);
  await inlineName.fill('取消改名'); await inlineName.press('Escape'); await saved(page);
  expect((await snapshot(page)).document.groups[0].name).toBe('镜头 03 · 外景');
  const finalBoard = await snapshot(page);
  expect(finalBoard.document.groups[0]).toEqual({ ...group, name: '镜头 03 · 外景' });
  expect(finalBoard.document.items).toEqual(board.document.items);
  await page.reload(); await saved(page); expect(await snapshot(page)).toEqual(finalBoard);
  await page.screenshot({ path: 'test-results/group-board.png', fullPage: true });
  const q = screen(finalBoard.document.groups[0].x + 16, finalBoard.document.groups[0].y + 16); await page.mouse.click(q.x, q.y);
  await page.keyboard.press('Delete'); await saved(page);
  const removed = await snapshot(page); expect(removed.document.groups).toHaveLength(0); expect(removed.document.items).toHaveLength(2);
  expect(removed.document.items.every((i: any) => i.groupId === null)).toBe(true);
});

test('legacy groups gain bounds without changing IDs and cards transfer between boards', async ({ page }) => {
  const ids = await page.evaluate(async () => {
    const board = await (await fetch('/api/v1/boards/main')).json();
    const session = await (await fetch('/api/v1/session', { method: 'POST', headers: { 'X-MshTV-Bootstrap': '1' } })).json();
    const a = crypto.randomUUID(), b = crypto.randomUUID(), id = crypto.randomUUID();
    const response = await fetch('/api/v1/boards/main/mutations', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf }, body: JSON.stringify({ baseRevision: board.revision, clientId: crypto.randomUUID(), mutationId: crypto.randomUUID(), operations: [
      { kind: 'putGroup', group: { id: a, name: '旧分组' } },
      { kind: 'putGroup', group: { id: b, name: '目标分组', x: 440, y: 60, width: 300, height: 250 } },
      { kind: 'putItem', item: { id, type: 'note', assetId: null, title: '此标题不应出现在画布', text: '仅显示正文', x: 100, y: 120, width: 160, height: 120, groupId: a } },
    ] }) }); if (!response.ok) throw new Error(await response.text()); return { a, b, id };
  });
  await page.reload(); await saved(page);
  const initial = await snapshot(page), legacy = initial.document.groups[0];
  expect(legacy).toEqual({ id: ids.a, name: '旧分组', x: 76, y: 72, width: 208, height: 192 });
  expect(initial.document.items[0].id).toBe(ids.id);
  const host = (await page.locator('[data-canvas-host]').boundingBox())!;
  await page.mouse.move(host.x + 100 + 180, host.y + 100 + 180); await page.mouse.down();
  await page.mouse.move(host.x + 100 + 590, host.y + 100 + 180, { steps: 12 }); await page.mouse.up(); await saved(page);
  const transferred = await snapshot(page);
  expect(transferred.document.items[0].groupId).toBe(ids.b); expect(transferred.document.groups).toEqual(initial.document.groups);
  // Shrink the target board without scaling the note; its center now lies outside, so it leaves.
  await page.mouse.click(host.x + 100 + 456, host.y + 100 + 76);
  await page.mouse.move(host.x + 100 + 740, host.y + 100 + 185); await page.mouse.down();
  await page.mouse.move(host.x + 100 + 540, host.y + 100 + 185, { steps: 12 }); await page.mouse.up(); await saved(page);
  const shrunk = await snapshot(page);
  expect(shrunk.document.items[0].groupId).toBeNull();
  expect(shrunk.document.items[0].width).toBe(160); expect(shrunk.document.groups).toHaveLength(2);
});

test('notes require double click to type inline, autosave, track camera zoom and undo as one session', async ({ page }) => {
  await page.getByRole('button', { name: '添加文字备注', exact: true }).click(); await saved(page);
  const input = page.getByRole('textbox', { name: '备注内容' });
  await expect(input).toHaveCount(0);
  const created = (await snapshot(page)).document.items[0], initialHost = (await page.locator('[data-canvas-host]').boundingBox())!;
  await page.mouse.click(initialHost.x + 100 + created.x + 35, initialHost.y + 100 + created.y + 35);
  await expect(input).toHaveCount(0); await expect(page.getByTestId('item-count')).toContainText('已选 1 项');
  await page.mouse.dblclick(initialHost.x + 100 + created.x + 35, initialHost.y + 100 + created.y + 35);
  await expect(input).toBeFocused(); await expect(page.locator('.modal-backdrop')).toHaveCount(0);
  await page.keyboard.type('N V H F '); await page.keyboard.insertText('镜头构图');
  await input.press('Enter'); await page.keyboard.insertText('第二行中文备注'); await saved(page);
  const note = (await snapshot(page)).document.items[0]; expect(note.text).toBe('N V H F 镜头构图\n第二行中文备注');
  expect((await snapshot(page)).document.items).toHaveLength(1);
  const before = (await input.boundingBox())!, host = (await page.locator('[data-canvas-host]').boundingBox())!;
  expect(before.x).toBeCloseTo(host.x + 100 + note.x + 18, 0); expect(before.y).toBeCloseTo(host.y + 100 + note.y + 18, 0);
  const anchor = { x: host.x + 35, y: host.y + 110 }, factor = Math.exp(.3);
  await page.mouse.move(anchor.x, anchor.y); await page.mouse.wheel(0, -100);
  await expect.poll(async () => (await input.boundingBox())!.width).toBeGreaterThan(before.width * 1.3);
  const after = (await input.boundingBox())!;
  expect(after.x).toBeCloseTo(anchor.x + (before.x - anchor.x) * factor, 0);
  expect(after.y).toBeCloseTo(anchor.y + (before.y - anchor.y) * factor, 0);
  expect(after.width / before.width).toBeCloseTo(factor, 2);
  await expect(input).toBeFocused(); await expect(input).toHaveCSS('font-size', '16px');
  await page.screenshot({ path: 'test-results/inline-note.png', fullPage: true });
  // Simulate an IME-confirm key: it must not finish the editing session.
  await input.dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true }); await expect(input).toBeVisible();
  await input.press('Control+Enter'); await expect(input).toHaveCount(0); await saved(page);
  await page.keyboard.press('Control+z'); await saved(page); expect((await snapshot(page)).document.items[0].text).toBe('');
  await page.keyboard.press('Control+Shift+z'); await saved(page); expect((await snapshot(page)).document.items[0].text).toBe(note.text);
  await page.reload(); await saved(page);
  const h = (await page.locator('[data-canvas-host]').boundingBox())!;
  const x = h.x + anchor.x - host.x + (host.x + 100 + note.x + 35 - anchor.x) * factor;
  const y = h.y + anchor.y - host.y + (host.y + 100 + note.y + 35 - anchor.y) * factor;
  await page.mouse.click(x, y);
  await expect(input).toHaveCount(0);
  await page.mouse.dblclick(x, y);
  await expect(input).toBeFocused(); await expect(input).toHaveText(note.text, { useInnerText: true });
  await input.fill('取消这次编辑'); await saved(page); await input.press('Escape'); await saved(page);
  expect((await snapshot(page)).document.items[0].text).toBe(note.text);
});

test('image video and audio names edit in place on double click', async ({ page }) => {
  const host = (await page.locator('[data-canvas-host]').boundingBox())!;
  for (const [button, name] of [['添加示例图片', '图片 · 建立镜头'], ['视频占位卡片', '视频 · 第二版本'], ['音频占位卡片', '声音 · 环境声']]) {
    await page.getByRole('button', { name: button, exact: true }).click(); await saved(page);
    const item = (await snapshot(page)).document.items.at(-1);
    await page.mouse.dblclick(host.x + 100 + item.x + 26, host.y + 100 + item.y + item.height - 20);
    const input = page.getByRole('textbox', { name: '素材名称' });
    await expect(input).toBeFocused(); await expect(page.locator('.modal-backdrop')).toHaveCount(0);
    const rect = (await input.boundingBox())!; expect(rect.x).toBeCloseTo(host.x + 100 + item.x + 13, 0);
    await input.fill(name); await input.press('Enter'); await saved(page);
    expect((await snapshot(page)).document.items.at(-1).title).toBe(name);
    await page.mouse.dblclick(host.x + 100 + item.x + 26, host.y + 100 + item.y + item.height - 20);
    await input.fill('未采用的名称'); await input.press('Escape'); await saved(page);
    expect((await snapshot(page)).document.items.at(-1).title).toBe(name);
  }
  await page.keyboard.press('Control+z'); await saved(page); expect((await snapshot(page)).document.items.at(-1).title).toBe('音频占位');
  await page.keyboard.press('Control+Shift+z'); await saved(page);
  await page.reload(); await saved(page); expect((await snapshot(page)).document.items.map((i: any) => i.title)).toEqual(['图片 · 建立镜头', '视频 · 第二版本', '声音 · 环境声']);
});

test('Ctrl toggles selection and adds box selections without opening editors', async ({ page }) => {
  await page.evaluate(async () => {
    const board = await (await fetch('/api/v1/boards/main')).json();
    const session = await (await fetch('/api/v1/session', { method: 'POST', headers: { 'X-MshTV-Bootstrap': '1' } })).json();
    const items = ['note', 'image', 'video'].map((type, index) => ({ id: crypto.randomUUID(), type, assetId: type === 'image' ? 'sample-dunes' : null, title: '选择测试', text: type === 'note' ? '双击编辑正文' : '', x: 40 + index * 260, y: 100, width: 160, height: 120, groupId: null }));
    const response = await fetch('/api/v1/boards/main/mutations', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf }, body: JSON.stringify({ baseRevision: board.revision, clientId: crypto.randomUUID(), mutationId: crypto.randomUUID(), operations: items.map(item => ({ kind: 'putItem', item })) }) });
    if (!response.ok) throw new Error('Could not seed selection test');
  });
  await page.reload(); await saved(page);
  const host = (await page.locator('[data-canvas-host]').boundingBox())!;
  const point = (x: number, y: number) => ({ x: host.x + 100 + x, y: host.y + 100 + y });
  const click = async (x: number, y = 160) => { const p = point(x, y); await page.mouse.click(p.x, p.y); };
  const count = async (n: number) => expect(page.getByTestId('item-count')).toContainText(`已选 ${n} 项`);
  await click(120); await count(1); await expect(page.getByRole('textbox', { name: '备注内容' })).toHaveCount(0);
  await page.keyboard.down('Control');
  await click(380); await count(2);
  await click(120); await count(1);
  await click(640); await count(2);
  await page.keyboard.up('Control');
  await click(120); await count(1);
  await page.keyboard.down('Shift'); await click(380); await page.keyboard.up('Shift'); await count(1);
  await page.keyboard.down('Control'); await click(120); await count(2);
  const note = point(120, 160); await page.mouse.dblclick(note.x, note.y);
  await expect(page.getByRole('textbox', { name: '备注内容' })).toHaveCount(0); await count(2);
  await click(120); await count(1); await page.keyboard.up('Control');
  await page.keyboard.down('Meta'); await click(120); await page.keyboard.up('Meta'); await count(2);
  await page.keyboard.press('Escape'); await click(120);
  const boxSelect = async (left: number, top: number, right: number, bottom: number) => {
    const start = point(left, top), end = point(right, bottom);
    await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 8 }); await page.mouse.up();
  };
  await page.keyboard.down('Control'); await boxSelect(280, 80, 480, 240); await page.keyboard.up('Control'); await count(2);
  const before = await snapshot(page), image = point(380, 160);
  await page.mouse.move(image.x, image.y); await page.mouse.down(); await page.mouse.move(image.x + 24, image.y + 15, { steps: 8 }); await page.mouse.up(); await saved(page);
  const moved = await snapshot(page);
  for (let i = 0; i < 2; i++) { expect(moved.document.items[i].x - before.document.items[i].x).toBeCloseTo(24, 0); expect(moved.document.items[i].y - before.document.items[i].y).toBeCloseTo(15, 0); }
  expect(moved.document.items[2]).toEqual(before.document.items[2]);
  await expect(page.getByRole('textbox', { name: '备注内容' })).toHaveCount(0);
  await page.keyboard.down('Shift'); await boxSelect(540, 80, 740, 240); await page.keyboard.up('Shift'); await count(1);
  await page.keyboard.down('Control'); const title = point(moved.document.items[1].x + 24, moved.document.items[1].y + 100); await page.mouse.dblclick(title.x, title.y); await page.keyboard.up('Control');
  await expect(page.getByRole('textbox', { name: '素材名称' })).toHaveCount(0);
});

test('note emphasis formats selected text and survives save undo resize and reload', async ({ page }) => {
  await page.getByRole('button', { name: '添加文字备注', exact: true }).click(); await saved(page);
  const note = (await snapshot(page)).document.items[0], host = (await page.locator('[data-canvas-host]').boundingBox())!;
  const left = host.x + 100 + note.x, top = host.y + 100 + note.y;
  const input = page.getByRole('textbox', { name: '备注内容' });
  const open = async () => { await page.mouse.dblclick(left + 35, top + 35); await expect(input).toBeFocused(); };
  const select = async (from: number, to: number) => {
    const points = await input.evaluate((element, offsets) => offsets.map(offset => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT); let node = walker.nextNode(), skipped = 0;
      while (node) { const length = node.textContent?.length ?? 0; if (offset <= skipped + length) { const range = document.createRange(); range.setStart(node, offset - skipped); range.collapse(true); const rect = range.getBoundingClientRect(); return { x: rect.left + .1, y: rect.top + rect.height / 2 }; } skipped += length; node = walker.nextNode(); }
      throw new Error('Could not locate note text');
    }), [from, to]);
    await page.mouse.move(points[0].x, points[0].y); await page.mouse.down(); await page.mouse.move(points[1].x, points[1].y, { steps: 10 }); await page.mouse.up();
    await expect.poll(() => input.evaluate(element => element.ownerDocument.getSelection()?.toString() ?? '')).toBe((await input.textContent())!.slice(from, to));
  };
  await open(); await input.fill('普通 重点内容 结尾'); await input.press('Control+Enter'); await saved(page);
  await open(); await select(3, 7);
  for (const name of ['加粗', '斜体', '下划线', '标红']) { await page.getByRole('button', { name, exact: true }).click(); await expect(input).toBeFocused(); }
  await expect(input.locator('strong')).toHaveText('重点内容'); await expect(input.locator('em')).toHaveText('重点内容');
  await expect(input.locator('u')).toHaveText('重点内容'); await expect(input.locator('[data-note-red]')).toHaveCSS('color', 'rgb(240, 120, 120)');
  await expect(input).toHaveCSS('font-size', '16px'); await saved(page);
  const marks = [{ from: 3, to: 7, bold: true, italic: true, underline: true, red: true }];
  expect((await snapshot(page)).document.items[0].noteSpans).toEqual(marks);
  await input.press('Control+Enter'); await saved(page);
  await page.keyboard.press('Control+z'); await saved(page);
  expect((await snapshot(page)).document.items[0].text).toBe('普通 重点内容 结尾'); expect((await snapshot(page)).document.items[0].noteSpans ?? []).toEqual([]);
  await page.keyboard.press('Control+Shift+z'); await saved(page);
  await page.reload(); await saved(page); expect((await snapshot(page)).document.items[0].noteSpans).toEqual(marks);
  // Confirm the canvas renderer really draws red pixels after the DOM editor is gone.
  const image = await page.screenshot({ clip: { x: left + 18, y: top + 18, width: 250, height: 30 } });
  const redPixels = await page.evaluate(async base64 => {
    const image = new Image(); image.src = 'data:image/png;base64,' + base64; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0); const pixels = context.getImageData(0, 0, image.width, image.height).data;
    let count = 0; for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 150 && pixels[i] > pixels[i + 1] * 1.25 && pixels[i + 1] < 170) count++; return count;
  }, image.toString('base64'));
  expect(redPixels).toBeGreaterThan(25);
  // Resize without changing font size or persisted emphasis positions.
  await page.mouse.click(left + 7, top + 7); await page.mouse.move(left + note.width, top + note.height); await page.mouse.down();
  await page.mouse.move(left + note.width + 80, top + note.height + 40, { steps: 10 }); await page.mouse.up(); await saved(page);
  expect((await snapshot(page)).document.items[0].width).toBeGreaterThan(note.width + 50);
  expect((await snapshot(page)).document.items[0].noteSpans).toEqual(marks);
  await open(); await select(4, 4); await page.keyboard.insertText('新'); await saved(page);
  expect((await snapshot(page)).document.items[0].noteSpans[0].to).toBe(8);
  await input.press('Escape'); await saved(page); expect((await snapshot(page)).document.items[0].noteSpans).toEqual(marks);
  await open(); await select(3, 7); await page.getByRole('button', { name: '清除格式' }).click();
  await expect(input.locator('strong,u,em,[data-note-red]')).toHaveCount(0);
  await input.press('Control+Enter'); await saved(page); expect((await snapshot(page)).document.items[0].noteSpans).toEqual([]);
  await page.keyboard.press('Control+z'); await saved(page); expect((await snapshot(page)).document.items[0].noteSpans).toEqual(marks);
  await page.screenshot({ path: 'test-results/note-emphasis.png', fullPage: true });
  await open();
  await input.evaluate(element => {
    const data = new DataTransfer(); data.setData('text/html', '<p onclick="window.noteUnsafe=1"><strong>安全文本</strong><img src="/never-load-note-image" onerror="window.noteUnsafe=1"/></p>');
    data.setData('text/plain', '安全文本'); element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(input.locator('img,script,a,[onclick],[onerror]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as typeof window & { noteUnsafe?: number }).noteUnsafe)).toBeUndefined();
  await input.press('Escape'); await saved(page);
  await open(); await select(3, 7);
  for (const [key, tag] of [['b', 'strong'], ['i', 'em'], ['u', 'u']]) {
    await input.press(`Control+${key}`); await expect(input.locator(tag)).toHaveCount(0);
    await input.press(`Control+${key}`); await expect(input.locator(tag)).toHaveText('重点内容');
  }
  await input.press('Control+Enter'); await saved(page);
});
