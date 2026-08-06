import { test, expect } from './fixtures';

/**
 * The window titlebar states which session is open and which directory it runs
 * in. Both facts were previously unreachable from an open session: the name
 * lived only in the sidebar list, so collapsing that column erased it, and the
 * project lived only in the composer's WorkspacePicker, which stops rendering
 * the moment a session exists.
 *
 * The `sidebar-long-sessions` seed makes both deterministic — its active
 * session is 会话 00, bound to the 示例项目 project record.
 */
const IDENTITY = '[data-maka-contract="titlebar-identity"]';

test('titlebar names the open session and its project, in both sidebar states', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const identity = page.locator(IDENTITY);
  await expect(identity).toContainText('示例项目');
  await expect(identity).toContainText('会话 00');

  // The reason this lives in the titlebar rather than the sidebar: it has to
  // survive the column that used to be its only home.
  await page.getByRole('button', { name: '收起侧边栏' }).click();
  await expect(page.locator('[data-sidebar-state="collapsed"]')).toBeVisible();
  await expect(identity).toContainText('示例项目');
  await expect(identity).toContainText('会话 00');
});

test('renaming from the titlebar reaches storage and the sidebar row', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const identity = page.locator(IDENTITY);
  await identity.getByRole('button', { name: '会话 00' }).click();

  const field = identity.getByRole('textbox', { name: '重命名对话' });
  await expect(field).toBeFocused();
  await field.fill('标题栏改的名字');
  await field.press('Enter');

  // The full round trip: renderer → IPC → storage → session list → both
  // surfaces. Asserting the sidebar too is what proves this wrote through
  // rather than only repainting the titlebar's own state.
  await expect(identity).toContainText('标题栏改的名字');
  const sidebar = page.getByRole('navigation', { name: '对话列表' });
  await expect(sidebar.getByText('标题栏改的名字')).toBeVisible();
});

test('Escape abandons a titlebar rename instead of committing it', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const identity = page.locator(IDENTITY);
  await identity.getByRole('button', { name: '会话 00' }).click();

  const field = identity.getByRole('textbox', { name: '重命名对话' });
  await field.fill('不应该被保存');
  // Escape also blurs the field, and blur commits. Without the guard the
  // cancel would be followed by a commit of the very edit it abandoned.
  await field.press('Escape');

  await expect(identity).toContainText('会话 00');
  await expect(identity).not.toContainText('不应该被保存');
});
