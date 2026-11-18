import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname, '..');
if (process.env.MSHTV_VERIFY_ISOLATED !== '1') throw new Error('Only run after launching with an isolated MSHTV_DATA_DIR; set MSHTV_VERIFY_ISOLATED=1 to confirm. This check adds sample cards.');
const require = createRequire(resolve(root, 'apps/web/package.json'));
const { chromium } = require('@playwright/test');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:5188');
  await page.getByRole('link', { name: '打开画布 自由画布', exact: true }).click();
  await page.getByText('已保存到本机', { exact: true }).waitFor();
  await page.getByRole('button', { name: '添加示例图片', exact: true }).click();
  await page.getByText('已保存到本机', { exact: true }).waitFor();
  await page.getByRole('button', { name: '添加文字备注', exact: true }).click();
  await page.getByText('已保存到本机', { exact: true }).waitFor();
  await page.getByRole('button', { name: '适应全部', exact: true }).click();
  await page.screenshot({ path: resolve(root, '.data/launch-check.png') });
  assert.equal(await page.title(), 'MshTV · 自由画布');
  assert.deepEqual(errors, []);
  console.log('PASS: PowerShell launcher serves built frontend and authenticated API on port 5188.');
} finally { await browser.close(); }
