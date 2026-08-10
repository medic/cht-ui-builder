/**
 * docs/NEXT.md item 8 + W2 — DEFINITION OF DONE.
 *
 * Item 8 makes a task's Title one input per project locale, auto-deriving the
 * `task.<name>.title` key and writing the strings into
 * `translations/messages-<locale>.properties`. W2 adds
 * `upload-custom-translations` to the one-click deploy sequence.
 *
 * Neither half is worth anything alone: without item 8 there are no strings,
 * and without W2 the strings never leave the disk and a CHW reads the raw key.
 * So this spec proves the WHOLE path and asserts the strings ON THE INSTANCE,
 * not on disk — because `upload-custom-translations` has three separate ways
 * to exit 0 having uploaded nothing (no `translations/` dir → `log.warn` and
 * return; an unchanged doc → "not uploaded as no changes were found"; files
 * under `app_settings/forms/translations/`, which cht-conf never reads). A
 * step-count assertion would go green through all three.
 *
 * GATED: needs a live CHT instance, so it only runs under LIVE_DEPLOY=1.
 * Without the flag the whole file skips and CI stays hermetic.
 *
 *   LIVE_DEPLOY=1 pnpm --filter @cht-ui/client exec playwright test \
 *     task-title-i18n-deploy.spec.ts --reporter=line
 *
 * The value carries a per-run NONCE, never the key: the key must stay the
 * stably-derived one (re-deriving it per run would orphan strings, which is
 * the trap item 8 exists to avoid), while a fresh value is what forces
 * cht-conf to detect a real change instead of skipping the upload.
 */
import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import https from 'node:https';

const LIVE = process.env.LIVE_DEPLOY === '1';
const API = 'http://127.0.0.1:5174';
const PARENT = 'W:\\medic\\ui-builder-projects';
const NAME = 'title-i18n-smoke';
const PROJECT = path.join(PARENT, NAME);
const INSTANCE = 'https://127-0-0-1.local-ip.medicmobile.org:10445';

/** Task the author creates. The key derives from the NAME, not the title. */
const TASK_NAME = 'Title i18n smoke';
const TASK_KEY = 'task.title-i18n-smoke.title';
const NONCE = `n${Date.now().toString(36)}`;
const EN = `Title i18n smoke EN ${NONCE}`;
const NE = `शीर्षक जाँच ${NONCE}`;

test.use({ ignoreHTTPSErrors: true });
test.skip(!LIVE, 'needs a live CHT instance — set LIVE_DEPLOY=1');

/** Read a doc straight off the instance as admin. */
function chtGet(pathname: string): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((res, rej) => {
    const r = https.request(
      new URL(INSTANCE + pathname),
      {
        method: 'GET',
        rejectUnauthorized: false,
        headers: { Authorization: 'Basic ' + Buffer.from('medic:password').toString('base64') },
      },
      (x) => {
        let s = '';
        x.on('data', (d) => (s += d));
        x.on('end', () => {
          try {
            res({ status: x.statusCode ?? 0, json: JSON.parse(s || '{}') });
          } catch {
            res({ status: x.statusCode ?? 0, json: { raw: s.slice(0, 300) } });
          }
        });
      },
    );
    r.on('error', rej);
    r.end();
  });
}

test('item 8 + W2 — bilingual task title reaches the INSTANCE via one-click deploy', async ({
  page,
}) => {
  test.setTimeout(1_200_000);

  /* ---------- a fresh CHT-baseline project (ships translations/messages-en) ---------- */
  await fs.rm(PROJECT, { recursive: true, force: true });
  await page.request.post(`${API}/api/project/close`).catch(() => {});
  await page.goto('/');
  await page.getByRole('button', { name: /Create new project/ }).click();
  const wizard = page.locator('.modal-wide');
  await wizard
    .locator('.template-card')
    .filter({ has: page.getByRole('heading', { name: 'CHT baseline' }) })
    .click();
  await wizard.getByRole('button', { name: /Next/ }).click();
  await wizard.locator('.form-row', { hasText: 'Parent folder' }).locator('input').fill(PARENT);
  await wizard.locator('.form-row', { hasText: 'Project name' }).locator('input').fill(NAME);
  await wizard.getByRole('button', { name: /Next/ }).click();
  await wizard.getByRole('button', { name: /Create project/ }).click();
  await expect(page.locator('.nav-item', { hasText: 'Forms' })).toBeVisible({ timeout: 60_000 });

  /* ---------- item 8: the title, typed as STRINGS in two languages ---------- */
  await page.locator('.nav-item', { hasText: 'Tasks' }).click();
  await page.getByRole('button', { name: '+ Add task' }).click();
  const card = page.locator('.task-card').last();

  // Name first — the key derives from it (and only while the seeded key has
  // no strings, which is the case for a task created seconds ago).
  const nameField = card.locator('.expr-field', { hasText: 'name' }).first();
  await nameField.locator('input').first().fill(TASK_NAME);
  await nameField.getByRole('button', { name: 'use this' }).click();

  const titleField = card.locator('.expr-field').filter({ hasText: 'what the CHW sees' }).first();
  await expect(titleField).toBeVisible();
  // cht-default ships ONLY messages-en, so `ne` has to be added — the whole
  // reason the field carries its own "+ language" control instead of sending
  // the author to another screen.
  page.once('dialog', (d) => void d.accept('ne'));
  await titleField.getByRole('button', { name: '+ language' }).click();

  // Match on the locale TAG exactly: `hasText: 'en'` is a case-insensitive
  // substring match and would also hit a row whose typed value contains "en".
  const localeRow = (code: string) =>
    titleField
      .locator('.qtype-locale-label')
      .filter({ has: page.locator('.locale-tag', { hasText: new RegExp(`^${code}$`) }) });
  const enInput = localeRow('en').locator('input');
  const neInput = localeRow('ne').locator('input');
  await enInput.fill(EN);
  await neInput.fill(NE);
  // The author never typed a key, but the derived one is on show.
  await expect(titleField).toContainText(TASK_KEY);

  await page.locator('.page-header').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible({
    timeout: 30_000,
  });

  /* ---------- on disk: the key in tasks.js, the strings in BOTH files ---------- */
  const tasksJs = await fs.readFile(path.join(PROJECT, 'tasks.js'), 'utf8');
  expect(tasksJs, 'tasks.js references the derived key').toContain(`title: '${TASK_KEY}'`);
  expect(tasksJs, 'the literal must NOT be inlined as the title').not.toContain(`title: '${EN}'`);

  const enFile = await fs.readFile(
    path.join(PROJECT, 'translations', 'messages-en.properties'),
    'utf8',
  );
  expect(enFile).toContain(`${TASK_KEY} = ${EN}`);
  // `ne` had no file at all — item 8 created it via the PUT's
  // create-if-missing path, in `translations/` (the ONLY dir cht-conf reads).
  const neFile = await fs.readFile(
    path.join(PROJECT, 'translations', 'messages-ne.properties'),
    'utf8',
  );
  expect(neFile).toContain(`${TASK_KEY} = ${NE}`);

  /* ---------- W2: one-click deploy, now including the translations step ---------- */
  await page.locator('.nav-item', { hasText: 'Deploy' }).click();
  const target = page.locator('.deploy-target');
  await target.locator('input[name="target"]').nth(2).check();
  await target
    .locator('input[placeholder="https://your-instance.medicmobile.org"]')
    .fill(INSTANCE);
  await target.locator('input[placeholder="medic"]').fill('medic');
  await target.locator('input[type="password"]').fill('password');
  await target.getByRole('button', { name: /Test connection/ }).click();
  await expect(target.locator('.deploy-test-result.ok')).toBeVisible({ timeout: 30_000 });

  const oneclick = page.locator('.deploy-oneclick');
  const anyway = oneclick.getByRole('button', { name: 'Deploy anyway' });
  if (await anyway.isVisible().catch(() => false)) await anyway.click();
  // W2 — the step is part of the sequence now, so it must be VISIBLE in the
  // one-click list. Before W2 the author had to know to fire the individual
  // action button, which is the gap this closes.
  await expect(oneclick).toContainText(/custom translations|upload-custom-translations/i);
  await oneclick.getByRole('button', { name: 'Deploy', exact: true }).click();
  await expect(oneclick.locator('.deploy-oneclick-step.state-success')).toHaveCount(7, {
    timeout: 900_000,
  });
  await expect(oneclick.locator('.deploy-oneclick-step.state-fail')).toHaveCount(0);

  /* ---------- THE DEFINITION OF DONE: the strings are on the INSTANCE ---------- */
  const en = await chtGet('/medic/messages-en');
  expect(en.status, 'messages-en doc exists on the instance').toBe(200);
  const enCustom = (en.json as { custom?: Record<string, string> }).custom ?? {};
  expect(enCustom[TASK_KEY], `messages-en.custom['${TASK_KEY}'] on the instance`).toBe(EN);

  const ne = await chtGet('/medic/messages-ne');
  expect(ne.status, 'messages-ne doc exists on the instance').toBe(200);
  const neCustom = (ne.json as { custom?: Record<string, string> }).custom ?? {};
  expect(neCustom[TASK_KEY], `messages-ne.custom['${TASK_KEY}'] on the instance`).toBe(NE);

  // And the task itself shipped, so the key actually resolves to something.
  const settings = await chtGet('/api/v1/settings');
  expect(JSON.stringify(settings.json), 'deployed settings carry the task').toContain(TASK_KEY);
});
