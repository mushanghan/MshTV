import { expect, test } from '@playwright/test';

test('proxied browsers cannot control the Windows clipboard', async ({ page }) => {
  await page.goto('/?board=main');
  await page.getByRole('button', { name: '添加示例图片', exact: true }).click();
  const copy = page.getByRole('button', { name: '复制文件到 Windows 剪贴板', exact: true });
  await expect(copy).toBeDisabled();
  await expect(copy.locator('..')).toHaveAttribute('title', /Windows 后端电脑/);
  expect(await page.evaluate(() => document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true }),
  ))).toBe(true);
  const result = await page.evaluate(async () => {
    const session = await (await fetch('/api/v1/session', { method: 'POST', headers: { 'X-MshTV-Bootstrap': '1' } })).json();
    const response = await fetch('/api/v1/clipboard/files', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf },
      body: JSON.stringify({ revision: 0, itemIds: [], groupIds: [] }),
    });
    return response.status;
  });
  expect(result).toBe(403);
});

test('Ctrl+C and the clipboard button send the saved selection and leave text copying available', async ({ page }) => {
  await page.route('**/api/v1/clipboard/capability', route => route.fulfill({ json: { available: true, reason: null } }));
  const posted: unknown[] = [];
  await page.route('**/api/v1/clipboard/files', route => {
    posted.push(route.request().postDataJSON());
    return route.fulfill({ json: {
      copied: 1, ignored: 1, unavailable: 1, failures: [{ name: '丢失.mp4', reason: '原文件缺失。' }],
    } });
  });
  await page.goto('/?board=main');
  await page.getByRole('button', { name: '添加示例图片', exact: true }).click();
  const copy = page.getByRole('button', { name: '复制文件到 Windows 剪贴板', exact: true });
  await expect(copy).toBeEnabled();
  const title = page.getByRole('textbox', { name: '卡片名称' });
  await title.focus();
  expect(await title.evaluate(input => input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true }),
  ))).toBe(true);
  await title.blur();
  expect(await page.evaluate(() => {
    const selection = window.getSelection()!;
    selection.selectAllChildren(document.querySelector('.brand')!);
    const nativeCopy = document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true }),
    );
    selection.removeAllRanges();
    return nativeCopy;
  })).toBe(true);
  await page.keyboard.press('Control+c');
  await expect(page.getByText('已复制 1 个文件。')).toBeVisible();
  await expect(page.getByText('在 Windows 桌面空白处或目标文件夹内按 Ctrl+V。')).toBeVisible();
  await expect(page.getByText('已略过 1 个文字、示例或占位卡片。')).toBeVisible();
  await expect(page.getByText('丢失.mp4 · 原文件缺失。')).toBeVisible();
  const board = await (await page.request.get('/api/v1/boards/main')).json();
  const selection = { revision: board.revision, itemIds: [board.document.items.at(-1).id], groupIds: [] };
  expect(posted).toEqual([selection]);
  await copy.click();
  await expect.poll(() => posted).toEqual([selection, selection]);
});
