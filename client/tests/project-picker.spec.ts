import { expect, test, type Page } from '@playwright/test';

type Project = {
  id: string;
  name: string;
  source: 'local';
  createdAt: string;
  lastOpenedAt: string;
  exists: boolean;
  path: string;
};

import { URL } from 'node:url';

function tenProjects(): Project[] {
  const now = new Date().toISOString();
  return Array.from({ length: 10 }, (_, index) => {
    const number = index + 1;
    return {
      id: `project-${number}`,
      name: `Project ${number}`,
      source: 'local',
      createdAt: now,
      lastOpenedAt: now,
      exists: number > 6,
      path: `/test/projects/project-${number}`,
    };
  });
}

async function mockDesktopApi(page: Page) {
  let projects = tenProjects();
  const deleted: Array<{ id: string; search: string }> = [];

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const respond = (value: unknown) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(value),
      });

    if (request.method() === 'GET' && url.pathname === '/api/auth/me') {
      return respond({ mode: 'desktop', user: null });
    }
    if (request.method() === 'GET' && url.pathname === '/api/project') {
      return respond({ open: false });
    }
    if (request.method() === 'GET' && url.pathname === '/api/projects') {
      return respond({ mode: 'desktop', projects });
    }

    const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (request.method() === 'DELETE' && projectMatch) {
      const id = decodeURIComponent(projectMatch[1]!);
      deleted.push({ id, search: url.search });
      projects = projects.filter((project) => project.id !== id);
      return respond({ ok: true, removed: true, deletedFiles: false });
    }

    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: `Unexpected test request: ${request.method()} ${url.pathname}` }),
    });
  });

  return { deleted };
}

test('marks missing entries and forgets exactly those entries after a count confirmation', async ({
  page,
}) => {
  const { deleted } = await mockDesktopApi(page);
  let confirmation = '';
  page.once('dialog', async (dialog) => {
    confirmation = dialog.message();
    await dialog.accept();
  });

  await page.goto('/');
  const rows = page.getByTestId('project-list').locator('.project-row');
  const missingRows = page.locator('.project-row.missing');
  await expect(rows).toHaveCount(10);
  await expect(missingRows).toHaveCount(6);
  await expect(missingRows.first()).toHaveCSS('opacity', '0.6');

  await page.getByRole('button', { name: 'Forget all missing' }).click();
  expect(confirmation).toContain('6 missing projects');
  expect(confirmation).toContain('does not delete any project files');

  await expect(rows).toHaveCount(4);
  await expect(missingRows).toHaveCount(0);
  expect(deleted.map(({ id }) => id).sort()).toEqual([
    'project-1',
    'project-2',
    'project-3',
    'project-4',
    'project-5',
    'project-6',
  ]);
  expect(deleted.every(({ search }) => search === '')).toBe(true);
});

test('canceling the count confirmation leaves all project entries untouched', async ({ page }) => {
  const { deleted } = await mockDesktopApi(page);
  page.once('dialog', async (dialog) => dialog.dismiss());

  await page.goto('/');
  const rows = page.getByTestId('project-list').locator('.project-row');
  await expect(rows).toHaveCount(10);
  await page.getByRole('button', { name: 'Forget all missing' }).click();

  await expect(rows).toHaveCount(10);
  expect(deleted).toEqual([]);
});
