import { expect, test, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

async function api(page: Page, path: string, body?: object) {
  return page.evaluate(async ({ path, body }) => {
    const session = body ? await (await fetch('/api/v1/session', { method: 'POST', headers: { 'X-MshTV-Bootstrap': '1' } })).json() : null;
    const response = await fetch('/api/v1' + path, {
      method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session?.csrf ?? '' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(`${path} ${response.status}`);
    return response.json();
  }, { path, body });
}

function fixtureMedia(path: string, args: string[]) {
  const result = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', ...args, path], { windowsHide: true });
  expect(result.status, result.stderr.toString()).toBe(0);
}

async function playCard(page: Page, id: string, video = true) {
  const host = (await page.locator('[data-canvas-host]').boundingBox())!;
  const play = await page.waitForFunction(({ id, video }) => {
    const stage = (window as any).Konva.stages[0];
    const card = stage.findOne('#' + id);
    if (video) return card?.getAbsoluteTransform().point({ x: card.width() / 4, y: card.height() / 4 });
    return card?.findOne('.media-play')?.getAbsolutePosition();
  }, { id, video });
  const point = await play.jsonValue();
  await play.dispose();
  await page.mouse.click(host.x + point.x, host.y + point.y);
}

function pictureAspect(page: Page, id: string) {
  return page.evaluate(id => {
    const card = (window as any).Konva.stages[0].findOne('#' + id);
    return card ? (card.width() - 14) / (card.height() - 47) : 0;
  }, id);
}

async function seek(page: Page, range: Locator, fraction: number) {
  await expect(range).toBeEnabled();
  const rect = (await range.boundingBox())!;
  await page.mouse.move(rect.x + 8, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width * fraction, rect.y + rect.height / 2, { steps: 6 });
  await page.mouse.up();
}

const time = (player: Locator) => player.evaluate((element: HTMLMediaElement) => element.currentTime);

test('library and canvas use on-demand native playback, waveform, seek and offscreen release', async ({ page, browser }) => {
  test.setTimeout(120000);
  const data = resolve('../..', '.data'); mkdirSync(data, { recursive: true });
  const rootPath = mkdtempSync(join(data, 'media-playback-'));
  const film = join(rootPath, 'film.mp4'), alternate = join(rootPath, 'alternate.mp4');
  fixtureMedia(film, ['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=15', '-t', '10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1', '-movflags', '+faststart']);
  fixtureMedia(alternate, ['-f', 'lavfi', '-i', 'color=blue:s=360x640:r=15', '-t', '10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1']);
  const sound = join(rootPath, 'sound.wav');
  fixtureMedia(sound, ['-f', 'lavfi', '-i', 'sine=frequency=660:duration=10', '-af', 'volume=0:enable=between(t\\,0\\,2)']);
  writeFileSync(join(rootPath, 'broken.mp4'), 'test media that the browser cannot decode');
  const originalAudio = readFileSync(sound);
  const sources: string[] = [], waveforms: string[] = [];
  page.on('request', request => {
    const { pathname } = new URL(request.url());
    if (pathname.endsWith('/source')) sources.push(pathname);
    if (pathname.endsWith('/waveform')) waveforms.push(pathname);
  });

  await page.goto('/?board=main');
  await expect(page.getByText('已保存到本机', { exact: true })).toBeVisible();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await api(page, '/boards/main')).document.items.length).toBe(0);
  const root = await api(page, '/library/roots', { path: rootPath });
  const list = () => api(page, `/assets?rootId=${root.id}`);
  await expect.poll(async () => (await list()).items.filter((asset: any) => asset.status === 'ready').length, { timeout: 25000 }).toBe(4);
  const assets = (await list()).items;
  const video = assets.find((asset: any) => asset.name === 'film.mp4');
  const video2 = assets.find((asset: any) => asset.name === 'alternate.mp4');
  const audio = assets.find((asset: any) => asset.name === 'sound.wav');
  const broken = assets.find((asset: any) => asset.name === 'broken.mp4');
  expect(video.hasThumbnail && video.hasPreview).toBe(true);
  const sourceFilter = page.getByRole('button', { name: `查看文件夹 ${root.path}`, exact: true });
  await sourceFilter.focus();
  await sourceFilter.press('Enter');
  await expect(sourceFilter).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.asset-list .asset-row')).toHaveCount(4);
  expect(sources).toEqual([]);
  expect(waveforms).toEqual([]);

  const filmThumb = page.getByRole('button', { name: '预览 film.mp4', exact: true });
  await expect(filmThumb).toContainText('0:10');
  const performanceMode = page.getByRole('switch', { name: '性能模式', exact: true });
  await expect(performanceMode).toHaveAttribute('aria-checked', 'false');
  const otherTab = await page.context().newPage();
  try {
    await otherTab.goto('/?board=main');
    const otherSwitch = otherTab.getByRole('switch', { name: '性能模式', exact: true });
    await expect(otherSwitch).toBeEnabled();
    await performanceMode.click();
    await expect(performanceMode).toHaveAttribute('aria-checked', 'true');
    await expect(otherSwitch).toHaveAttribute('aria-checked', 'true');
  } finally { await otherTab.close(); }
  await filmThumb.hover();
  // Allow the ordinary hover delay to elapse. Performance mode must leave the cover stationary.
  await page.waitForTimeout(550);
  expect(sources).toEqual([]);
  await expect(filmThumb.locator('video')).toHaveCount(0);
  await filmThumb.click();
  const manualVideo = page.locator('.media-dialog video');
  await manualVideo.evaluate(async (video: HTMLVideoElement) => { await video.play(); });
  await expect.poll(() => time(manualVideo)).toBeGreaterThan(.1);
  await page.getByRole('button', { name: '关闭媒体预览' }).click();
  await performanceMode.click();
  await expect(performanceMode).toHaveAttribute('aria-checked', 'false');

  await filmThumb.hover();
  const hover = filmThumb.locator('video');
  await expect(filmThumb.getByText('静音预览', { exact: true })).toBeVisible();
  expect(await hover.evaluate((player: HTMLVideoElement) => player.muted)).toBe(true);
  await expect.poll(() => time(hover)).toBeGreaterThan(.1);
  const secondThumb = page.getByRole('button', { name: '预览 alternate.mp4', exact: true });
  await secondThumb.hover();
  await expect(secondThumb.getByText('静音预览', { exact: true })).toBeVisible();
  await expect(hover).toHaveCount(0);
  await expect(page.locator('video')).toHaveCount(1);
  await page.locator('[data-canvas-host]').hover({ position: { x: 32, y: 50 } });
  await expect(page.locator('video')).toHaveCount(0);
  await expect(filmThumb.locator('img')).toBeVisible();

  await page.getByRole('button', { name: '播放 sound.wav', exact: true }).click();
  const libraryAudio = page.locator('.asset-list audio');
  await expect.poll(() => time(libraryAudio)).toBeGreaterThan(.1);
  await expect(page.getByRole('img', { name: '音频波形', exact: true })).toBeVisible();
  const peaks = (await api(page, `/media/${audio.id}/waveform?v=${audio.version}`)).peaks as number[];
  expect(peaks.length).toBeLessThanOrEqual(512);
  expect(peaks[0]).toBe(0);
  expect(Math.max(...peaks)).toBeGreaterThan(0);
  const anonymous = await browser.newContext();
  try {
    const waveformUrl = new URL(`/api/v1/media/${audio.id}/waveform`, page.url()).href;
    expect((await anonymous.request.get(waveformUrl)).status()).toBe(401);
  } finally { await anonymous.close(); }
  await page.getByRole('button', { name: '暂停 sound.wav', exact: true }).click();
  await expect.poll(() => libraryAudio.evaluate((player: HTMLAudioElement) => player.paused)).toBe(true);
  await seek(page, page.getByRole('slider', { name: 'sound.wav 播放进度' }), .7);
  await expect.poll(() => time(libraryAudio)).toBeGreaterThan(5);

  const host = page.locator('[data-canvas-host]');
  const rect = (await host.boundingBox())!;
  const count = (await api(page, '/boards/main')).document.items.length;
  for (const [index, asset, x, y] of [[0, video, 85, 120], [1, video2, 445, 110], [2, audio, 475, 505], [3, broken, 85, 400]] as const) {
    await page.getByTestId(`asset-${asset.id}`).getByText(asset.name, { exact: true }).dragTo(host, { targetPosition: { x, y } });
    await expect.poll(async () => (await api(page, '/boards/main')).document.items.length).toBe(count + index + 1);
  }
  const originalBoard = await api(page, '/boards/main');
  const [videoCard, secondCard, audioCard, brokenCard] = originalBoard.document.items.slice(-4);
  expect([videoCard.assetId, secondCard.assetId, audioCard.assetId, brokenCard.assetId]).toEqual([video.id, video2.id, audio.id, broken.id]);
  await expect.poll(() => pictureAspect(page, videoCard.id)).toBeCloseTo(16 / 9, 5);
  await expect.poll(() => pictureAspect(page, secondCard.id)).toBeCloseTo(9 / 16, 5);
  await expect.poll(() => page.evaluate(id => {
    const stage = (window as any).Konva.stages[0];
    return stage.findOne('#' + id)?.findOne('Image')?.image()?.naturalWidth;
  }, videoCard.id)).toBe(1024);
  await expect(page.locator('.canvas-playback video')).toHaveCount(0);
  await playCard(page, videoCard.id);
  const inline = page.locator('.canvas-playback video');
  const controls = page.locator('.canvas-video-playback .inline-playback');
  const expectControlsBelowVideo = async () => {
    await expect.poll(async () => {
      const videoBox = await inline.boundingBox();
      const controlsBox = await controls.boundingBox();
      return !!videoBox && !!controlsBox && controlsBox.y > videoBox.y + videoBox.height &&
        Math.abs(controlsBox.x - videoBox.x) < 1 && Math.abs(controlsBox.width - videoBox.width) < 1;
    }).toBe(true);
  };
  await expect.poll(() => time(inline)).toBeGreaterThan(.1);
  await expectControlsBelowVideo();
  await expect(libraryAudio).toHaveCount(0);
  await expect(page.locator('video,audio')).toHaveCount(1);
  await playCard(page, videoCard.id);
  await expect.poll(() => inline.evaluate((player: HTMLVideoElement) => player.paused)).toBe(true);
  const filmRange = page.getByRole('slider', { name: 'film.mp4 播放进度' });
  await seek(page, filmRange, .62);
  await expect.poll(() => time(inline)).toBeGreaterThan(4);
  expect((await api(page, '/boards/main')).revision).toBe(originalBoard.revision);

  const mountedVideo = await inline.elementHandle();
  await page.mouse.move(rect.x + 115, rect.y + 150);
  await page.mouse.down(); await page.mouse.move(rect.x + 145, rect.y + 177, { steps: 6 }); await page.mouse.up();
  await expect.poll(async () => (await api(page, '/boards/main')).document.items.find((item: any) => item.id === videoCard.id).x).toBeCloseTo(videoCard.x + 30, 0);
  expect(await inline.evaluate((node, first) => node === first, mountedVideo)).toBe(true);
  expect(await inline.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
  await expectControlsBelowVideo();
  await filmRange.hover();
  await page.mouse.wheel(0, -50);
  await expect(page.getByTitle('重置到 100%')).toHaveText('116%');
  expect(await inline.evaluate((node, first) => node === first, mountedVideo)).toBe(true);
  const corner = await page.evaluate(id => {
    const stage = (window as any).Konva.stages[0];
    return stage.find('Transformer').find((node: any) => node.nodes().some((card: any) => card.id() === id))
      .findOne('.bottom-right').getAbsolutePosition();
  }, videoCard.id);
  await page.mouse.move(rect.x + corner.x, rect.y + corner.y);
  await page.mouse.down(); await page.mouse.move(rect.x + corner.x + 18, rect.y + corner.y + 12, { steps: 5 }); await page.mouse.up();
  await expect.poll(async () => (await api(page, '/boards/main')).document.items.find((item: any) => item.id === videoCard.id).width).toBeGreaterThan(videoCard.width);
  await expect.poll(() => pictureAspect(page, videoCard.id)).toBeCloseTo(16 / 9, 5);
  await expectControlsBelowVideo();
  expect(await inline.evaluate((node, first) => node === first, mountedVideo)).toBe(true);
  await mountedVideo?.dispose();

  await playCard(page, videoCard.id);
  await expect.poll(() => inline.evaluate((node: HTMLVideoElement) => node.paused)).toBe(false);
  await page.getByRole('button', { name: '平移工具', exact: true }).click();
  await page.mouse.move(rect.x + 25, rect.y + 24);
  await page.mouse.down(); await page.mouse.move(rect.x + rect.width - 15, rect.y + 24, { steps: 8 }); await page.mouse.up();
  await expect(inline).toHaveCount(0);
  await page.getByRole('button', { name: '选择工具', exact: true }).click();
  await page.keyboard.press('f');
  await playCard(page, videoCard.id);
  await expect.poll(() => time(inline)).toBeGreaterThan(4);
  await playCard(page, secondCard.id);
  await expect(page.locator(`[data-playback-card="${secondCard.id}"] video`)).toHaveCount(1);
  await expect(page.locator('video')).toHaveCount(1);

  await playCard(page, audioCard.id, false);
  const canvasAudio = page.locator('.canvas-playback audio');
  await expect.poll(() => time(canvasAudio)).toBeGreaterThan(.1);
  await expect(page.getByRole('img', { name: '音频波形', exact: true })).toBeVisible();
  await expect(page.locator('video')).toHaveCount(0);
  await seek(page, page.getByRole('slider', { name: 'sound.wav 播放进度' }), .7);
  await expect.poll(() => time(canvasAudio)).toBeGreaterThan(5);
  expect(waveforms).toHaveLength(2); // First playback and the explicit cache/auth check above.

  await playCard(page, brokenCard.id);
  await expect(page.locator('.canvas-playback [role=alert]')).toContainText(/不支持浏览器预览|无法解码/);
  const download = page.getByRole('link', { name: '下载原文件' });
  const downloaded = await page.request.get((await download.getAttribute('href'))!);
  expect(downloaded.headers()['content-disposition']).toContain('attachment');
  const beforeLegacy = await api(page, '/boards/main');
  await api(page, '/boards/main/mutations', {
    clientId: crypto.randomUUID(), mutationId: crypto.randomUUID(), baseRevision: beforeLegacy.revision,
    operations: [{ kind: 'putItem', item: { ...secondCard, width: 320, height: 220 } }],
  });
  const saved = await api(page, '/boards/main');
  await page.reload();
  await expect(page.getByText('已保存到本机', { exact: true })).toBeVisible();
  await expect(page.locator('video,audio')).toHaveCount(0);
  expect((await api(page, '/boards/main')).document).toEqual(saved.document);
  await expect.poll(() => pictureAspect(page, secondCard.id)).toBeCloseTo(9 / 16, 5);
  await playCard(page, audioCard.id, false);
  await expect(page.getByRole('img', { name: '音频波形', exact: true })).toBeVisible();
  expect(readFileSync(sound)).toEqual(originalAudio);
});
