/**
 * E2E for form-data-passing Phase 1a/1b — cross-form references inside a
 * survey condition (relevant / constraint / choice_filter), authored through
 * the RelevantRuleBuilder modal (commit 908ddd9 + adversarial fixes 3126a01).
 *
 * Two new rule kinds let a condition compare against data the form was
 * launched with, without hand-writing XPath:
 *   - contact-input  → `../inputs/contact/<field>`        (Phase 1a)
 *   - contact-summary → `instance('contact-summary')/context/<key>`  (Phase 1b)
 *
 * These had strong shared unit coverage (relevantParser.contact-refs.test.ts)
 * but NO browser coverage. Each test builds the reference in the UI, checks
 * the live preview matches the canonical serialization the shared test pins,
 * then saves → reloads → re-parses from disk (the round-trip invariant) and
 * confirms the clause re-hydrates structurally (not as a raw fallback).
 *
 * Saves go to an isolated temp copy of the committed `mini-config` fixture,
 * which ships a contact form (`../inputs/contact/*`) and a contact-summary
 * with context keys (alive / muted / show_visit_form) — so both kinds are
 * reachable on a fresh clone with no env export.
 *
 * NOTE: Phase 2a (tasks `modifyContent` field mappings, ActionsEditor) is NOT
 * covered here — the mini-config fixture has no `tasks.js`, so the Tasks
 * editor is unreachable. Covering it needs a tasks.js fixture first.
 */
import { test, expect } from './setup.js';
import type { Page, APIRequestContext } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(here, 'fixtures', 'mini-config');

/** A survey row discriminated by the raw type chip it renders. */
function rowByType(page: Page, rawType: RegExp) {
  return page
    .locator('.survey-row')
    .filter({ has: page.locator('code.type-chip-raw', { hasText: rawType }) });
}

/** The `.expr-field` for a given raw column (relevant / calculation / …). */
function exprField(row: ReturnType<typeof rowByType>, column: string, page: Page) {
  return row
    .locator('.expr-field')
    .filter({ has: page.locator('code.raw-col-tag', { hasText: column }) });
}

/** Copy the fixture to a throwaway project, open it, and land on pregnancy. */
async function openPregnancyTemp(page: Page, request: APIRequestContext): Promise<string> {
  const tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), 'cht-ui-e2e-xref-'));
  await fs.cp(FIXTURE_DIR, tmpProject, { recursive: true });
  const opened = await request.post('http://127.0.0.1:5174/api/project/open', {
    data: { path: tmpProject },
  });
  expect(opened.ok()).toBeTruthy();
  await page.goto('/');
  // Guard: the UI is really on the temp project before any save can fire.
  await expect(page.getByText(path.basename(tmpProject)).first()).toBeVisible();
  await page.locator('.nav-item', { hasText: 'Forms' }).click();
  await page.getByRole('button', { name: 'pregnancy.xlsx' }).click();
  await expect(page.locator('.survey-row').first()).toBeVisible();
  return tmpProject;
}

/** Open gravidity's `relevant` rule builder (gravidity is the only integer
 *  row, visible in Simple mode, with an empty relevant to start). */
async function openRelevantBuilderOnGravidity(page: Page) {
  const gravRow = rowByType(page, /^integer$/);
  await gravRow.getByRole('button', { name: /show advanced/ }).click();
  const relField = exprField(gravRow, 'relevant', page);
  // Build button is inside a <label>, so its accessible name is the whole
  // field label — match on visible text instead of role-name.
  // T9f (#19): the XPath box (and its "✎ build") sits behind the strip's "code" toggle.
  const codeBtn = gravRow
    .locator('.cond-strip-unified[data-column="relevant"]')
    .getByRole('button', { name: 'code', exact: true });
  if (await codeBtn.isVisible().catch(() => false)) await codeBtn.click();
  await relField.locator('button', { hasText: 'build' }).click();
  const builder = page.locator('.rule-builder-card').filter({ hasText: 'Rule builder' });
  await expect(builder).toBeVisible();
  return { gravRow, relField, builder };
}

/** Header save → confirm-diff modal → wait for "Saved". */
async function saveForm(page: Page) {
  await page.locator('.page-header').getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.rule-builder-card').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.locator('.page-header').getByRole('button', { name: 'Saved', exact: true }),
  ).toBeVisible();
}

/* ===================== Phase 1a — contact-input reference ===================== */

test('Phase 1a — a contact-input condition (../inputs/contact/) round-trips save → reload', async ({
  page,
  request,
}) => {
  const tmp = await openPregnancyTemp(page, request);
  try {
    const { relField, builder } = await openRelevantBuilderOnGravidity(page);

    await builder.getByRole('button', { name: '+ contact input' }).click();
    await builder.locator('input[placeholder="field name"]').fill('patient_id');
    await builder.locator('input[placeholder="text value"]').fill('x');

    // Live preview matches the canonical serialization pinned by
    // relevantParser.contact-refs.test.ts (`../inputs/contact/<f> = '<v>'`).
    await expect(builder.locator('.preview code')).toHaveText(
      "../inputs/contact/patient_id = 'x'",
    );

    await builder.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(relField.locator('input').first()).toHaveValue(
      "../inputs/contact/patient_id = 'x'",
    );

    await saveForm(page);

    // Reload — the server re-parses the .xlsx from disk.
    await page.goto('/');
    await page.locator('.nav-item', { hasText: 'Forms' }).click();
    await page.getByRole('button', { name: 'pregnancy.xlsx' }).click();
    await expect(page.locator('.survey-row').first()).toBeVisible();

    const reGrav = rowByType(page, /^integer$/);
    await reGrav.getByRole('button', { name: /show advanced/ }).click();
    const reRel = exprField(reGrav, 'relevant', page);
    await expect(reRel.locator('input').first()).toHaveValue(
      "../inputs/contact/patient_id = 'x'",
    );

    // Re-hydrates STRUCTURALLY (not raw): reopening the builder shows the
    // contact-input field cell populated, proving the parser round-trips the
    // cross-form ref into its rule kind rather than a raw fallback.
    await reRel.locator('button', { hasText: 'build' }).click();
    const reBuilder = page.locator('.rule-builder-card').filter({ hasText: 'Rule builder' });
    await expect(
      reBuilder.locator('input[list="rule-builder-contact-input-fields"]'),
    ).toHaveValue('patient_id');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

/* =================== Phase 1b — contact-summary reference =================== */

test("Phase 1b — a contact-summary condition (instance('contact-summary')/context/) round-trips", async ({
  page,
  request,
}) => {
  const tmp = await openPregnancyTemp(page, request);
  try {
    const { relField, builder } = await openRelevantBuilderOnGravidity(page);

    // The "+ contact-summary" button only shows when the project has context
    // keys; mini-config's contact-summary.templated.js defines three. Those
    // keys arrive via an async cross-fetch (useContactSummaryContextKeys), so
    // wait for the button rather than racing the fetch on a cold server.
    const csButton = builder.getByRole('button', { name: '+ contact-summary' });
    await expect(csButton).toBeVisible({ timeout: 15_000 });
    await csButton.click();
    // docs/NEXT.md item 5 — the context key is a PICKER now, not free text.
    // `show_visit_form` is a real key in the fixture's contact-summary, so
    // it is a normal option; selecting it is the zero-typing path.
    await builder.locator('select.context-key-select').selectOption('show_visit_form');
    await builder.locator('input[placeholder="text value"]').fill('true');

    await expect(builder.locator('.preview code')).toHaveText(
      "instance('contact-summary')/context/show_visit_form = 'true'",
    );

    await builder.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(relField.locator('input').first()).toHaveValue(
      "instance('contact-summary')/context/show_visit_form = 'true'",
    );

    await saveForm(page);

    await page.goto('/');
    await page.locator('.nav-item', { hasText: 'Forms' }).click();
    await page.getByRole('button', { name: 'pregnancy.xlsx' }).click();
    await expect(page.locator('.survey-row').first()).toBeVisible();

    const reGrav = rowByType(page, /^integer$/);
    await reGrav.getByRole('button', { name: /show advanced/ }).click();
    const reRel = exprField(reGrav, 'relevant', page);
    await expect(reRel.locator('input').first()).toHaveValue(
      "instance('contact-summary')/context/show_visit_form = 'true'",
    );

    // Re-hydrates structurally: the context-key cell is repopulated.
    await reRel.locator('button', { hasText: 'build' }).click();
    const reBuilder = page.locator('.rule-builder-card').filter({ hasText: 'Rule builder' });
    await expect(reBuilder.locator('select.context-key-select')).toHaveValue('show_visit_form');
    // A defined key must NOT be flagged as orphaned.
    await expect(reBuilder.getByText('not defined')).toBeHidden();
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
