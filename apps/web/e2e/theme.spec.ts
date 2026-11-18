import { expect, test, type Page } from '@playwright/test';

async function colors(page: Page) {
  return page.evaluate(() => {
    const stage = (window as any).Konva.stages[0];
    const cards = stage.find('.card-background');
    const group = stage.findOne('.group-background');
    return {
      cards: cards.map((node: any) => node.fill()),
      shadows: cards.map((node: any) => node.hasShadow()),
      group: group?.fill(),
      corners: [...cards.map((node: any) => node.cornerRadius()), group?.cornerRadius()],
      strokes: [...cards.map((node: any) => node.stroke()), group?.stroke()],
    };
  });
}

async function selectionEffect(page: Page) {
  return page.evaluate(() => {
    const stage = (window as any).Konva.stages[0];
    const transformer = stage.find('Transformer').find((node: any) => node.nodes().length > 0);
    return {
      lights: stage.find('.selection-light').length,
      lift: transformer?.nodes().map((node: any) => node.offsetY()) ?? [],
      border: transformer?.borderEnabled(),
      anchor: transformer?.anchorFill(),
    };
  });
}

test('theme follows the browser across workspace, canvas and reload without editing the board', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem('mshtv:light-gray-v2', '30');
    localStorage.setItem('mshtv:selection-hdr-strength-v2', '80');
    const matchMedia = window.matchMedia.bind(window);
    window.matchMedia = query => {
      const media = matchMedia(query);
      if (query === '(dynamic-range: high)') Object.defineProperty(media, 'matches', { value: false });
      return media;
    };
  });
  await page.goto('/');
  const root = page.locator('html');
  await expect(root).toHaveAttribute('data-theme', 'light');
  const icon = page.locator('link[rel="icon"]');
  await expect(icon).toHaveAttribute('href', '/favicon.png');
  const favicon = await page.request.get('/favicon.png');
  expect(favicon.ok()).toBe(true);
  expect(favicon.headers()['content-type']).toContain('image/png');
  const settings = page.getByRole('button', { name: '设置', exact: true });
  await settings.click();
  await expect(page.getByRole('switch', { name: 'HDR 选中光晕' })).not.toBeChecked();
  await expect(page.getByRole('switch', { name: '闪光弹模式' })).toBeDisabled();
  await page.getByRole('button', { name: '局域网访问', exact: true }).click();
  await expect(page.getByText('主机运行中 · 仅本机访问')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '启用局域网访问' })).not.toBeChecked();
  await page.getByRole('button', { name: '关闭局域网设置' }).click();
  await page.getByRole('button', { name: '切换到深色主题' }).click();
  await expect(root).toHaveAttribute('data-theme', 'dark');
  const cover = page.getByRole('link', { name: '打开画布 自由画布' }).locator('img');
  const projectCard = page.locator('.workspace-board-card').filter({ has: cover });
  const storageButton = page.getByRole('button', { name: '存储与维护' });
  const createButton = page.getByRole('button', { name: '新建独立画布' });
  await expect(storageButton).toHaveCount(0);
  await settings.hover();
  await expect(settings).toHaveCSS('box-shadow', /0px 6px 9px -5px/);
  await expect(settings).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await createButton.hover();
  await expect(createButton).toHaveCSS('background-color', 'rgb(61, 85, 71)');
  await cover.hover();
  await expect(projectCard).toHaveCSS('translate', '0px -4px');
  await expect(projectCard).toHaveCSS('box-shadow', /15px 24px -13px/);
  await cover.evaluate((image: HTMLImageElement) => image.decode());
  await page.screenshot({ path: testInfo.outputPath('dark-workspace-hover.png') });
  await page.getByRole('button', { name: '切换到浅色主题' }).click();
  await expect(root).toHaveCSS('color-scheme', 'light');
  await expect(page.locator('.app-header')).toHaveCSS('background-color', 'rgb(241, 241, 241)');
  await createButton.hover();
  await expect(createButton).toHaveCSS('background-color', 'rgb(40, 43, 50)');
  await settings.click();
  await storageButton.hover();
  await expect(storageButton).toHaveCSS('box-shadow', /0px 6px 9px -5px/);
  await expect(storageButton).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await storageButton.click();
  await expect(page.locator('.storage-dialog')).toHaveCSS('background-color', 'rgb(243, 243, 243)');
  await page.keyboard.press('Escape');
  await expect(page.locator('.storage-dialog')).toHaveCount(0);
  await expect(cover).toHaveAttribute('src', /&theme=light$/);
  const coverUrl = (await cover.getAttribute('src'))!;
  const lightCover = await page.request.get(coverUrl);
  const darkCover = await page.request.get(coverUrl.replace('&theme=light', ''));
  expect(await lightCover.text()).toContain('fill="#f2f3f5"');
  expect(await darkCover.text()).toContain('fill="#15181b"');
  expect(lightCover.headers().etag).not.toBe(darkCover.headers().etag);
  await cover.evaluate((image: HTMLImageElement) => image.decode());
  await page.screenshot({ path: testInfo.outputPath('light-workspace.png') });
  await cover.hover();
  await expect(projectCard).toHaveCSS('translate', '0px -4px');
  await expect(projectCard).toHaveCSS('box-shadow', /15px 24px -13px/);
  await page.screenshot({ path: testInfo.outputPath('light-workspace-hover.png') });

  const fixture = await page.evaluate(async () => {
    const api = async (path: string, body?: object) => {
      const session = await (await fetch('/api/v1/session', { method: 'POST', headers: { 'X-MshTV-Bootstrap': '1' } })).json();
      const response = await fetch('/api/v1' + path, body ? {
        method: 'POST', headers: { 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      } : {});
      if (!response.ok) throw new Error(path + ': ' + response.status);
      return response.json();
    };
    const { id } = await api('/workspace/boards', { name: '主题测试' });
    const groupId = crypto.randomUUID(), noteId = crypto.randomUUID();
    const text = '本地色彩测试\n核对备注和选框';
    const board = await api('/boards/' + id);
    await api('/boards/' + id + '/mutations', {
      baseRevision: board.revision, clientId: crypto.randomUUID(), mutationId: crypto.randomUUID(), operations: [
        { kind: 'putGroup', group: { id: groupId, name: '素材与备注', x: 18, y: 34, width: 640, height: 399 } },
        { kind: 'putItem', item: { id: crypto.randomUUID(), type: 'image', assetId: 'sample-coast', title: '海岸 · 空镜', text: '', x: 54, y: 104, width: 300, height: 220, groupId } },
        { kind: 'putItem', item: { id: noteId, type: 'note', assetId: null, title: '备注', text, x: 386, y: 104, width: 227, height: 164, groupId,
          noteSpans: [{ from: 0, to: 6, red: true, bold: true, italic: false, underline: false }] } },
        { kind: 'putItem', item: { id: crypto.randomUUID(), type: 'video', assetId: null, title: '视频片段', text: '', x: 386, y: 289, width: 227, height: 121, groupId } },
      ],
    });
    return { id, noteId, snapshot: await api('/boards/' + id) };
  });
  await page.reload();
  await expect(root).toHaveAttribute('data-theme', 'light');
  await page.getByRole('link', { name: '打开画布 主题测试', exact: true }).click();
  await expect(page.getByText('已保存到本机', { exact: true })).toBeVisible();
  await expect(root).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('[data-canvas-host]')).toHaveCSS('background-color', 'rgb(228, 228, 230)');
  await expect(page.locator('.library-panel')).toHaveCSS('background-color', 'rgb(221, 222, 225)');
  await expect(page.locator('.properties-panel')).toHaveCSS('background-color', 'rgb(221, 222, 225)');
  await expect(page.locator('.tool-set')).toHaveCSS('background-image', 'none');
  await expect(page.locator('.zoom-controls')).toHaveCSS('box-shadow', 'none');
  await expect.poll(() => colors(page)).toEqual({ cards: ['#f3f3f3', '#f3f3f3', '#f3f3f3'], group: '#dddfe3', shadows: [true, true, true], corners: [16, 16, 16, 20], strokes: ['#cfd2d7', '#cfd2d7', '#cfd2d7', '#c7cbd1'] });
  await page.getByRole('button', { name: '适应全部' }).click();
  const host = (await page.locator('[data-canvas-host]').boundingBox())!;
  const cardPoint = (cardId: string) => page.evaluate(id => (window as any).Konva.stages[0].findOne('#' + id).getAbsoluteTransform().point({ x: 38, y: 38 }), cardId);
  const image = await cardPoint(fixture.snapshot.document.items[0].id);
  await page.mouse.click(host.x + image.x, host.y + image.y);
  await expect.poll(() => selectionEffect(page)).toEqual({ lights: 1, lift: [3], border: false, anchor: 'transparent' });
  await expect.poll(() => page.evaluate(id => {
    const card = (window as any).Konva.stages[0].findOne('#' + id);
    const canvas = card.getLayer().getCanvas(), ratio = canvas.getPixelRatio();
    const transform = card.getAbsoluteTransform(), scale = card.getAbsoluteScale().x;
    const w = card.width(), h = card.height();
    const warmth = (x: number, y: number) => {
      const p = transform.point({ x, y });
      const [red, , blue] = canvas.getContext().getImageData(Math.floor(p.x * ratio), Math.floor(p.y * ratio), 1, 1).data;
      return red - blue;
    };
    const image = card.findOne('Image');
    const whiteUnderImage = (x: number, y: number) => {
      const p = image.getAbsoluteTransform().point({ x, y });
      const [red, green, blue] = canvas.getContext().getImageData(Math.floor(p.x * ratio), Math.floor(p.y * ratio), 1, 1).data;
      return Math.min(red, green, blue) >= 240;
    };
    const near = 1.2 / scale, halo = 8 / scale, far = 24 / scale;
    const falloff = Array.from({ length: 16 }, (_, step) => warmth(w / 2, -(step + 2) / scale));
    const smoothHalo = new Set(falloff).size >= 8 && falloff.slice(1).every((value, step) => {
      const change = falloff[step] - value;
      return change >= -1 && change <= 5;
    });
    return {
      warmEdges: [[w / 2, -near], [w / 2, h + near], [-near, h / 2], [w + near, h / 2]].map(([x, y]) => warmth(x, y) >= 5),
      warmHalo: [[w / 2, -halo], [w / 2, h + halo], [-halo, h / 2], [w + halo, h / 2]].map(([x, y]) => warmth(x, y) >= 5),
      outsideWarm: warmth(w / 2, -far) >= 5,
      smoothHalo,
      roundedPhoto: image?.cornerRadius() === 9 && whiteUnderImage(.7, .7) && !whiteUnderImage(12, .7),
    };
  }, fixture.snapshot.document.items[0].id)).toEqual({ warmEdges: [true, true, true, true], warmHalo: [true, true, true, true], outsideWarm: false, smoothHalo: true, roundedPhoto: true });
  const note = await cardPoint(fixture.noteId);
  await page.keyboard.down('Control');
  await page.mouse.click(host.x + note.x, host.y + note.y);
  await page.keyboard.up('Control');
  await expect.poll(() => selectionEffect(page)).toEqual({ lights: 2, lift: [3, 3], border: false, anchor: 'transparent' });
  const corner = await page.evaluate(() => (window as any).Konva.stages[0].find('Transformer')
    .find((node: any) => node.nodes().length === 2).findOne('.bottom-right').getAbsolutePosition());
  await page.mouse.move(host.x + corner.x, host.y + corner.y);
  await expect.poll(() => page.locator('.konvajs-content').evaluate(node => (node as HTMLElement).style.cursor)).toMatch(/resize/);
  await page.screenshot({ path: testInfo.outputPath('light-canvas.png') });

  const performance = page.getByRole('switch', { name: '性能模式' });
  await expect(performance).toHaveAttribute('aria-checked', 'false');
  await performance.click();
  await expect.poll(() => colors(page)).toMatchObject({ shadows: [false, false, false], corners: [7, 7, 7, 10] });
  await expect.poll(() => selectionEffect(page)).toEqual({ lights: 0, lift: [0, 0], border: true, anchor: '#ffffff' });
  await performance.click();
  await expect.poll(() => colors(page)).toMatchObject({ shadows: [true, true, true], corners: [16, 16, 16, 20] });
  await expect.poll(() => selectionEffect(page)).toEqual({ lights: 2, lift: [3, 3], border: false, anchor: 'transparent' });
  await page.keyboard.press('Escape');
  await expect.poll(() => selectionEffect(page)).toMatchObject({ lights: 0, lift: [] });

  const offset = await cardPoint(fixture.noteId);
  await page.mouse.dblclick(host.x + offset.x, host.y + offset.y);
  await expect(page.locator('.inline-note')).toHaveCSS('background-color', 'rgb(243, 243, 243)');
  await expect(page.locator('[data-note-red]')).toHaveCSS('color', 'rgb(170, 52, 45)');
  await page.keyboard.press('Escape');
  await expect(page.getByText('已保存到本机', { exact: true })).toBeVisible();

  const appearance = page.getByRole('button', { name: '设置', exact: true });
  const hdr = page.getByRole('switch', { name: 'HDR 选中光晕' });
  const flash = page.getByRole('switch', { name: '闪光弹模式' });
  await appearance.click();
  await expect(page.getByRole('group', { name: 'HDR 亮度' }).getByRole('slider')).toHaveCount(0);
  await expect(hdr).not.toBeChecked();
  await hdr.check();
  await expect(page.getByText('当前使用 SDR，请检查系统 HDR 和浏览器支持', { exact: true })).toBeVisible();
  await expect(page.locator('.selection-hdr-layer')).toBeHidden();
  await expect(flash).not.toBeChecked();
  await flash.check();
  await hdr.uncheck();
  await expect(flash).not.toBeChecked();
  await expect(flash).toBeDisabled();
  await expect(page.locator('.selection-hdr-layer')).toHaveCount(0);
  await expect.poll(() => selectionEffect(page)).toEqual({ lights: 1, lift: [3], border: false, anchor: 'transparent' });
  await hdr.press('Escape');
  await expect(appearance).toHaveAttribute('aria-expanded', 'false');

  await page.getByRole('button', { name: '切换到深色主题' }).click();
  await expect(root).toHaveCSS('color-scheme', 'dark');
  await expect.poll(() => selectionEffect(page)).toEqual({ lights: 1, lift: [3], border: false, anchor: 'transparent' });
  await expect.poll(() => page.evaluate(id => (window as any).Konva.stages[0].findOne('#' + id).findOne('Image')?.cornerRadius(),
    fixture.snapshot.document.items[0].id)).toBe(9);
  await expect.poll(() => page.evaluate(id => {
    const card = (window as any).Konva.stages[0].findOne('#' + id);
    const canvas = card.getLayer().getCanvas(), ratio = canvas.getPixelRatio();
    const edge = card.getAbsoluteTransform().point({ x: card.width() / 2, y: 0 });
    const [red, green, blue] = canvas.getContext().getImageData(Math.floor(edge.x * ratio), Math.floor((edge.y - 3) * ratio), 1, 1).data;
    return red > green + 4 && green > blue + 8 && red < 110;
  }, fixture.noteId)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('dark-canvas.png') });
  await page.keyboard.press('Escape');
  await expect.poll(() => colors(page)).toEqual({ cards: ['#24282d', '#33312a', '#24282d'], group: '#202a24', shadows: [false, false, false], corners: [16, 16, 16, 20], strokes: ['#3a3f44', '#3a3f44', '#3a3f44', '#53695b'] });
  await page.reload();
  await expect(root).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(async id => (await fetch('/api/v1/boards/' + id)).json(), fixture.id)).toEqual(fixture.snapshot);
  await page.getByRole('button', { name: '切换到浅色主题' }).click();
  await appearance.click();
  await expect(hdr).not.toBeChecked();
  await expect(flash).not.toBeChecked();
  await hdr.check();
  await expect(flash).toBeEnabled();
  await expect(page.locator('[data-canvas-host]')).toHaveCSS('background-color', 'rgb(228, 228, 230)');
});

test('settings groups host and HDR controls and keeps LAN connection and devices on separate pages', async ({ page }, testInfo) => {
  await page.route('**/api/v1/lan/status', route => route.fulfill({ json: {
    enabled: true, address: '192.168.1.10', port: 5443, activeUrl: 'https://192.168.1.10:5443',
    accepting: true, restartRequired: false, error: null, fingerprint: 'A'.repeat(64),
    addresses: [{ address: '192.168.1.10', name: '测试网卡', prefix: 24 }],
    devices: [{ id: 'test-device', name: '测试设备', address: '192.168.1.11' }],
  } }));
  await page.goto('/');
  const settings = page.getByRole('button', { name: '设置', exact: true });
  const menu = page.getByRole('group', { name: '设置选项' });
  await expect(settings).toHaveCount(1);
  await settings.click();
  await expect(menu.getByRole('button', { name: '存储与维护' })).toBeEnabled();
  await expect(menu.getByRole('group', { name: 'HDR 亮度' }).getByRole('switch')).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath('settings-menu.png') });
  await menu.getByRole('button', { name: '局域网访问', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '局域网访问', exact: true });
  const connection = dialog.getByRole('button', { name: '连接', exact: true });
  const devices = dialog.getByRole('button', { name: '设备', exact: true });
  await expect(connection).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByRole('button', { name: '测试主机连接' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '生成一次性配对码' })).toHaveCount(0);
  await dialog.getByRole('spinbutton', { name: 'HTTPS 端口' }).fill('5444');
  await devices.click();
  await expect(devices).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByText(/测试设备.*192\.168\.1\.11/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: '生成一次性配对码' })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: '撤销访问' })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: '测试主机连接' })).toHaveCount(0);
  await connection.click();
  await expect(dialog.getByRole('spinbutton', { name: 'HTTPS 端口' })).toHaveValue('5444');

  await page.goto('/?settings=lan');
  await expect(connection).toHaveAttribute('aria-pressed', 'true');
  await page.goto('/?settings=storage');
  await expect(page.getByRole('dialog', { name: '存储与维护' })).toBeVisible();
});
