import { test, expect, type Page } from '@playwright/test';

async function sampleLight(page: Page, point: 'edge' | 'inside' | 'covered') {
  return page.evaluate(async target => {
    const stage = (window as any).Konva.stages[0];
    const card = stage.findOne('.selection-light').getParent();
    const frame = card.findOne('.card-background');
    const x = target === 'covered' ? frame.width() * .75 : frame.width() * .25;
    const origin = frame.getAbsoluteTransform().point({ x, y: target === 'inside' ? frame.height() / 2 : 0 });
    const result: Promise<number[]> = (window as any).sampleHdrPixel(origin.x, origin.y - (target === 'inside' ? 0 : 2));
    card.getLayer().draw();
    return result;
  }, point);
}

async function sampleSdrLight(page: Page) {
  return page.evaluate(() => {
    const card = (window as any).Konva.stages[0].findOne('.selection-light').getParent();
    const canvas = card.getLayer().getCanvas(), ratio = canvas.getPixelRatio();
    const edge = card.getAbsoluteTransform().point({ x: card.width() / 2, y: 0 });
    return Array.from(canvas.getContext().getImageData(Math.floor(edge.x * ratio), Math.floor((edge.y - 3) * ratio), 1, 1).data);
  });
}

test('HDR selection emits extended brightness and follows drag, zoom and occlusion', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const matchMedia = window.matchMedia.bind(window);
    window.matchMedia = query => {
      const media = matchMedia(query);
      if (query === '(dynamic-range: high)') Object.defineProperty(media, 'matches', { value: true });
      return media;
    };
    if (typeof GPUCanvasContext === 'undefined') return;
    const configure = GPUCanvasContext.prototype.configure;
    const getTexture = GPUCanvasContext.prototype.getCurrentTexture;
    const submit = GPUQueue.prototype.submit;
    let device: GPUDevice | undefined, texture: GPUTexture | undefined;
    type Pending = { x: number; y: number; resolve: (pixel: number[]) => void; reject: (error: unknown) => void };
    let pending: Pending | undefined;
    const decodeHalf = (half: number) => {
      const exponent = (half >> 10) & 31, fraction = (half & 1023) / 1024;
      return (half & 0x8000 ? -1 : 1) * (exponent ? (1 + fraction) * 2 ** (exponent - 15) : fraction * 2 ** -14);
    };
    (window as any).sampleHdrPixel = (x: number, y: number) => new Promise<number[]>((resolve, reject) => {
      pending = { x, y, resolve, reject };
      setTimeout(() => { if (pending?.resolve === resolve) { pending = undefined; reject(new Error('HDR frame did not render')); } }, 2000);
    });
    GPUCanvasContext.prototype.configure = function (configuration) {
      device = configuration.device;
      configure.call(this, { ...configuration, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    };
    GPUCanvasContext.prototype.getCurrentTexture = function () {
      return texture = getTexture.call(this);
    };
    GPUQueue.prototype.submit = function (commands) {
      submit.call(this, commands);
      if (!pending || !device || !texture || this !== device.queue) return;
      const { x, y, resolve, reject } = pending;
      pending = undefined;
      const canvas = document.querySelector<HTMLCanvasElement>('.selection-hdr-layer')!;
      const buffer = device.createBuffer({ size: 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture, origin: [Math.floor(x * canvas.width / canvas.clientWidth), Math.floor(y * canvas.height / canvas.clientHeight)] }, { buffer }, [1, 1]);
      submit.call(this, [encoder.finish()]);
      void buffer.mapAsync(GPUMapMode.READ).then(() => resolve(Array.from(new Uint16Array(buffer.getMappedRange()), decodeHalf)), reject)
        .finally(() => buffer.destroy());
    };
  });
  await page.goto('/');
  test.skip(!await page.evaluate(async () => Boolean(await navigator.gpu?.requestAdapter())), 'WebGPU adapter unavailable in this browser');
  const boardId = await page.evaluate(async () => {
    const session = await (await fetch('/api/v1/session', { method: 'POST', headers: { 'X-MshTV-Bootstrap': '1' } })).json();
    const response = await fetch('/api/v1/workspace/boards', {
      method: 'POST', headers: { 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'HDR 选中光晕测试' }),
    });
    if (!response.ok) throw new Error(`Could not create the HDR test board (${response.status})`);
    return (await response.json()).id;
  });
  await page.goto(`/?board=${boardId}`);
  await expect(page.getByText('已保存到本机', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '添加文字备注', exact: true }).click();
  await page.getByRole('button', { name: '适应全部' }).click();
  const overlay = page.locator('.selection-hdr-layer');
  await expect.poll(() => page.evaluate(() => (window as any).Konva.stages[0].findOne('.selection-light')?.getParent().offsetY())).toBe(3);
  const appearance = page.getByRole('button', { name: '设置', exact: true });
  const hdr = page.getByRole('switch', { name: 'HDR 选中光晕' });
  const flash = page.getByRole('switch', { name: '闪光弹模式' });
  await appearance.click();
  await expect(hdr).not.toBeChecked();
  await expect(flash).toBeDisabled();
  await expect(overlay).toHaveCount(0);
  await hdr.press('Escape');
  await page.getByRole('button', { name: '切换到深色主题' }).click();
  await appearance.click();
  await hdr.check();
  await expect(hdr).toBeChecked();
  await expect(page.getByText('深色主题仅在闪光弹模式下显示 HDR 高光', { exact: true })).toBeVisible();
  await expect(overlay).toHaveCount(0);
  const darkSdr = await sampleSdrLight(page);
  await hdr.uncheck();
  await expect(overlay).toHaveCount(0);
  expect(await sampleSdrLight(page)).toEqual(darkSdr);
  await hdr.check();
  await expect(overlay).toHaveCount(0);
  await hdr.press('Escape');

  await page.getByRole('button', { name: '切换到浅色主题' }).click();
  await expect(overlay).toBeVisible();
  await expect(overlay).toHaveCSS('pointer-events', 'none');
  const light = await sampleLight(page, 'edge');
  expect(light[0]).toBeGreaterThan(light[1]);
  expect(light[0] / light[3]).toBeCloseTo(1.5, 2);
  await page.getByRole('button', { name: '切换到深色主题' }).click();
  await expect(overlay).toHaveCount(0);

  await appearance.click();
  await flash.check();
  await expect(overlay).toBeVisible();
  const flashLight = await sampleLight(page, 'edge');
  expect(flashLight[0]).toBeGreaterThan(1);
  expect(flashLight[0] / flashLight[3]).toBeCloseTo(2.34, 2);
  expect(flashLight[0]).toBeGreaterThan(flashLight[1] * 1.15);
  expect(flashLight[1]).toBeGreaterThan(flashLight[2]);
  expect((await sampleLight(page, 'inside'))[3]).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('dark-hdr-canvas.png') });
  await flash.uncheck();
  await expect(overlay).toHaveCount(0);
  expect(await sampleSdrLight(page)).toEqual(darkSdr);
  await flash.check();
  await expect(overlay).toBeVisible();
  await flash.press('Escape');
  await page.getByRole('button', { name: '缩小' }).click();
  expect((await sampleLight(page, 'edge'))[0]).toBeGreaterThan(1);

  const { x, y } = await page.evaluate(() => {
    const node = (window as any).Konva.stages[0].findOne('.selection-light').getParent();
    return node.getAbsoluteTransform().point({ x: node.width() / 2, y: node.height() / 2 });
  });
  const host = (await page.locator('[data-canvas-host]').boundingBox())!;
  await page.mouse.move(host.x + x, host.y + y);
  await page.mouse.down();
  await page.mouse.move(host.x + x - 65, host.y + y + 30, { steps: 6 });
  expect((await sampleLight(page, 'edge'))[0]).toBeGreaterThan(1);
  await page.mouse.up();

  await page.evaluate(() => {
    const Konva = (window as any).Konva, selected = Konva.stages[0].findOne('.selection-light').getParent();
    const scale = selected.getAbsoluteScale().x;
    const origin = selected.getAbsoluteTransform().point({ x: 0, y: 0 });
    const top = selected.getParent().getAbsoluteTransform().copy().invert().point(origin);
    const layer = selected.getLayer();
    layer.add(new Konva.Rect({ x: top.x + selected.width() * .5, y: top.y - 20 / scale, width: selected.width(), height: 30 / scale, fill: '#fff' }));
  });
  expect((await sampleLight(page, 'covered'))[3]).toBe(0);
  expect((await sampleLight(page, 'edge'))[0]).toBeGreaterThan(1);
});
