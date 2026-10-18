import { expect, test, type Page } from '@playwright/test';

async function nav(page: Page, label: string) {
  await page.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: label, exact: true }).click();
}

test.describe.configure({ mode: 'serial' });

test('home loads in demo mode and every workspace opens without errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to Voidcraft.Video' })).toBeVisible();
  await expect(page.getByText('Demo mode', { exact: true })).toBeVisible();
  for (const ws of ['AI Video Generator', 'Image to Video', 'Video to Video', 'AI Tools', 'Templates', 'Asset Library', 'Generation History', 'Settings', 'Home']) {
    await nav(page, ws);
    await page.waitForTimeout(250);
  }
  // Project workspaces ask for a project when none is open.
  await nav(page, 'AI Storyboard');
  await expect(page.getByText('No project open').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('create a project, edit the timeline, undo/redo, save and reopen', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await dialog.getByLabel('Project name').fill('E2E Film');
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByLabel('Project name')).toHaveValue('E2E Film');
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();

  // Add a title through the Create menu.
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Title', exact: true }).click();
  await expect(page.getByRole('button', { name: /Clip New title/ })).toBeVisible();
  await expect(page.getByText('Unsaved', { exact: true })).toBeVisible();

  // Undo / redo.
  await page.keyboard.press('Control+z');
  await expect(page.getByRole('button', { name: /Clip New title/ })).toHaveCount(0);
  await page.keyboard.press('Control+Shift+z');
  await expect(page.getByRole('button', { name: /Clip New title/ })).toHaveCount(1);

  // Edit the title text in the inspector.
  await page.getByRole('button', { name: /Clip New title/ }).click();
  const text = page.locator('.panel').filter({ hasText: 'Title' }).getByRole('textbox').first();
  await text.fill('Opening titles');
  await page.keyboard.press('Control+s');
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();

  // Reload: the project and the edit persist.
  await page.reload();
  await expect(page.getByLabel('Project name')).toHaveValue('E2E Film');
  await expect(page.getByRole('button', { name: /Clip Opening titles/ })).toBeVisible();
});

test('generate with the local test renderer, place on timeline and export', async ({ page }) => {
  await page.request.patch('/api/settings', { data: { autosaveSeconds: 5 } });
  await page.goto('/');
  // Open the project from the previous test.
  await page.locator('.list-row', { hasText: 'E2E Film' }).getByRole('button', { name: 'Open' }).click();
  await nav(page, 'AI Video Generator');
  await expect(page.getByRole('combobox', { name: 'Model' })).toHaveValue('local-test::local-test-render');
  await page.getByLabel('Prompt', { exact: true }).fill('A lighthouse on a cliff during a storm');
  await page.getByRole('radiogroup').first().getByRole('radio', { name: '2s', exact: true }).click();
  await page.locator('.prompt-box').getByRole('button', { name: /^Generate/ }).click();
  await expect(page.getByText('Not AI', { exact: true }).first()).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Add to timeline' }).click();
  await expect(page.getByRole('button', { name: /Clip A lighthouse/ })).toBeVisible();

  // Export.
  await page.keyboard.press('Control+e');
  const dlg = page.getByRole('dialog', { name: 'Export video' });
  await dlg.getByRole('button', { name: '720p landscape' }).click();
  await dlg.getByLabel('Quality').selectOption('draft');
  await dlg.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(dlg.getByText('Export complete — file validated with ffprobe.')).toBeVisible({ timeout: 120_000 });
  await expect(dlg.getByText(/1280×720/)).toBeVisible();

  // Leave the edits unsaved but wait until autosave has written the recovery slot.
  const projects = await (await page.request.get('/api/projects')).json();
  const id = projects.find((p: { name: string }) => p.name === 'E2E Film').id;
  await expect.poll(async () => (await (await page.request.get(`/api/projects/${id}/recovery`)).json()) !== null, { timeout: 30_000 }).toBe(true);
});

test('recover autosaved work, then build a storyboard with offline templates', async ({ page }) => {
  await page.goto('/');
  await page.locator('.list-row', { hasText: 'E2E Film' }).getByRole('button', { name: 'Open' }).click();
  // The previous test left autosaved but unsaved edits (generated clip on the timeline).
  const recover = page.getByRole('dialog', { name: 'Recover unsaved work?' });
  await expect(recover).toBeVisible();
  await recover.getByRole('button', { name: 'Restore changes' }).click();
  await expect(page.getByRole('button', { name: /Clip A lighthouse/ })).toBeVisible();
  await page.keyboard.press('Control+s');
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await nav(page, 'AI Storyboard');
  await page.getByPlaceholder(/ronin returns/).fill('A girl finds a glowing key. She opens a hidden door. A dragon wakes up.');
  await page.getByRole('button', { name: 'Propose shot list' }).click();
  await expect(page.getByText(/shots created with offline templates/)).toBeVisible();
  await expect(page.locator('.shot')).toHaveCount(6);
  await page.locator('.shot').first().getByRole('button', { name: 'Edit' }).click();
  const editor = page.getByRole('dialog');
  await editor.getByLabel('Title').first().fill('Opening wide');
  await editor.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByLabel('Shot title').first()).toHaveValue('Opening wide');
  // Reorder via buttons.
  await page.locator('.shot').nth(1).getByRole('button', { name: 'Move left' }).click();
  await expect(page.getByLabel('Shot title').nth(1)).toHaveValue('Opening wide');
});

test('provider settings never expose stored keys', async ({ page }) => {
  await page.goto('/');
  await nav(page, 'Settings');
  const card = page.locator('.card', { hasText: 'Replicate' }).first();
  // Unconfigured AI providers start expanded.
  await card.getByLabel('API token').fill('r8_e2e_secret_token_value_42');
  await card.getByRole('button', { name: /Save & test/ }).click();
  await expect(card.getByText('connected', { exact: false }).first()).toBeVisible();
  await expect(card.getByText(/••••e_42/)).toBeVisible();
  const html = await page.content();
  expect(html).not.toContain('r8_e2e_secret_token_value_42');
  await expect(page.getByText('Demo mode', { exact: true })).toHaveCount(0);
});
