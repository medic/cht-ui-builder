/**
 * Browser-level acceptance for hosted, multi-user authoring
 * (docs/plans/hosted-authoring.md §12). Runs under playwright.hosted.config.ts,
 * which boots the server in hosted mode against a throwaway DATA_ROOT and
 * serves the built client from the same origin.
 *
 * What a person with nothing installed actually does:
 *   sign in with CHT credentials → start blank → name it → land in the project → see how to take it
 *   with them. Then the multi-user and multi-tab guarantees the plan makes:
 *   user B sees none of A's projects; two tabs of A hold two different projects.
 *
 * The API-level twin (isolation by every route, zip import/export, zip-slip)
 * is scripts/hosted-acceptance.mjs.
 */
import { expect, test, type Page } from '@playwright/test';

const run = Date.now().toString(36);

/** Sign in as a CHT user on scripts/fake-cht.mjs (password is `<name>-pass`). */
async function signIn(page: Page, username: string) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.locator('#signin-username').fill(username);
  await page.locator('#signin-password').fill(`${username}-pass`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
}

async function startBlank(page: Page, name: string) {
  await page.getByRole('button', { name: /Start blank/ }).click();
  // The wizard skips straight to the name step for "Start blank".
  await page.locator('#new-project-name').fill(name);
  await page.getByRole('button', { name: 'Next →' }).click();
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.locator('.sidebar .project-name')).toHaveText(name);
}

test('sign in with CHT credentials, start blank, land in the project, see how to take it with you', async ({
  page,
}) => {
  await signIn(page, `po-a-${run}`);
  await expect(page.getByText('Nothing yet.')).toBeVisible();

  await startBlank(page, 'Flood response 2026');

  // Overview: no server path is shown, and the way out is visible.
  await expect(page.getByRole('heading', { name: 'Flood response 2026' })).toBeVisible();
  await expect(page.locator('.overview code.path')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Take it with you' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Download zip/ })).toBeVisible();

  // Back to the list: the project is there, attributed to "started blank".
  await page.getByRole('button', { name: 'Change project' }).click();
  const row = page.getByTestId('project-list').locator('.project-row');
  await expect(row).toHaveCount(1);
  await expect(row.first()).toContainText('Flood response 2026');
  await expect(row.first()).toContainText('started blank');

  // Reload: still signed in (token in localStorage), list still there.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  await expect(page.getByTestId('project-list').locator('.project-row')).toHaveCount(1);
});

test('two tabs hold two different projects', async ({ page, context }) => {
  await signIn(page, `po-t-${run}`);
  await startBlank(page, 'First');

  const tab2 = await context.newPage();
  await tab2.goto('/');
  // Same browser, same account (localStorage) — but a fresh tab names no
  // project (sessionStorage), so it lands on the list, not inside "First".
  await expect(tab2.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  await startBlank(tab2, 'Second');

  await expect(tab2.locator('.sidebar .project-name')).toHaveText('Second');
  await expect(page.locator('.sidebar .project-name')).toHaveText('First');
  // And each tab talks to its own project: the forms index of each is empty
  // but distinct — creating a form in tab 2 does not appear in tab 1.
  await tab2.locator('.sidebar').getByRole('button', { name: 'Forms', exact: true }).click();
  await page.locator('.sidebar').getByRole('button', { name: 'Forms', exact: true }).click();
  await expect(tab2.locator('.sidebar .project-name')).toHaveText('Second');
  await expect(page.locator('.sidebar .project-name')).toHaveText('First');
});

test('another user sees none of it', async ({ browser }) => {
  const a = await browser.newContext();
  const pa = await a.newPage();
  await signIn(pa, `po-iso-a-${run}`);
  await startBlank(pa, 'Private to A');

  const b = await browser.newContext();
  const pb = await b.newPage();
  await signIn(pb, `po-iso-b-${run}`);
  await expect(pb.getByText('Nothing yet.')).toBeVisible();
  await expect(pb.getByText('Private to A')).toHaveCount(0);

  await a.close();
  await b.close();
});

test('sign out returns to sign-in and forgets the tab', async ({ page }) => {
  await signIn(page, `po-s-${run}`);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('a CHT user without the required permission is refused, and told why', async ({ page }) => {
  await page.goto('/');
  await page.locator('#signin-username').fill('chw');
  await page.locator('#signin-password').fill('chw-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('.error-banner')).toContainText('can_configure');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});
