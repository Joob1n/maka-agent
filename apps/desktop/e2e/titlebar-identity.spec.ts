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
const CONTENT_PLATE = '.maka-panel-detail';

const ICON_RAIL = '.maka-shell-topbar-rail';

/**
 * The strip's inter-column gap, read from the strip rather than restated: a
 * literal here fails the day `--space-2` is retuned, on a layout that is still
 * internally consistent.
 */
async function titlebarGap(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const strip = document.querySelector('.maka-window-titlebar');
    return strip ? Number.parseFloat(getComputedStyle(strip).columnGap) : Number.NaN;
  });
}

/**
 * Where the breadcrumb sits horizontally, which no static CSS gate can answer.
 *
 * The strip spans the whole window while the shell below it is two columns, so
 * "left-aligned" is ambiguous until something measures it against them. Laid
 * out in normal flow the breadcrumb anchored to the icon rail and landed
 * mid-sidebar — straddling the seam, aligned with neither column.
 *
 * The two sidebar states have DIFFERENT right answers, which is why both are
 * measured. Expanded, the sidebar column is wide and the breadcrumb opens flush
 * with the conversation plate, reading as that plate's heading. Collapsed, the
 * icon rail is wider than the 48px column, so the plate edge runs underneath
 * the icons; the breadcrumb then clears the icons by the strip's own gap. One
 * rule produces both: it starts at whichever is further right.
 */
test('titlebar identity opens at the content plate edge, clearing the icon rail', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const identity = page.locator(IDENTITY);
  await expect(identity).toBeVisible();
  const gap = await titlebarGap(page);

  const measure = async () => {
    const box = await identity.boundingBox();
    const plate = await page.locator(CONTENT_PLATE).boundingBox();
    const rail = await page.locator(ICON_RAIL).boundingBox();
    if (!box || !plate || !rail) throw new Error('titlebar strip not laid out');
    return { left: box.x, plateLeft: plate.x, railRight: rail.x + rail.width };
  };

  const expanded = await measure();
  expect(expanded.left).toBeCloseTo(expanded.plateLeft, 0);
  // Not the degenerate case where the rail happens to end at the same place.
  expect(expanded.plateLeft).toBeGreaterThan(expanded.railRight + gap);

  await page.getByRole('button', { name: '收起侧边栏' }).click();
  await expect(page.locator('[data-sidebar-state="collapsed"]')).toBeVisible();
  // The rail eases its width; settle on the new seam before measuring it.
  await expect
    .poll(async () => (await page.locator(CONTENT_PLATE).boundingBox())?.x ?? 0)
    .toBeLessThan(expanded.plateLeft);

  const collapsed = await measure();
  expect(collapsed.left).toBeCloseTo(collapsed.railRight + gap, 0);
  // Still on the conversation side of the seam, never back over the rail.
  expect(collapsed.left).toBeGreaterThan(collapsed.plateLeft);
});

/**
 * The session name must not read lighter in the titlebar than in the sidebar.
 *
 * Astryx's `supporting` breadcrumb variant — the obvious pick for a 36px strip,
 * and what this shipped as first — renders 12px/400/secondary. That made the
 * window's own statement of which session is open smaller, lighter and greyer
 * than the SAME session's row in the sidebar, and left the project and the
 * session typographically identical, with only the `›` separating them.
 *
 * Computed styles rather than a screenshot: this is a cascade fact, and the
 * regression is a one-word prop change that a pixel baseline would not name.
 */
test('the session name carries the sidebar row’s weight, and the project defers to it', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const type = await page.evaluate(() => {
    const read = (el: Element | null) => {
      if (!el) return null;
      const style = getComputedStyle(el);
      return { size: style.fontSize, weight: style.fontWeight, color: style.color };
    };
    const identity = document.querySelector('[data-maka-contract="titlebar-identity"]');
    return {
      project: read(identity?.querySelector('.maka-titlebar-identity__segment') ?? null),
      session: read(
        identity?.querySelector('.maka-titlebar-identity__segment--session') ?? null,
      ),
      sidebarRow: read(document.querySelector('.astryx-side-nav-item[aria-current="page"]')),
    };
  });

  expect(type.session, JSON.stringify(type)).not.toBeNull();
  expect(type.sidebarRow, JSON.stringify(type)).not.toBeNull();

  // One session, one weight — whichever surface is naming it.
  expect(type.session?.size, JSON.stringify(type)).toBe(type.sidebarRow?.size);
  expect(type.session?.weight, JSON.stringify(type)).toBe(type.sidebarRow?.weight);

  // The pair has an internal hierarchy: the project is the context, not the
  // subject. Same size, lighter weight, quieter ink.
  expect(type.project?.size, JSON.stringify(type)).toBe(type.session?.size);
  expect(Number(type.project?.weight), JSON.stringify(type)).toBeLessThan(
    Number(type.session?.weight),
  );
  expect(type.project?.color, JSON.stringify(type)).not.toBe(type.session?.color);
});

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
  await identity.getByRole('button', { name: /会话 00/ }).click();

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
  await identity.getByRole('button', { name: /会话 00/ }).click();

  const field = identity.getByRole('textbox', { name: '重命名对话' });
  await field.fill('不应该被保存');
  // Escape also blurs the field, and blur commits. React unmounts the input in
  // the same flush, so on this runtime the detached node's blur never lands and
  // the `escapeCancelledRef` guard inside InlineRenameInput is belt-and-braces
  // rather than the thing this line proves; what it does prove is that Escape
  // neither commits directly nor leaves the edit open.
  await field.press('Escape');

  await expect(identity).toContainText('会话 00');
  await expect(identity).not.toContainText('不应该被保存');
});

/**
 * The names a screen reader reads, which the visible text alone does not give.
 *
 * Both crumbs are actions — one opens the project folder, one starts a rename —
 * but their words name a place, so announced bare they are "示例项目, button"
 * and "会话 00, button": nothing says pressing them does anything. The action
 * phrase rides inside the control as visually hidden text, because Astryx
 * spreads unknown props onto the <li> rather than the button.
 */
test('each crumb announces its action, not just its label', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const identity = page.locator(IDENTITY);
  await expect(identity.getByRole('button', { name: '示例项目 打开项目文件夹' })).toBeVisible();
  await expect(identity.getByRole('button', { name: '会话 00 重命名对话' })).toBeVisible();
});

/**
 * A long name must eat its own column, not the window.
 *
 * `min-width: 0` on the outer box alone clamped only that box: the nav and the
 * crumb buttons kept `min-width: auto`, so the text ran on past the clamp —
 * over the workspace actions and out into the strip's DRAG region, where a
 * click on the session name reaches the OS as a window drag. The ellipsis was
 * dead code, because nothing ever handed those elements a smaller size.
 *
 * Measured against the identity's own box, since that box IS the `no-drag`
 * rect: text outside it is text that cannot be clicked.
 */
test('a long session name truncates inside the no-drag rect', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const identity = page.locator(IDENTITY);
  await identity.getByRole('button', { name: /会话 00/ }).click();
  const field = identity.getByRole('textbox', { name: '重命名对话' });
  await field.fill('很长的会话名字'.repeat(20));
  await field.press('Enter');
  await expect(identity).not.toContainText('会话 00');

  const overflow = await page.evaluate(() => {
    const box = document.querySelector('[data-maka-contract="titlebar-identity"]');
    const nav = box?.querySelector('nav');
    const segment = box?.querySelector('.maka-titlebar-identity__segment--session');
    if (!box || !nav || !segment) return null;
    return {
      navRight: nav.getBoundingClientRect().right,
      boxRight: box.getBoundingClientRect().right,
      actionsLeft:
        document.querySelector('.maka-workspace-top-actions')?.getBoundingClientRect().left ?? 0,
      // Truncated, therefore ellipsized: equal widths mean the text fit and
      // the whole chain never engaged.
      clipped: segment.scrollWidth > segment.clientWidth,
    };
  });

  expect(overflow, 'titlebar identity not laid out').not.toBeNull();
  expect(overflow!.navRight).toBeLessThanOrEqual(overflow!.boxRight + 1);
  expect(overflow!.boxRight).toBeLessThanOrEqual(overflow!.actionsLeft + 1);
  expect(overflow!.clipped).toBe(true);
});

/**
 * Clicking away commits, the same way the sidebar's rename does.
 *
 * Every other rename test leaves through Enter or Escape, and both unmount the
 * field in the same flush — so deleting `onBlur` outright left the whole suite
 * green while a user who clicked away was stuck in an edit that never landed.
 */
test('clicking away commits a titlebar rename', async ({ sidebarLongSessionsWindow: page }) => {
  const identity = page.locator(IDENTITY);
  await identity.getByRole('button', { name: /会话 00/ }).click();

  const field = identity.getByRole('textbox', { name: '重命名对话' });
  await field.fill('点击别处也要保存');
  await page.locator(CONTENT_PLATE).click({ position: { x: 40, y: 200 } });

  await expect(identity).toContainText('点击别处也要保存');
  const sidebar = page.getByRole('navigation', { name: '对话列表' });
  await expect(sidebar.getByText('点击别处也要保存')).toBeVisible();
});
