// Use a separately registered -TestPackage installer and a fresh data directory.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '..');
const setup = resolve(process.argv[2]);
assert.match(setup, /MshTV-QA-Setup-[\d.]+-win-x64\.exe$/i);
const upgrade = process.argv[3] ? resolve(process.argv[3]) : setup;
assert.match(upgrade, /MshTV-QA-Setup-[\d.]+-win-x64\.exe$/i);
const legacyBinary = process.argv[4] ? resolve(process.argv[4]) : null;
const fixture = mkdtempSync(join(root, '.data', 'installed-smoke-'));
const install = join(fixture, '应用 程序'), data = join(fixture, '项目 数据'), material = join(fixture, '原片');
mkdirSync(material);
const original = join(material, '原片.png');
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRfgAAAAASUVORK5CYII=', 'base64');
writeFileSync(original, bytes);
const url = 'http://127.0.0.1:5188';
const cleanEnv = { ...process.env, PATH: join(process.env.SystemRoot, 'System32'), DOTNET_ROOT: join(fixture, 'no-global-dotnet'),
  NODE_PATH: '', MSHTV_DATA_DIR: data };
const launcher = join(install, 'MshTV.exe');
const uninstall = join(install, 'unins000.exe');
const installOptions = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/TASKS=desktopicon',
  '/DIR=' + install, '/DATADIR=' + data, '/LOG=' + join(fixture, 'setup.log')];
const { chromium, expect } = createRequire(join(root, 'apps/web/package.json'))('@playwright/test');
let main, browser;

function child(file, args = [], env = cleanEnv, visible = false) {
  return spawn(file, args, { cwd: dirname(file), env, windowsHide: !visible, stdio: ['ignore', 'pipe', 'pipe'] });
}
async function processResult(file, args, env = cleanEnv) {
  const proc = child(file, args, env);
  let output = '';
  proc.stdout.on('data', chunk => { output += chunk; });
  proc.stderr.on('data', chunk => { output += chunk; });
  const [code] = await once(proc, 'close');
  return { code, output };
}
async function run(file, args, env = cleanEnv) {
  const { code, output } = await processResult(file, args, env);
  assert.equal(code, 0, `${file} exited with ${code}: ${output}`);
}
async function until(check, label) {
  for (let i = 0; i < 160; i++) {
    if (await check()) return;
    await delay(200);
  }
  throw new Error('Timed out: ' + label);
}
const health = () => fetch(url + '/api/v1/health', { signal: AbortSignal.timeout(500) }).then(r => r.ok).catch(() => false);
async function legacyFixture(binary) {
  const address = 'http://127.0.0.1:5294';
  const running = () => fetch(address + '/api/v1/health', { signal: AbortSignal.timeout(500) }).then(r => r.ok).catch(() => false);
  assert.equal(await running(), false);
  const process = child(join(root, '.tools/dotnet/dotnet.exe'), [binary, '--webroot', join(root, 'apps/web/dist')], {
    ...cleanEnv, MSHTV_PORT: '5294'
  });
  process.stdout.resume();
  process.stderr.resume();
  let edge, headers;
  try {
    await until(running, 'legacy development server');
    const connection = await fetch(address + '/api/v1/session', { method: 'POST', headers: { Origin: address, 'X-MshTV-Bootstrap': '1' } });
    headers = { Origin: address, Cookie: connection.headers.getSetCookie()[0].split(';')[0],
      'X-CSRF-Token': (await connection.json()).csrf, 'Content-Type': 'application/json' };
    const rootAdded = await fetch(address + '/api/v1/library/roots', { method: 'POST', headers, body: JSON.stringify({ path: material }) });
    assert.equal(rootAdded.status, 200);
    let asset;
    await until(async () => {
      [asset] = (await (await fetch(address + '/api/v1/assets', { headers })).json()).items;
      return asset?.status === 'ready';
    }, 'legacy media indexed');
    edge = await chromium.launch({ channel: 'msedge' });
    const page = await edge.newPage();
    await page.goto(address + '/?board=main');
    await expect(page.getByText('已保存到本机', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '添加文字备注', exact: true }).click();
    await page.getByTestId('asset-' + asset.id).dragTo(page.locator('[data-canvas-host]'), { targetPosition: { x: 400, y: 300 } });
    await expect(page.getByTestId('item-count')).toContainText('2 个元素');
    await expect(page.getByText('已保存到本机', { exact: true })).toBeVisible();
    const snapshot = await (await fetch(address + '/api/v1/boards/main', { headers })).json();
    assert.equal(snapshot.document.items.length, 2);
    return { note: snapshot.document.items.find(item => item.type === 'note').id, asset: asset.id };
  } finally {
    await edge?.close();
    if (process.exitCode === null) {
      const exit = once(process, 'exit');
      if (headers) await fetch(address + '/api/v1/system/shutdown', { method: 'POST', headers }).catch(() => {});
      if (await Promise.race([exit.then(() => false), delay(5000).then(() => true)])) process.kill();
      await exit;
    }
  }
}
const desktop = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
async function ui(action, name = '') {
  const script = `
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $scope = [System.Windows.Automation.TreeScope]::Children
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $pidCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$env:MSHTV_QA_PID)
    $window = $root.FindFirst($scope, $pidCondition)
    if ($env:MSHTV_QA_ACTION -eq 'hidden') {
      if ($window -and -not $window.Current.IsOffscreen) { exit 11 }
      exit 0
    }
    if (-not $window) { exit 11 }
    if ($env:MSHTV_QA_ACTION -eq 'minimized') {
      Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LauncherState {
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
}
'@
      if (-not [LauncherState]::IsIconic([IntPtr]$window.Current.NativeWindowHandle)) { exit 11 }
      exit 0
    }
    if ($env:MSHTV_QA_ACTION -eq 'layout') {
      if ($window.Current.IsOffscreen) { exit 11 }
      Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LauncherTest {
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
}
'@
      $handle = [IntPtr]$window.Current.NativeWindowHandle
      $rect = $window.Current.BoundingRectangle
      if (([LauncherTest]::GetWindowLong($handle, -16) -band 0xC40000) -ne 0) { throw 'Launcher has a system caption or resizable frame.' }
      if ($rect.Width -le 0 -or $rect.Height -le 0 -or [Math]::Abs($rect.Width / $rect.Height - 1.6) -gt 0.008) { throw "Unexpected launcher size: $rect" }
      if ($env:MSHTV_QA_NAME -eq 'launcher-overview.png') {
        $start = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, '启动 MshTV')
        $primary = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $start)
        if (-not $primary -or $primary.Current.BoundingRectangle.Width -lt $rect.Width * 0.21) { throw 'Launcher layout did not scale with DPI.' }
      }
      Add-Type -AssemblyName System.Drawing
      $bitmap = New-Object System.Drawing.Bitmap ([int]$rect.Width), ([int]$rect.Height)
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $dc = $graphics.GetHdc()
        try { if (-not [LauncherTest]::PrintWindow($handle, $dc, 2)) { throw 'Could not capture launcher window.' } }
        finally { $graphics.ReleaseHdc($dc) }
        $bitmap.Save((Join-Path $env:MSHTV_QA_DIR $env:MSHTV_QA_NAME), [System.Drawing.Imaging.ImageFormat]::Png)
      } finally { $graphics.Dispose(); $bitmap.Dispose() }
      exit 0
    }
    if ($env:MSHTV_QA_ACTION -eq 'close') {
      $window.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close()
      exit 0
    }
    $name = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $env:MSHTV_QA_NAME)
    $button = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $name)
    if (-not $button -or -not $button.Current.IsEnabled) { exit 12 }
    if ($env:MSHTV_QA_ACTION -eq 'invoke') { $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
  `;
  const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  const result = await processResult(desktop, args, {
    ...cleanEnv, MSHTV_QA_PID: String(main.pid), MSHTV_QA_NAME: name, MSHTV_QA_ACTION: action, MSHTV_QA_DIR: fixture,
  });
  if (result.code === 0) return true;
  if ([11, 12].includes(result.code)) return false;
  throw new Error(result.output);
}

try {
  assert.equal(await fetch(url + '/api/v1/health', { signal: AbortSignal.timeout(1000) }).then(() => true).catch(() => false), false,
    'The real MshTV host must not occupy the test port.');
  const legacyItem = legacyBinary == null ? null : await legacyFixture(legacyBinary);
  await run(setup, installOptions);
  assert.equal(readFileSync(join(install, 'install-data.txt'), 'utf8'), data);
  const installedManifest = join(install, 'payload.sha256');
  await run(launcher, ['--self-check']);
  const desktopShortcut = await processResult(desktop, ['-NoProfile', '-Command',
    'Test-Path (Join-Path ([Environment]::GetFolderPath("Desktop")) "MshTV-QA.lnk")']);
  assert.match(desktopShortcut.output, /True/i);
  renameSync(installedManifest, installedManifest + '.bak');
  assert.equal((await processResult(launcher, ['--self-check'])).code, 4);
  renameSync(installedManifest + '.bak', installedManifest);
  main = child(launcher, [], cleanEnv, true);
  await until(() => ui('find', '启动 MshTV'), 'native window');
  assert.equal(await health(), false, 'Opening the launcher must leave the service stopped.');
  assert.equal(await ui('invoke', '启动 MshTV'), true);
  await until(health, 'installed backend ready');
  await until(() => ui('find', '打开工作空间'), 'launcher observed server readiness');
  assert.equal((await processResult(launcher, ['--self-check'])).code, 5);
  assert.equal(await ui('close'), true);
  await until(() => ui('hidden'), 'window moved to tray');
  assert.equal(await health(), true);
  await run(launcher, []);
  await until(() => ui('find', '打开工作空间'), 'second launch reveals the existing manager');
  assert.equal(await health(), true);
  const session = await fetch(url + '/api/v1/session', { method: 'POST', headers: { Origin: url, 'X-MshTV-Bootstrap': '1' } });
  assert.equal(session.status, 200);
  const headers = { Origin: url, Cookie: session.headers.getSetCookie()[0].split(';')[0],
    'X-CSRF-Token': (await session.json()).csrf, 'Content-Type': 'application/json' };
  const bundledMedia = existsSync(join(install, 'server', 'media-tools', 'ffmpeg.exe'));
  if (bundledMedia) {
    const response = await fetch(url + '/api/v1/library/tools', { headers });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ffmpeg: true, ffprobe: true });
  }
  if (legacyItem == null) {
    const source = await fetch(url + '/api/v1/library/roots', { method: 'POST', headers, body: JSON.stringify({ path: material }) });
    assert.equal(source.status, 200);
  }
  const asset = async () => (await (await fetch(url + '/api/v1/assets', { headers })).json()).items?.[0];
  await until(async () => {
    const item = await asset();
    return item?.status === 'ready' && (!bundledMedia || item.hasThumbnail && item.hasPreview);
  }, 'watched file indexed and bundled media output generated');
  const assetId = (await asset()).id;
  browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage();
  await page.goto(url + '/?settings=lan');
  await expect(page.getByRole('dialog', { name: '局域网访问' })).toBeVisible();
  await page.goto(url + '/?settings=storage');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.goto(url + '/?board=main');
  await expect(page.getByText('已保存到本机', { exact: true })).toBeVisible();
  if (legacyItem == null) {
    await page.getByRole('button', { name: '添加文字备注', exact: true }).click();
    await expect(page.getByText('已保存到本机', { exact: true })).toBeVisible();
    await page.getByTestId('asset-' + assetId).dragTo(page.locator('[data-canvas-host]'), { targetPosition: { x: 400, y: 300 } });
  } else {
    const board = await (await fetch(url + '/api/v1/boards/main', { headers })).json();
    assert.equal(board.document.items.find(item => item.type === 'note').id, legacyItem.note);
    assert.equal(board.document.items.find(item => item.type === 'image').assetId, legacyItem.asset);
    assert.equal(assetId, legacyItem.asset);
  }
  await expect(page.getByTestId('item-count')).toContainText('2 个元素');
  await expect(page.getByText('已保存到本机', { exact: true })).toBeVisible();
  await browser.close(); browser = null;
  assert.equal(await health(), true, 'Closing the browser must leave the host running.');
  await run(upgrade, installOptions);
  await until(() => main.exitCode !== null && !main.killed, 'in-place installer stopped the launcher');
  assert.equal(await health(), false);
  assert.deepEqual(readFileSync(original), bytes);
  main = child(launcher, [], cleanEnv, true);
  const version = upgrade.match(/Setup-([\d.]+)-win-x64\.exe$/i)[1];
  await until(async () => await ui('find', 'v' + version) || await ui('find', '启动管理中心  ·  ' + version), 'upgraded launcher version');
  if (await ui('find', '维护')) {
    assert.equal(await ui('layout', 'launcher-overview.png'), true);
    assert.equal(await ui('invoke', '维护'), true);
    await until(() => ui('find', '检查环境'), 'maintenance tab');
    assert.equal(await ui('layout', 'launcher-maintenance.png'), true);
    assert.equal(await ui('invoke', '总览'), true);
    assert.equal(await ui('invoke', '最小化'), true);
    await until(() => ui('minimized'), 'custom minimize');
    await run(launcher, []);
    await until(() => ui('find', '启动 MshTV'), 'restore fixed window');
    assert.equal(await ui('invoke', '关闭窗口'), true);
    await until(() => ui('hidden'), 'custom close hides in tray');
    await run(launcher, []);
  }
  await until(() => ui('invoke', '启动 MshTV'), 'launch after in-place install');
  await until(health, 'host restored');
  browser = await chromium.launch({ channel: 'msedge' });
  const restored = await browser.newPage();
  await restored.goto(url + '/?board=main');
  await expect(restored.getByTestId('item-count')).toContainText('2 个元素');
  const resumed = await restored.evaluate(() => fetch('/api/v1/assets').then(response => response.json()));
  assert.equal(resumed.items[0].id, assetId);
  await browser.close(); browser = null;
  await run(uninstall, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']);
  await until(() => main.exitCode !== null, 'uninstaller stopped the launcher');
  assert.equal(await health(), false);
  assert.equal(existsSync(launcher), false);
  assert.ok(existsSync(join(data, 'canvas.db')));
  assert.deepEqual(readFileSync(original), bytes);
  console.log('PASS installed custom Unicode paths, bundled runtime, desktop shortcut, native start, tray, single instance, workspace save/reopen, repairs, and preserving data during uninstall.');
} finally {
  await browser?.close();
  if (main && main.exitCode === null && existsSync(launcher)) await processResult(launcher, ['--close-for-setup']);
  if (existsSync(uninstall)) await processResult(uninstall, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']);
}
