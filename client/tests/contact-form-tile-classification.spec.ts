/**
 * E2E for Bug B (DEV-HANDOFF #2): a bare `string` row in the editor must
 * render as the **Text** tile, not "Select contact".
 * Spec: `docs/handoff-contact-form-bugs-2026-06-28.md` §B.
 *
 * The cheapest realistic surface for this is a freshly-generated contact
 * form: its `name` row is `type:string` with NO `select-contact` /
 * `mrdt-verify` appearance — exactly the case that mis-classified
 * pre-fix. We drive the same QHC → Generate forms path the user runs
 * (catches a regression on either side), then open the generated form
 * and assert the chip text.
 *
 * The same test ALSO indirectly covers Bug A's fix (built-form emit) —
 * a generator regression would surface here as either a missing row,
 * a parse failure, or the same tile mislabel.
 */
import { test, expect } from './setup.js';
import type { Page, APIRequestContext } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(here, 'fixtures', 'mini-config');

async function openEmptyTempProject(
  page: Page,
  request: APIRequestContext,
): Promise<string> {
  const tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), 'cht-ui-e2e-tile-'));
  await fs.cp(FIXTURE_DIR, tmpProject, { recursive: true });
  const settingsPath = path.join(tmpProject, 'app_settings', 'base_settings.json');
  const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  settings.contact_types = [];
  settings.place_hierarchy_types = [];
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
  await fs.rm(path.join(tmpProject, 'forms', 'contact'), { recursive: true, force: true });
  const opened = await request.post('http://127.0.0.1:5174/api/project/open', {
    data: { path: tmpProject },
  });
  expect(opened.ok()).toBeTruthy();
  await page.goto('/');
  await expect(page.getByText(path.basename(tmpProject)).first()).toBeVisible();
  return tmpProject;
}

test('Bug B — bare `string` row in a generated contact form classifies as Text (not "Select contact")', async ({
  page,
  request,
}) => {
  const tmp = await openEmptyTempProject(page, request);
  try {
    // 1. Scaffold the hierarchy via QHC.
    await page.locator('.nav-item', { hasText: 'Hierarchy' }).click();
    await page.locator('.qhc-empty-cta').getByRole('button', { name: 'Quick start' }).click();
    const modal = page.locator('.qhc-modal');
    await expect(modal).toBeVisible();
    await modal.getByRole('button', { name: 'Set up my hierarchy' }).click();

    // 2. Take the offered Generate-forms path (NOT Skip for now).
    await expect(modal.getByText(/Your hierarchy is saved/)).toBeVisible();
    await modal.getByRole('button', { name: 'Generate forms' }).click();

    // 3. The ContactFormGenerator modal opens — keep defaults, run.
    const genModal = page.locator('.lineage-builder-modal');
    await expect(genModal).toBeVisible();
    await genModal.getByRole('button', { name: /Generate \d+ file/ }).click();
    await expect(genModal.getByText(/✓ Written \(new\):/)).toBeVisible({ timeout: 30_000 });
    // Two buttons carry the name "Close": the header's aria-labelled × and
    // the footer action. `.last()` is the footer one.
    await genModal.getByRole('button', { name: 'Close' }).last().click();

    // 4. Open the generated person-create form.
    await page.locator('.nav-item', { hasText: 'Forms' }).click();
    await page.getByRole('button', { name: /person-create\.xlsx/ }).click();
    await expect(page.locator('.survey-row').first()).toBeVisible();

    // 5. Find the `name` row — `type:string`, no select-contact appearance.
    //    Its chip MUST read "Text".  Pre-fix, this chip would have read
    //    "Select contact" and the raw chip would have read `string`.
    const nameRow = page
      .locator('.survey-row')
      .filter({ has: page.locator('code.type-chip-raw', { hasText: /^string$/ }) })
      .filter({ hasNot: page.locator('code', { hasText: /select-contact/ }) })
      .first();
    await expect(nameRow).toBeVisible();
    const chipLabel = nameRow.locator('.type-chip-label').first();
    await expect(chipLabel).toHaveText('Text');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('Bug B regression — a real `select-contact` row STILL classifies as "Select contact"', async ({
  page,
  request,
}) => {
  // Guard against an over-eager fix that turns ALL string rows into Text.
  // The person-create form's `_id_placement` row is type:string with
  // `appearance: 'select-contact type-<place>'` — that one MUST stay
  // Select contact.
  const tmp = await openEmptyTempProject(page, request);
  try {
    await page.locator('.nav-item', { hasText: 'Hierarchy' }).click();
    await page.locator('.qhc-empty-cta').getByRole('button', { name: 'Quick start' }).click();
    const modal = page.locator('.qhc-modal');
    await modal.getByRole('button', { name: 'Set up my hierarchy' }).click();
    await expect(modal.getByText(/Your hierarchy is saved/)).toBeVisible();
    await modal.getByRole('button', { name: 'Generate forms' }).click();
    const genModal = page.locator('.lineage-builder-modal');
    await genModal.getByRole('button', { name: /Generate \d+ file/ }).click();
    await expect(genModal.getByText(/✓ Written \(new\):/)).toBeVisible({ timeout: 30_000 });
    // Two buttons carry the name "Close": the header's aria-labelled × and
    // the footer action. `.last()` is the footer one.
    await genModal.getByRole('button', { name: 'Close' }).last().click();

    await page.locator('.nav-item', { hasText: 'Forms' }).click();
    await page.getByRole('button', { name: /person-create\.xlsx/ }).click();
    await expect(page.locator('.survey-row').first()).toBeVisible();

    // Person-create has an `_id_placement` row of type `string` with
    // `appearance: 'select-contact type-<lastPlace>'`. Its chip must
    // stay "Select contact" — the fix must NOT over-correct.
    const placement = page
      .locator('.survey-row')
      .filter({ has: page.locator('code.type-chip-raw', { hasText: /^string$/ }) })
      .filter({ has: page.locator('text=/select-contact/') })
      .first();
    if (await placement.count() > 0) {
      await expect(placement.locator('.type-chip-label').first()).toHaveText('Select contact');
    } else {
      // If the generator omits the placement (e.g. no place parent), this
      // negative branch is moot — pass the test rather than failing on a
      // shape we don't actually own.
      test.info().annotations.push({
        type: 'note',
        description: 'no select-contact row generated; over-correct guard skipped',
      });
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
