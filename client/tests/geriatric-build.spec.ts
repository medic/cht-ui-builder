/**
 * Geriatric FORMS build-through-the-UI probe (QA / Lorena, 2026-08-06).
 *
 * Empirical answer to "how far can a Playwright driver get building the
 * geriatric-care use case's two app forms purely through the no-code UI?".
 * The static audit (docs/reviews/geriatric-reaudit-2026-08-05.md) says the
 * Integrated Health Assessment is 50-of-52 rows clean; this spec tries to
 * actually author the shapes those rows need and records the wall.
 *
 * Each numbered test is one authoring capability from the geriatric spec.
 * They run in declaration order against ONE temp project (workers:1,
 * fullyParallel:false in playwright.config.ts) and each one saves to disk,
 * so later steps build on earlier state. A failure does NOT skip the rest
 * (deliberately NOT test.describe.configure({mode:'serial'})) — the point
 * is a per-step pass/fail table, not a single green tick.
 *
 * Hermetic: boots nothing of its own beyond the config's webServer pair,
 * copies `fixtures/mini-config` into an OS temp dir and re-points the
 * server at it. No live CHT, no env vars, never touches a real config.
 * NOTE: it does NOT import ./setup.js — that fixture's auto-open would
 * re-point the server at the committed fixture before every test.
 *
 *   pnpm --filter @cht-ui/client exec playwright test geriatric-build.spec.ts --reporter=line
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(here, 'fixtures', 'mini-config');
const API = 'http://127.0.0.1:5174';

/** The geriatric spec's form 1 (Form Overview R1). */
const TITLE = 'Integrated Health Assessment';
const BASENAME = 'integrated_health_assessment';
const FORM_ID = `app:${BASENAME}`;
/** Section header from IHA R4 ("Cognitive decline / memory & orientation"). */
const SECTION_TITLE = 'Cognitive decline';
const SECTION_SLUG = 'cognitive_decline';
/** IHA R4 — the select_one whose Fail choice drives R5/R6/R7 relevance. */
const Q_NAME = 'memory_trouble';

/**
 * STABLE temp path, not `mkdtemp`. Playwright restarts the worker after a
 * failing test, which re-runs `beforeAll` — a fresh mkdtemp there would
 * throw away everything the earlier steps built and every later step would
 * fail for the wrong reason. A stable path + "reset once, in step 1" keeps
 * the chain intact across worker restarts, which is exactly what a
 * stop-on-wall probe needs.
 */
const PROJECT = path.join(os.tmpdir(), 'cht-ui-geri-build');

async function exists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

/** Seed the temp project. `fresh` re-copies from the committed fixture. */
async function ensureProject(fresh: boolean): Promise<void> {
  if (fresh) await fs.rm(PROJECT, { recursive: true, force: true });
  if (!(await exists(PROJECT))) await fs.cp(FIXTURE_DIR, PROJECT, { recursive: true });
}

test.beforeAll(async () => {
  await ensureProject(false);
});

// Every test re-points the server at the temp project (the server holds a
// single global "open project"; another spec in the same run may have moved it).
test.beforeEach(async ({ request }, testInfo) => {
  const res = await request.post(`${API}/api/project/open`, { data: { path: PROJECT } });
  expect(res.ok(), `open ${PROJECT}: ${res.status()}`).toBeTruthy();
  // Diagnostic breadcrumb: the Fastify server holds ONE global open project
  // and (in `pnpm dev`) restarts on source changes, so a concurrent session
  // can steal it. This line is what makes that visible in a failing run.
  console.log(
    `[state] ${testInfo.title.slice(0, 22)} · ${PROJECT} · forms/app = ${(
      await fs.readdir(path.join(PROJECT, 'forms', 'app'))
    ).join(', ')}`,
  );
});

/* ─────────────────────────── helpers ─────────────────────────── */

async function openForm(page: Page): Promise<void> {
  // Re-assert the open project on EVERY navigation. The Fastify server keeps
  // a single global "open project", so a concurrently running spec (or another
  // session's manual run) can steal it mid-test — which surfaces as a
  // confusing "404 Form file missing …/mini-config/…" against the committed
  // fixture. Cheap and idempotent; makes the probe order-independent.
  await page.request.post(`${API}/api/project/open`, { data: { path: PROJECT } });
  await page.goto('/');
  await expect(page.getByText(path.basename(PROJECT)).first()).toBeVisible();
  await page.locator('.nav-item', { hasText: 'Forms' }).click();
  await page.getByRole('button', { name: `${BASENAME}.xlsx` }).click();
  await expect(page.locator('.page-header')).toBeVisible();
}

/** Page-header Save → SaveDiffModal Save → "Saved". */
async function saveForm(page: Page): Promise<void> {
  await page.locator('.page-header').getByRole('button', { name: 'Save', exact: true }).click();
  await page
    .locator('.rule-builder-card')
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await expect(
    page.locator('.page-header').getByRole('button', { name: 'Saved', exact: true }),
  ).toBeVisible({ timeout: 15_000 });
}

/** The saved form as the server re-parses it from disk. */
async function readForm(request: import('@playwright/test').APIRequestContext) {
  const res = await request.get(`${API}/api/forms/${encodeURIComponent(FORM_ID)}`);
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as {
    form: {
      surveyHeaders: { ordered: string[]; labelLocales: string[] };
      choicesHeaders: { ordered: string[]; labelLocales: string[] };
      survey: Array<{
        rowId: string;
        type: string;
        name: string;
        labels: Record<string, string>;
        extras: Record<string, string>;
      }>;
      choices: Array<{ list_name: string; name: string; labels: Record<string, string> }>;
    };
    properties?: { title?: Array<{ locale: string; content: string }>; context?: { expression?: string } };
  };
}

/** A survey row card by the `name` input's value. */
function rowByName(page: Page, name: string) {
  return page.locator('.survey-row').filter({ has: page.locator(`input.name-input[value="${name}"]`) });
}

/* ══════════════════ 1. create the app form (label-first) ══════════════════ */

test('geriatric-build 1 — create the app form label-first; filename is derived', async ({
  page,
  request,
}) => {
  // The one reset per run (see the PROJECT comment).
  await ensureProject(true);
  expect((await request.post(`${API}/api/project/open`, { data: { path: PROJECT } })).ok()).toBeTruthy();

  await page.goto('/');
  await expect(page.getByText(path.basename(PROJECT)).first()).toBeVisible();
  await page.locator('.nav-item', { hasText: 'Forms' }).click();
  await page.getByRole('button', { name: '+ App form' }).click();

  const card = page.locator('.create-form');
  await expect(card).toBeVisible();
  await card.locator('#new-form-title').fill(TITLE);
  // The derived filename is shown BEFORE committing — the no-code contract.
  // Exact match: a leftover form of the same name would also render a
  // collision hint containing this string.
  await expect(
    card.locator('code', { hasText: new RegExp(`^${BASENAME}$`) }),
    'the create dialog must show the derived filename (and no collision suffix)',
  ).toBeVisible();
  await card.getByRole('button', { name: 'Create', exact: true }).click();

  // The editor opens on the new form (the create dialog closes and the
  // Survey tab appears) and the .xlsx is on disk immediately.
  await expect(card).toBeHidden();
  await expect(page.getByRole('button', { name: /^Survey/ }).first()).toBeVisible({
    timeout: 15_000,
  });
  const appDir = await fs.readdir(path.join(PROJECT, 'forms', 'app'));
  expect(appDir, `forms/app after create: ${appDir.join(', ')}`).toContain(`${BASENAME}.xlsx`);
});

/* ═════════════ 2. properties: title + eligibility age >= 60 ═════════════ */

test('geriatric-build 2 — title + "age >= 60" eligibility via the context builder', async ({
  page,
  request,
}) => {
  await openForm(page);
  await page.getByRole('button', { name: 'Properties', exact: true }).click();
  const props = page.locator('.properties-editor');
  await expect(props).toBeVisible();

  // Title (per locale) — `en` row.
  const enTitle = props
    .locator('label.row')
    .filter({ has: page.locator('code.locale-tag', { hasText: /^en$/ }) })
    .locator('input');
  await enTitle.fill(TITLE);

  // Context: available on people + ageInYears(contact) >= 60.
  await page.getByLabel('Available on people').check();
  const ctx = page.locator('.context-builder');
  await ctx.getByRole('button', { name: '+ age', exact: true }).click();
  const ageRow = ctx.locator('.rule-row').last();
  await ageRow.locator('select').first().selectOption('>=');
  await ageRow.locator('input[type="number"]').fill('60');
  await expect(ctx.locator('.preview code')).toContainText('ageInYears(contact) >= 60');

  await saveForm(page);

  const body = await readForm(request);
  expect(body.properties?.context?.expression ?? '').toContain('ageInYears(contact) >= 60');
  expect((body.properties?.title ?? []).some((t) => t.locale === 'en' && t.content === TITLE)).toBe(
    true,
  );
});

/* ═══════════ 3. add a section with "show all on one screen" ═══════════ */

test('geriatric-build 3 — "+ Section" label-first with field-list appearance', async ({
  page,
  request,
}) => {
  await openForm(page);
  await page.getByRole('button', { name: '+ Section' }).click();

  const picker = page.locator('.qtype-modal');
  await expect(picker).toBeVisible();
  await picker.locator('input[placeholder="e.g. Danger signs"]').fill(SECTION_TITLE);
  // Derived slug is shown, not typed.
  await expect(picker.locator('code', { hasText: SECTION_SLUG })).toBeVisible();
  await picker.getByText('Show all questions on one screen').locator('input').check();
  await picker.getByRole('button', { name: 'Add section', exact: true }).click();
  await expect(picker).not.toBeVisible();

  // The section renders as an accordion — but ONLY in Full mode (structural
  // rows are hidden in Simple). Record which mode it needs.
  const simpleAccordion = page.locator('.survey-group-accordion', { hasText: SECTION_SLUG });
  const visibleInSimple = await simpleAccordion.isVisible().catch(() => false);
  test.info().annotations.push({
    type: 'observation',
    description: `section accordion visible in Simple mode: ${visibleInSimple}`,
  });
  console.log(`[observation] section accordion visible in Simple mode: ${visibleInSimple}`);

  await page.getByRole('button', { name: 'Full', exact: true }).click();
  await expect(page.locator('.survey-group-accordion', { hasText: SECTION_SLUG })).toBeVisible();

  await saveForm(page);

  const body = await readForm(request);
  const begin = body.form.survey.find(
    (r) => r.name === SECTION_SLUG && r.type.trim().toLowerCase() === 'begin group',
  );
  const end = body.form.survey.find(
    (r) => r.name === SECTION_SLUG && r.type.trim().toLowerCase() === 'end group',
  );
  expect(begin, 'begin group written').toBeTruthy();
  expect(end, 'matched end group written').toBeTruthy();
  expect(begin!.extras['appearance'] ?? '').toContain('field-list');
  expect(begin!.labels['en']).toBe(SECTION_TITLE);
});

/* ═════════════════════ 4. add the Nepali locale ═════════════════════ */

test('geriatric-build 4 — "+ Add language" → ne adds label::ne to both sheets', async ({
  page,
  request,
}) => {
  await openForm(page);
  const bar = page.locator('.language-chip-bar');
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: '+ Add language' }).click();
  const pop = page.locator('.language-chip-popover');
  await expect(pop).toBeVisible();
  await pop.locator('button', { hasText: 'नेपाली (Nepali)' }).click();
  await expect(pop).toBeHidden();
  await expect(bar.locator('.language-chip', { hasText: 'नेपाली' })).toBeVisible();

  await saveForm(page);

  // Reload: the locale survived to disk as a `label::ne` COLUMN on both
  // sheets (the form was created en-only, so this is the whole delta).
  await openForm(page);
  await expect(bar.locator('.language-chip', { hasText: 'नेपाली' })).toBeVisible();
  const body = await readForm(request);
  expect(body.form.surveyHeaders.labelLocales).toContain('ne');
  expect(body.form.choicesHeaders.labelLocales).toContain('ne');
});

/* ══════ 5. select_one inside the section, EN+NE labels, 3 choices ══════ */

test('geriatric-build 5 — select_one in the section with EN+NE labels and 3 choices', async ({
  page,
  request,
}) => {
  await openForm(page);
  await page.getByRole('button', { name: 'Full', exact: true }).click();

  // Insert INSIDE the section (empty section → "+ Add question").
  const accordion = page.locator('.survey-group-accordion', { hasText: SECTION_SLUG });
  await expect(accordion).toBeVisible();
  const addInside = accordion.getByRole('button', { name: /\+ Add question|\+ add inside/ }).first();
  await addInside.click();

  const picker = page.locator('.qtype-modal');
  await expect(picker).toBeVisible();
  // The question NAME is still typed here (no label-first derive on questions).
  await picker.locator('input[placeholder="e.g. has_fever, patient_age"]').fill(Q_NAME);
  const labelFields = picker.locator('.qtype-labels-field .qtype-locale-label');
  await labelFields
    .filter({ has: page.getByText('label::en', { exact: true }) })
    .locator('input')
    .fill('Do you have trouble remembering things?');
  await labelFields
    .filter({ has: page.getByText('label::ne', { exact: true }) })
    .locator('input')
    .fill('के तपाईंलाई सम्झने कुरामा समस्या छ?');

  // select_one needs a list → the picker advances to configure-list.
  await picker
    .locator('.qtype-tile')
    .filter({ has: page.locator('.qtype-tile-label', { hasText: /^Single choice$|^Select one$/ }) })
    .first()
    .click();
  await expect(picker.getByText(/needs a list of options/)).toBeVisible();

  const choiceRows = picker.locator('.qtype-choice-row');
  const CHOICES: Array<[string, string]> = [
    ['yes_fail', 'Yes (Fail)'],
    ['no_pass', 'No (Pass)'],
    ['dont_know', "Don't know"],
  ];
  await picker.locator('.qtype-choices-edit').getByRole('button', { name: '+ Add choice' }).click();
  await expect(choiceRows).toHaveCount(3);
  for (let i = 0; i < CHOICES.length; i += 1) {
    await choiceRows.nth(i).locator('input').nth(0).fill(CHOICES[i]![0]);
    await choiceRows.nth(i).locator('input').nth(1).fill(CHOICES[i]![1]);
  }
  await picker.getByRole('button', { name: 'Add question', exact: true }).click();
  await expect(picker).not.toBeVisible();

  // NE choice labels: the add-time picker has ONE label column, so the
  // Nepali choice labels have to be filled on the Translate tab.
  await page.getByRole('button', { name: 'Translate' }).click();
  await page.locator('.translate-tab').getByRole('button', { name: /^Choices \(/ }).click();
  const NE = ['छ (फेल)', 'छैन (पास)', 'थाहा छैन'];
  for (let i = 0; i < CHOICES.length; i += 1) {
    const tr = page
      .locator('.translate-grid tr')
      .filter({ has: page.getByText(CHOICES[i]![0], { exact: true }) });
    await expect(tr).toHaveCount(1);
    // Column order = choicesHeaders.labelLocales → [en, ne].
    await tr.locator('textarea').nth(1).fill(NE[i]!);
  }

  // NOTE: the editor tab bar AND the Translate tab's scope switcher both
  // render a "Survey (N)" button — .first() is the editor tab.
  await page.getByRole('button', { name: /^Survey/ }).first().click();
  await saveForm(page);

  const body = await readForm(request);
  const q = body.form.survey.find((r) => r.name === Q_NAME);
  expect(q, 'question row written').toBeTruthy();
  expect(q!.type).toMatch(/^select_one /);
  expect(q!.labels['en']).toContain('remembering');
  expect(q!.labels['ne']).toContain('सम्झने');
  const list = q!.type.trim().split(/\s+/)[1]!;
  const written = body.form.choices.filter((c) => c.list_name === list);
  expect(written.map((c) => c.name)).toEqual(CHOICES.map((c) => c[0]));
  expect(written.map((c) => c.labels['en'])).toEqual(CHOICES.map((c) => c[1]));
  expect(written.map((c) => c.labels['ne'])).toEqual(NE);
  // The question really landed INSIDE the section.
  const idxBegin = body.form.survey.findIndex(
    (r) => r.name === SECTION_SLUG && r.type.trim().toLowerCase() === 'begin group',
  );
  const idxEnd = body.form.survey.findIndex(
    (r) => r.name === SECTION_SLUG && r.type.trim().toLowerCase() === 'end group',
  );
  const idxQ = body.form.survey.findIndex((r) => r.name === Q_NAME);
  expect(idxBegin).toBeLessThan(idxQ);
  expect(idxQ).toBeLessThan(idxEnd);
});

/* ═══ 6. relevance on a following note via the choice-value DROPDOWN ═══ */

test('geriatric-build 6 — note relevance "select = choice" picked from a dropdown, zero typing', async ({
  page,
  request,
}) => {
  await openForm(page);
  await page.getByRole('button', { name: 'Full', exact: true }).click();

  // Add a note inside the same section, after the select.
  const accordion = page.locator('.survey-group-accordion', { hasText: SECTION_SLUG });
  await accordion.getByRole('button', { name: /\+ add inside|\+ Add question/ }).first().click();
  const picker = page.locator('.qtype-modal');
  await picker.locator('input[placeholder="e.g. has_fever, patient_age"]').fill('memory_test_note');
  await picker
    .locator('.qtype-labels-field .qtype-locale-label')
    .filter({ has: page.getByText('label::en', { exact: true }) })
    .locator('input')
    .fill('Conduct a simple memory test');
  await picker
    .locator('.qtype-tile')
    .filter({ has: page.locator('.qtype-tile-label', { hasText: /^Note$/ }) })
    .click();
  await expect(picker).not.toBeVisible();

  // Relevance via the rule builder.
  const noteRow = rowByName(page, 'memory_test_note');
  await noteRow.getByRole('button', { name: /show advanced/ }).click();
  // T9f (#19): the XPath box (and its "✎ build") sits behind the strip's "code" toggle.
  const codeBtn = noteRow
    .locator('.cond-strip-unified[data-column="relevant"]')
    .getByRole('button', { name: 'code', exact: true });
  if (await codeBtn.isVisible().catch(() => false)) await codeBtn.click();
  await noteRow
    .locator('.expr-field', { hasText: 'Show this question when' })
    .locator('button', { hasText: '✎ build' })
    .click();
  const modal = page.locator('.rule-builder-modal');
  await expect(modal).toBeVisible();
  await modal.getByRole('button', { name: '+ comparison' }).click();
  const rule = modal.locator('.rule-row').last();
  await rule.locator('select').first().selectOption(Q_NAME);
  // "string" makes the value a quoted literal — that is what unlocks the
  // choice dropdown for a select_one field.
  const stringToggle = rule.getByRole('checkbox', { name: 'string' });
  if (!(await stringToggle.isChecked())) await stringToggle.check();

  // §1 deliverable: the value cell is a populated dropdown, NOT a text input.
  const valueSelect = rule.locator('select.choice-value-select');
  await expect(valueSelect, 'value cell must be a choice dropdown').toBeVisible();
  await expect(rule.locator('input[placeholder="text value"]')).toHaveCount(0);
  await valueSelect.selectOption('yes_fail');
  await expect(modal.locator('.preview code')).toContainText(`\${${Q_NAME}} = 'yes_fail'`);
  await modal.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(modal).toBeHidden();

  await saveForm(page);
  const body = await readForm(request);
  const note = body.form.survey.find((r) => r.name === 'memory_test_note');
  expect(note!.extras['relevant']).toBe(`\${${Q_NAME}} = 'yes_fail'`);
});

/* ═══ 7. patient name in a note label via insert-contact-field ═══ */

test('geriatric-build 7 — insert a contact field into a label; a hidden harvest calculate appears', async ({
  page,
  request,
}) => {
  await openForm(page);
  await page.getByRole('button', { name: 'Full', exact: true }).click();

  // IHA R2 — "{Person_Name}'s Health Details" note at top level.
  await page.getByRole('button', { name: '+ Question' }).click();
  const picker = page.locator('.qtype-modal');
  await picker.locator('input[placeholder="e.g. has_fever, patient_age"]').fill('health_details');
  await picker
    .locator('.qtype-tile')
    .filter({ has: page.locator('.qtype-tile-label', { hasText: /^Note$/ }) })
    .click();
  await expect(picker).not.toBeVisible();

  const noteRow = rowByName(page, 'health_details');
  const enLabel = noteRow
    .locator('.label-row')
    .filter({ has: page.getByText('label::en', { exact: true }) });
  await enLabel.locator('input').click();
  await enLabel.getByRole('button', { name: '+ insert' }).click();
  const menu = page.locator('.label-insert-ref-menu');
  await expect(menu).toBeVisible();
  // The contact-fields section (auto-adds a hidden calculate).
  await menu.getByRole('menuitem', { name: 'patient_name' }).click();
  await expect(enLabel.locator('input')).toHaveValue(/\$\{patient_name\}/);

  await saveForm(page);
  const body = await readForm(request);
  const harvest = body.form.survey.find(
    (r) =>
      r.type.trim().toLowerCase() === 'calculate' &&
      (r.extras['calculation'] ?? '').trim() === '../inputs/contact/patient_name',
  );
  expect(harvest, 'hidden harvest calculate created').toBeTruthy();
  const note = body.form.survey.find((r) => r.name === 'health_details');
  expect(note!.labels['en']).toContain(`\${${harvest!.name}}`);
});

/* ═════════════ 8. attach a display image to a note ═════════════ */

test('geriatric-build 8 — upload a display image; the file lands in <basename>-media/', async ({
  page,
  request,
}) => {
  await openForm(page);
  await page.getByRole('button', { name: 'Full', exact: true }).click();

  const noteRow = rowByName(page, 'health_details');
  await expect(noteRow).toBeVisible();
  await noteRow.getByRole('button', { name: /show advanced/ }).click();
  const mediaField = noteRow
    .locator('.expr-field')
    .filter({ has: page.locator('code.raw-col-tag', { hasText: 'media::image' }) })
    .first();
  await expect(mediaField).toBeVisible();

  // A 1x1 PNG written to the temp dir, chosen through the hidden file input
  // the "Upload…" button proxies to.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  );
  const pngPath = path.join(os.tmpdir(), `geri-chair-rise-${Date.now()}.png`);
  await fs.writeFile(pngPath, png);
  await mediaField.locator('input[type="file"]').setInputFiles(pngPath);
  const filename = path.basename(pngPath);
  await expect(mediaField.locator('input').first()).toHaveValue(filename, { timeout: 15_000 });

  // The server wrote it under the CHT convention folder BEFORE any save.
  const onDisk = path.join(PROJECT, 'forms', 'app', `${BASENAME}-media`, filename);
  await expect(
    fs
      .access(onDisk)
      .then(() => true)
      .catch(() => false),
  ).resolves.toBe(true);

  await saveForm(page);
  const body = await readForm(request);
  const note = body.form.survey.find((r) => r.name === 'health_details');
  expect(note!.extras['media::image']).toBe(filename);
  await fs.rm(pngPath, { force: true });
});

/* ═════ 9. referral-trigger shape: note shown when EITHER of two failed ═════ */

test('geriatric-build 9 — multi-field OR relevance (the referral-trigger shape)', async ({
  page,
  request,
}) => {
  await openForm(page);
  await page.getByRole('button', { name: 'Full', exact: true }).click();

  // A second select_one so there are two "failed" answers to OR together.
  const accordion = page.locator('.survey-group-accordion', { hasText: SECTION_SLUG });
  await accordion.getByRole('button', { name: /\+ add inside|\+ Add question/ }).first().click();
  let picker = page.locator('.qtype-modal');
  await picker.locator('input[placeholder="e.g. has_fever, patient_age"]').fill('word_recall');
  await picker
    .locator('.qtype-labels-field .qtype-locale-label')
    .filter({ has: page.getByText('label::en', { exact: true }) })
    .locator('input')
    .fill('Now have them repeat these 3 words');
  await picker
    .locator('.qtype-tile')
    .filter({ has: page.locator('.qtype-tile-label', { hasText: /^Single choice$|^Select one$/ }) })
    .first()
    .click();
  // Reuse the existing pass/fail list rather than authoring a second one.
  const reuse = picker.locator('.qtype-list-choice label', { hasText: 'Reuse' }).first();
  await expect(reuse).toBeVisible();
  await reuse.locator('input').check();
  await picker.getByRole('button', { name: 'Add question', exact: true }).click();
  await expect(picker).not.toBeVisible();

  // The referral note: shown when EITHER question failed.
  await accordion.getByRole('button', { name: /\+ add inside|\+ Add question/ }).first().click();
  picker = page.locator('.qtype-modal');
  await picker.locator('input[placeholder="e.g. has_fever, patient_age"]').fill('refer_note');
  await picker
    .locator('.qtype-labels-field .qtype-locale-label')
    .filter({ has: page.getByText('label::en', { exact: true }) })
    .locator('input')
    .fill('Refer for further assessment');
  await picker
    .locator('.qtype-tile')
    .filter({ has: page.locator('.qtype-tile-label', { hasText: /^Note$/ }) })
    .click();
  await expect(picker).not.toBeVisible();

  const noteRow = rowByName(page, 'refer_note');
  await noteRow.getByRole('button', { name: /show advanced/ }).click();
  // T9f (#19): the XPath box (and its "✎ build") sits behind the strip's "code" toggle.
  const codeBtn = noteRow
    .locator('.cond-strip-unified[data-column="relevant"]')
    .getByRole('button', { name: 'code', exact: true });
  if (await codeBtn.isVisible().catch(() => false)) await codeBtn.click();
  await noteRow
    .locator('.expr-field', { hasText: 'Show this question when' })
    .locator('button', { hasText: '✎ build' })
    .click();
  const modal = page.locator('.rule-builder-modal');
  await expect(modal).toBeVisible();
  // "or instead (any rule may match)" is the form-side connector.
  await modal.getByText('or instead (any rule may match)').locator('input').check();
  for (const field of [Q_NAME, 'word_recall']) {
    await modal.getByRole('button', { name: '+ comparison' }).click();
    const rule = modal.locator('.rule-row').last();
    await rule.locator('select').first().selectOption(field);
    // T9c (#16): the rule row also carries the picker's "show technical rows" box.
    const stringToggle = rule.getByRole('checkbox', { name: 'string' });
    if (!(await stringToggle.isChecked())) await stringToggle.check();
    const valueSelect = rule.locator('select.choice-value-select');
    await expect(valueSelect).toBeVisible();
    await valueSelect.selectOption('yes_fail');
  }
  await expect(modal.locator('.preview code')).toContainText(' or ');
  await modal.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(modal).toBeHidden();

  await saveForm(page);
  const body = await readForm(request);
  const note = body.form.survey.find((r) => r.name === 'refer_note');
  expect(note!.extras['relevant']).toContain(`\${${Q_NAME}} = 'yes_fail'`);
  expect(note!.extras['relevant']).toContain("${word_recall} = 'yes_fail'");
  expect(note!.extras['relevant']).toMatch(/\bor\b/);
});

/* ════ 10. cross-form value: context bridge → calculation → label ref ════ */

test('geriatric-build 10 — cross-form value: CS context bridge → calculate → ${ref} in a label', async ({
  page,
  request,
}) => {
  const KEY = 'latest_bmi';

  // (a) Define the bridge in Contact Summary → Context values.
  //
  // GAP (found here, NOT in the static audit): `ReportFieldPicker` sources
  // its form dropdown from the Zustand `forms` slice, which ONLY the Forms
  // index populates on mount. Reached directly after a page load, the
  // source picker therefore has zero form options and falls back to a
  // free-text `field.path` input — the user must hand-type an identifier,
  // and the orphan badges can't fire either. Pinned below, then worked
  // around by visiting Forms first so the rest of the chain is exercised.
  await page.goto('/');
  await page.locator('.nav-item', { hasText: 'Contact summary' }).click();
  await page.getByRole('button', { name: /^Context values/ }).click();
  await page.locator('.cs-context-values').getByRole('button', { name: '+ Add value' }).click();
  const coldCard = page.locator('.cs-context-values .task-card').last();
  await expect(coldCard).toBeVisible();
  await expect(
    coldCard.locator('select.form-picker'),
    'KNOWN GAP: cold-nav to Context values offers no source-form dropdown',
  ).toHaveCount(0);
  await expect(coldCard.locator('input[placeholder="field.path"]')).toBeVisible();

  // Second finding: with the Contact Summary editor dirty, the sidebar nav
  // is inert (clicking "Forms" does nothing, no explanation) — so the
  // work-around below can't be discovered mid-edit either. Reload to drop
  // the throwaway row, THEN prime the store by visiting Forms first.
  await page.locator('.nav-item', { hasText: 'Forms' }).click();
  await expect(page.locator('.cs-context-values'), 'nav blocked while dirty').toBeVisible();

  await page.reload();
  await page.locator('.nav-item', { hasText: 'Forms' }).click();
  await expect(page.getByRole('button', { name: `${BASENAME}.xlsx` })).toBeVisible();
  await page.locator('.nav-item', { hasText: 'Contact summary' }).click();
  await page.getByRole('button', { name: /^Context values/ }).click();
  const values = page.locator('.cs-context-values');
  await expect(values).toBeVisible();
  await values.getByRole('button', { name: '+ Add value' }).click();
  const card = values.locator('.task-card').last();
  const nameInput = card.locator('header input.name-input');
  await nameInput.fill(KEY);
  await nameInput.blur();
  // Source = another form's latest report: pick form, then field.
  const selects = card.locator('select');
  await expect(card.locator('select.form-picker')).toBeVisible();
  await selects.first().selectOption('pregnancy');
  await expect(selects.nth(1)).toBeVisible({ timeout: 15_000 });
  await selects.nth(1).selectOption({ index: 1 });
  await page.locator('.page-header').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.locator('.page-header').getByRole('button', { name: 'Saved', exact: true }),
  ).toBeVisible({ timeout: 15_000 });

  const cs = await request.get(`${API}/api/contact-summary/files`);
  expect(cs.ok()).toBeTruthy();
  const csFiles = (await cs.json()) as Record<string, string>;
  const templated = csFiles['contact-summary.templated.js'] ?? '';
  expect(templated, 'bridge key written into the context object').toContain(KEY);

  // (b) Reference it from a calculate in the form.
  await openForm(page);
  await page.getByRole('button', { name: 'Full', exact: true }).click();
  await page.getByRole('button', { name: '+ Question' }).click();
  const picker = page.locator('.qtype-modal');
  await picker.locator('input[placeholder="e.g. has_fever, patient_age"]').fill('bmi');
  await picker
    .locator('.qtype-tile')
    .filter({ has: page.locator('.qtype-tile-label', { hasText: /^Calculate$/ }) })
    .click();
  await expect(picker).not.toBeVisible();

  const calcRow = rowByName(page, 'bmi');
  await calcRow.getByRole('button', { name: /show advanced/ }).click();
  const calcField = calcRow
    .locator('.expr-field')
    .filter({ has: page.locator('code.raw-col-tag', { hasText: 'calculation' }) });
  await calcField.locator('button', { hasText: 'build' }).click();
  const modal = page.locator('.rule-builder-modal[aria-label="Calculation builder"]');
  await expect(modal).toBeVisible();
  await modal.getByRole('tab', { name: 'Single value' }).click();
  await modal.getByRole('radio', { name: /From another form/ }).click();
  await modal.getByLabel('Cross-form context value').selectOption(KEY);
  await modal.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(calcField.locator('input').first()).toHaveValue(/contact-summary/);

  // (c) Put ${bmi} in a note label via the insert picker.
  await page.getByRole('button', { name: '+ Question' }).click();
  const picker2 = page.locator('.qtype-modal');
  await picker2.locator('input[placeholder="e.g. has_fever, patient_age"]').fill('bmi_note');
  await picker2
    .locator('.qtype-tile')
    .filter({ has: page.locator('.qtype-tile-label', { hasText: /^Note$/ }) })
    .click();
  await expect(picker2).not.toBeVisible();
  const noteRow = rowByName(page, 'bmi_note');
  const enLabel = noteRow
    .locator('.label-row')
    .filter({ has: page.getByText('label::en', { exact: true }) });
  await enLabel.locator('input').fill('Body Mass Index (BMI): ');

  // FRICTION (found here): "+ Question" inserts at `defaultInsertIndex`,
  // which is the start of the trailing depth-0 `calculate` run — so the new
  // note lands ABOVE the `bmi` calculate we just authored, and `${bmi}` is
  // therefore NOT in the note's "earlier fields" insert menu. The author has
  // to reorder before the reference is offerable. One "move up" on the calc.
  await rowByName(page, 'bmi').getByRole('button', { name: 'move up' }).click();

  await enLabel.locator('input').click();
  await enLabel.getByRole('button', { name: '+ insert' }).click();
  await page.locator('.label-insert-ref-menu').getByRole('menuitem', { name: '${bmi}' }).click();
  await expect(enLabel.locator('input')).toHaveValue(/\$\{bmi\}/);

  await saveForm(page);
  const body = await readForm(request);
  const calc = body.form.survey.find((r) => r.name === 'bmi');
  expect(calc!.extras['calculation']).toContain("instance('contact-summary')/context/");
  expect(calc!.extras['calculation']).toContain(KEY);
  const note = body.form.survey.find((r) => r.name === 'bmi_note');
  expect(note!.labels['en']).toContain('${bmi}');
});
