import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname, '..'), url = 'http://127.0.0.1:5188';
let occupied = false; try { await fetch(url + '/api/v1/health'); occupied = true; } catch {}
if (occupied) throw new Error('Port 5188 is busy; refusing to access an existing application.');
mkdirSync(join(root, '.data'), { recursive: true });
const fixture = mkdtempSync(join(root, '.data/launch-library-')), source = join(fixture, 'media'); mkdirSync(source);
const ffmpeg = process.env.MSHTV_FFMPEG_DIR ? join(process.env.MSHTV_FFMPEG_DIR, 'ffmpeg.exe') : 'ffmpeg';
assert.equal(spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=green:s=160x100', '-frames:v', '1', join(source, 'launch.png')], { windowsHide: true }).status, 0);
const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'tools/start.ps1'), '-NoBrowser'], { cwd: root, windowsHide: true, env: { ...process.env, MSHTV_DATA_DIR: join(fixture, 'database') }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; child.stdout.on('data', x => { logs += x; }); child.stderr.on('data', x => { logs += x; });
let browser;
try {
  let ready = false;
  for (let n = 0; n < 200; n++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { ready = (await fetch(url + '/api/v1/health')).ok; } catch {}
    if (ready) break; await new Promise(r => setTimeout(r, 200));
  }
  assert.ok(ready, logs);
  const { chromium } = createRequire(join(root, 'apps/web/package.json'))('@playwright/test');
  browser = await chromium.launch({ channel: process.env.MSHTV_TEST_BROWSER_CHANNEL });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  await page.getByRole('link', { name: '打开画布 自由画布', exact: true }).click();
  await page.getByText('已保存到本机', { exact: true }).waitFor();
  await page.getByRole('button', { name: '管理监控文件夹' }).click();
  await page.getByRole('textbox', { name: 'Windows 后端文件夹路径' }).fill(source);
  await page.getByRole('button', { name: '添加目录', exact: true }).click();
  await page.getByText(source, { exact: true }).waitFor(); await page.getByRole('button', { name: '关闭文件夹管理' }).click();
  await page.getByRole('button', { name: '预览 launch.png', exact: true }).waitFor();
  const row = page.locator('.asset-row').filter({ hasText: 'launch.png' });
  await row.locator('img').waitFor(); await page.waitForFunction(() => !!document.querySelector('.asset-row[draggable=true]'));
  await row.dragTo(page.locator('[data-canvas-host]'), { targetPosition: { x: 350, y: 230 } });
  await page.getByTestId('item-count').filter({ hasText: '1 个元素' }).waitFor();
  await page.getByText('已保存到本机', { exact: true }).waitFor();
  await page.reload(); await page.getByText('已保存到本机', { exact: true }).waitFor();
  await page.getByTestId('item-count').filter({ hasText: '1 个元素' }).waitFor();
  await page.screenshot({ path: join(fixture, 'launched-library.png') });
  unlinkSync(join(source, 'launch.png'));
  await page.locator('.asset-row em').filter({ hasText: '文件缺失' }).waitFor();
  await page.waitForFunction(() => window.Konva?.stages?.[0]?.find('Text').some(node => node.text() === '文件缺失' && node.isVisible()));
  await page.screenshot({ path: join(fixture, 'missing-library.png') });
  assert.equal(await page.title(), 'MshTV · 自由画布'); assert.deepEqual(errors, []);
  console.log('PASS: actual PowerShell launcher builds and serves production library; folder, thumbnail, drag, save, reload and visible missing-card status work. Screenshots: ' + fixture);
} finally {
  await browser?.close();
  if (child.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
}
