/**
 * Slice 1 of the condition-builder plan (docs/plans/condition-builder.md).
 *
 * Acceptance: when an app form harvests a contact-injected field (the
 * `patient_sex` calculate reading `../inputs/contact/sex`), the unified
 * condition builder's value cell must render as a populated `<select>` of
 * the contact form's choices — NOT a free-text input.
 *
 * The harvest row is the anchor, not the row inside `inputs/contact`: every
 * row in that block is withheld from the field pickers, because `${x}`
 * resolves by name across the whole survey and the block deliberately reuses
 * names from outside it. So the harvest calculate is the only route an
 * author has, and these tests hold it to the same standard.
 *
 * Runs against the committed `client/tests/fixtures/mini-config` project
 * by default (no env export needed).
 */
import { test, expect } from './setup.js';
import type { APIRequestContext, Locator } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(here, 'fixtures', 'mini-config');

test('condition builder — value cell is a populated dropdown for contact-injected `sex` field', async ({
  page,
}) => {
  await page.goto('/');

  // Navigate to the pregnancy form via the Forms list.
  await page.locator('.nav-item', { hasText: 'Forms' }).click();
  await page.getByRole('button', { name: 'pregnancy.xlsx' }).click();

  // Find the `lmp_date` row card. The inputs/contact group above it is
  // collapsed by default in Simple mode, so the row is visible immediately.
  // We discriminate by `code.type-chip-raw` which renders the row's raw
  // XLSForm type — `date` for lmp_date, `calculate` for the inputs rows,
  // `integer` for gravidity.
  const lmpRow = page
    .locator('.survey-row')
    .filter({ has: page.locator('code.type-chip-raw', { hasText: /^date$/ }) });
  await expect(lmpRow).toBeVisible();

  // Expand the advanced fields so the unified condition builder is in the DOM.
  await lmpRow.getByRole('button', { name: /show advanced/ }).click();

  // The build strip lives inside the row's advanced panel.
  const strip = lmpRow.locator('.cond-strip-unified');
  await expect(strip).toBeVisible();

  // Strip is [column ▼] [field ▼] [logic ▼] [value …]. The first three
  // are `.ref-chip-select` in DOM order.
  const dropdowns = strip.locator('.ref-chip-select');
  await dropdowns.nth(0).selectOption('relevant');
  await dropdowns.nth(1).selectOption('patient_sex');
  await dropdowns.nth(2).selectOption('='); // comparison op → needs a value

  // The PR's deliverable: the value cell is a populated <select>,
  // not the free-text `<input class="cond-value-input">` fallback.
  const valueCell = strip.locator(
    'select[title="Pick a value from this field\'s choices"]',
  );
  await expect(valueCell).toBeVisible();
  await expect(
    strip.locator('input.cond-value-input'),
    'free-text fallback must NOT render when contact choices are available',
  ).toHaveCount(0);

  // Choices flow through from contact/person.xlsx → server scan →
  // ProjectInfo.contactFieldChoices → buildFieldChoices merge.
  const optionValues = await valueCell
    .locator('option')
    .evaluateAll((els) =>
      (els as HTMLOptionElement[]).map((o) => o.value).filter((v) => v.length > 0),
    );
  expect(optionValues).toEqual(['male', 'female', 'other']);
});

test('condition builder — fields without any choices source still show free-text input', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('.nav-item', { hasText: 'Forms' }).click();
  await page.getByRole('button', { name: 'pregnancy.xlsx' }).click();

  const lmpRow = page
    .locator('.survey-row')
    .filter({ has: page.locator('code.type-chip-raw', { hasText: /^date$/ }) });
  await lmpRow.getByRole('button', { name: /show advanced/ }).click();

  const strip = lmpRow.locator('.cond-strip-unified');
  const dropdowns = strip.locator('.ref-chip-select');
  await dropdowns.nth(0).selectOption('relevant');
  // `patient_id` harvests `../inputs/contact/_id` — earlier in the survey
  // than `lmp_date`, and no contact form declares `_id` as a select, so it
  // resolves to no choices and the value cell falls back to free text.
  await dropdowns.nth(1).selectOption('patient_id');
  await dropdowns.nth(2).selectOption('=');

  await expect(strip.locator('input.cond-value-input')).toBeVisible();
  await expect(
    strip.locator('select[title="Pick a value from this field\'s choices"]'),
  ).toHaveCount(0);
});

/* ============================ Slice 2.C — group affordance ============================ */
/*
 * Plan §6 locks two Playwright cases:
 *   - "group happy path": build a flat AND chain, click ( group these ),
 *     start a second subgroup with OR, add a clause, save, reload, see
 *     the grouped chip rendering.
 *   - "no-flat-mixed": no UI sequence can write a row.extras value
 *     parsing to isRawFallback=true via builder-introduced mixing.
 * Both run against the committed mini-config fixture.
 */

/** Walk the unified condition builder strip's draft input through one clause. */
async function buildClause(
  strip: Locator,
  field: string,
  op: string,
  value: string,
): Promise<void> {
  const dropdowns = strip.locator('.ref-chip-select');
  await dropdowns.nth(1).selectOption(field);
  await dropdowns.nth(2).selectOption(op);
  // Use the free-text input when the field has no choices (the case for
  // `patient_id`, which harvests `_id` — no contact form declares it as a
  // select, so there is nothing to populate a dropdown from).
  const valueSelect = strip.locator('select[title="Pick a value from this field\'s choices"]');
  if (await valueSelect.count()) {
    await valueSelect.selectOption(value);
  } else {
    await strip.locator('input.cond-value-input').fill(value);
  }
}

test('condition builder — group happy path: build flat AND, group, add OR-joined subgroup, insert, see grouped chips re-rehydrate', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('.nav-item', { hasText: 'Forms' }).click();
  await page.getByRole('button', { name: 'pregnancy.xlsx' }).click();

  // Open the lmp_date row's advanced fields — same anchor as Slice 1 tests.
  const lmpRow = page
    .locator('.survey-row')
    .filter({ has: page.locator('code.type-chip-raw', { hasText: /^date$/ }) });
  await lmpRow.getByRole('button', { name: /show advanced/ }).click();

  const strip = lmpRow.locator('.cond-strip-unified');
  await expect(strip).toBeVisible();

  // Pick column: relevant.
  await strip.locator('.ref-chip-select').nth(0).selectOption('relevant');

  // Build clause 1: ${patient_sex} = 'female' (choices arrive from the
  // contact form, via the harvest calculate's `../inputs/contact/sex`).
  await buildClause(strip, 'patient_sex', '=', 'female');
  await strip.getByRole('button', { name: '+ add another rule' }).click();

  // Build clause 2: ${patient_id} = 'x' — joins by AND-locked (default).
  await buildClause(strip, 'patient_id', '=', 'x');
  await strip.getByRole('button', { name: '+ add another rule' }).click();

  // ( group these ) — collect the two flat clauses into subgroup 1.
  await strip.getByRole('button', { name: '( group these )' }).click();

  // Card stack appears.
  const groupStack = strip.locator('.cond-subgroup-stack');
  await expect(groupStack).toBeVisible();
  await expect(groupStack.locator('.cond-subgroup')).toHaveCount(1);

  // Add a second subgroup joined by "or instead".
  await groupStack
    .locator('.cond-outer-connector')
    .getByRole('button', { name: 'or instead' })
    .click();

  // Now two cards exist, the second is active.
  await expect(groupStack.locator('.cond-subgroup')).toHaveCount(2);
  await expect(
    groupStack.locator('.cond-subgroup').nth(1).locator('.cond-subgroup-header'),
  ).toHaveAttribute('aria-pressed', 'true');

  // Build clause 3 inside subgroup 2.
  await buildClause(strip, 'patient_sex', '=', 'male');
  await strip.getByRole('button', { name: '+ add another rule' }).click();

  // + insert writes the full grouped chain to row.extras.relevant. The
  // reducer immediately rehydrates from the just-written value
  // (`set-column` action with the new existingValue), so the card stack
  // must re-rehydrate from a real parseRelevantGrouped round-trip.
  await strip.getByRole('button', { name: '+ insert' }).click();

  // Two cards still visible after rehydrate (this is the actual proof —
  // the chain made it through serializeAnyParsed → parseRelevantGrouped).
  await expect(groupStack.locator('.cond-subgroup')).toHaveCount(2);
  // Subgroup 1 has its two clauses; subgroup 2 has its one clause.
  await expect(
    groupStack.locator('.cond-subgroup').nth(0).locator('.cond-preview'),
  ).toHaveCount(2);
  await expect(
    groupStack.locator('.cond-subgroup').nth(1).locator('.cond-preview'),
  ).toHaveCount(1);
  // The serialized chain is mirrored in the row's raw `relevant`
  // ExpressionField directly below the strip.
  const relevantField = lmpRow.locator('.expr-field', {
    hasText: 'Show this question when…',
  });
  const rawValue = await relevantField.locator('textarea, input').first().inputValue();
  expect(rawValue).toBe(`(\${patient_sex} = 'female' and \${patient_id} = 'x') or \${patient_sex} = 'male'`);
});

test('condition builder — no UI sequence can write a flat-mixed value (§3.7 structural)', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('.nav-item', { hasText: 'Forms' }).click();
  await page.getByRole('button', { name: 'pregnancy.xlsx' }).click();

  const lmpRow = page
    .locator('.survey-row')
    .filter({ has: page.locator('code.type-chip-raw', { hasText: /^date$/ }) });
  await lmpRow.getByRole('button', { name: /show advanced/ }).click();

  const strip = lmpRow.locator('.cond-strip-unified');
  await strip.locator('.ref-chip-select').nth(0).selectOption('relevant');

  // Build clause 1 (AND-default).
  await buildClause(strip, 'patient_sex', '=', 'female');
  await strip.getByRole('button', { name: '+ add another rule' }).click();

  // The connector picker is disabled after the first commit and its
  // title carries the §10 verbatim warning copy directing the user to
  // ( group these ) instead of allowing flat-mixed.
  const connector = strip.locator('.ref-chip-select[title*="Mixing"]');
  await expect(connector).toBeVisible();
  await expect(connector).toBeDisabled();
  await expect(connector).toHaveAttribute(
    'title',
    /Press \( group these \) to combine rules/,
  );

  // Build a second clause and commit it — connector remains AND-locked.
  await buildClause(strip, 'patient_id', '=', 'x');
  await strip.getByRole('button', { name: '+ add another rule' }).click();

  // + insert; assert the resulting raw `relevant` value DOES NOT carry
  // top-level mixed AND/OR (the only way to mix is via grouped form,
  // which this sequence didn't take).
  await strip.getByRole('button', { name: '+ insert' }).click();
  const relevantField = lmpRow.locator('.expr-field', {
    hasText: 'Show this question when…',
  });
  const rawValue = await relevantField.locator('textarea, input').first().inputValue();
  // No parens (would only appear if grouped) AND no top-level mix.
  expect(rawValue).not.toContain('(');
  expect(rawValue).not.toMatch(/\band\b[^()]*\bor\b|\bor\b[^()]*\band\b/);
});

/* ============== v0.3 — type-aware soft filter + natural-language labels ============== */
/*
 * Plan v0.3 §6 pins six Playwright cases. All anchor on the `gravidity`
 * row (the only `integer` row in the fixture) so `earlierFields` carries
 * a useful variety:
 *   - `patient_sex` (harvest calculate, choice-upgraded via fieldChoices)
 *   - `patient_id` (harvest calculate, no choices → unknown)
 *   - `lmp_date` (date)
 *   - `lmp_note` (note → text)
 *   - `danger_signs` (select_multiple → choice)
 * That mix lets each test verify a different filter direction without
 * adding new fixture rows.
 */

/** Resolve the `gravidity` row card (the only `integer` row). */
function gravidityRow(page: import('@playwright/test').Page) {
  return page
    .locator('.survey-row')
    .filter({ has: page.locator('code.type-chip-raw', { hasText: /^integer$/ }) });
}

/** Read option text values from a <select>, grouped by their <optgroup> label. */
async function optgroupSnapshot(sel: Locator): Promise<Record<string, string[]>> {
  return await sel.evaluate((el) => {
    const out: Record<string, string[]> = {};
    for (const g of el.querySelectorAll('optgroup')) {
      const label = g.getAttribute('label') ?? '';
      out[label] = Array.from(g.querySelectorAll('option')).map((o) => o.getAttribute('value') ?? '');
    }
    return out;
  });
}

test('v0.3 — op-first filtering: picking `is more than` groups date/numeric typical, text+choice atypical, still selectable', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('.nav-item', { hasText: 'Forms' }).click();
  await page.getByRole('button', { name: 'pregnancy.xlsx' }).click();

  const row = gravidityRow(page);
  await row.getByRole('button', { name: /show advanced/ }).click();
  const strip = row.locator('.cond-strip-unified');
  const dropdowns = strip.locator('.ref-chip-select');
  await dropdowns.nth(0).selectOption('relevant');
  // Pick the natural-language label for `>` — option `value` is still `>`.
  await dropdowns.nth(2).selectOption('>');

  const fieldSelect = dropdowns.nth(1);
  const snap = await optgroupSnapshot(fieldSelect);
  // `lmp_date` (date) typical; `patient_id` (unknown) always-pass;
  // `lmp_note` (text) atypical for ordering ops; choice fields
  // (`patient_sex`, danger_signs) atypical too.
  expect(snap['Typical for this check']).toContain('lmp_date');
  expect(snap['Typical for this check']).toContain('patient_id');
  expect(snap['Other fields']).toContain('lmp_note');
  // Atypical field is STILL selectable (never hard-hidden).
  await fieldSelect.selectOption('lmp_note');
  await expect(fieldSelect).toHaveValue('lmp_note');
});

test('v0.3 — field-first ordering: picking date `lmp_date` groups comparison ops Common; all 11 still in DOM', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('.nav-item', { hasText: 'Forms' }).click();
  await page.getByRole('button', { name: 'pregnancy.xlsx' }).click();

  const row = gravidityRow(page);
  await row.getByRole('button', { name: /show advanced/ }).click();
  const strip = row.locator('.cond-strip-unified');
  const dropdowns = strip.locator('.ref-chip-select');
  await dropdowns.nth(0).selectOption('relevant');
  // Pick a date field FIRST so the op picker partitions field-first.
  await dropdowns.nth(1).selectOption('lmp_date');

  const opSelect = dropdowns.nth(2);
  const snap = await optgroupSnapshot(opSelect);
  // All 11 op values must appear somewhere in the DOM (no hiding).
  const all = ([] as string[]).concat(...Object.values(snap));
  for (const op of ['=', '!=', '>', '<', '>=', '<=', 'selected', 'selected-not', 'not', 'ref', 'today']) {
    expect(all).toContain(op);
  }
  // Comparison ordering ops are grouped under "Common operators".
  expect(snap['Common operators']).toContain('>');
  expect(snap['Common operators']).toContain('<');
  expect(snap['Common operators']).toContain('>=');
  expect(snap['Common operators']).toContain('<=');
});

test('v0.3 — Show all fields toggle flattens the field list (escape hatch)', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('.nav-item', { hasText: 'Forms' }).click();
  await page.getByRole('button', { name: 'pregnancy.xlsx' }).click();

  const row = gravidityRow(page);
  await row.getByRole('button', { name: /show advanced/ }).click();
  const strip = row.locator('.cond-strip-unified');
  const dropdowns = strip.locator('.ref-chip-select');
  await dropdowns.nth(0).selectOption('relevant');
  await dropdowns.nth(2).selectOption('>');

  const fieldSelect = dropdowns.nth(1);
  const beforeSnap = await optgroupSnapshot(fieldSelect);
  expect(Object.keys(beforeSnap).length).toBeGreaterThanOrEqual(2);

  // Toggle on — the persistent "Show all fields" label/checkbox.
  await strip.getByRole('checkbox', { name: 'Show all fields' }).check();

  // Now flat list (no optgroups).
  const afterSnap = await optgroupSnapshot(fieldSelect);
  expect(Object.keys(afterSnap)).toHaveLength(0);
});

test('v0.3 — `includes` (selected) narrows field list to choice incl. contact-injected sex', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('.nav-item', { hasText: 'Forms' }).click();
  await page.getByRole('button', { name: 'pregnancy.xlsx' }).click();

  const row = gravidityRow(page);
  await row.getByRole('button', { name: /show advanced/ }).click();
  const strip = row.locator('.cond-strip-unified');
  const dropdowns = strip.locator('.ref-chip-select');
  await dropdowns.nth(0).selectOption('relevant');
  // `selected` is the canonical op value; its dropdown label is `includes value`.
  await dropdowns.nth(2).selectOption('selected');

  const fieldSelect = dropdowns.nth(1);
  const snap = await optgroupSnapshot(fieldSelect);
  // `patient_sex` is choice-upgraded via fieldChoices — its calculation
  // resolves through to the contact form's `sex` select.
  expect(snap['Typical for this check']).toContain('patient_sex');
  expect(snap['Typical for this check']).toContain('danger_signs');
  // Non-choice rows (date, text) appear under "Other fields", still selectable.
  expect(snap['Other fields']).toContain('lmp_date');
});

test('v0.3 — unknown-kind field (`patient_id`) is always-pass: reachable under ordering op `>`', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('.nav-item', { hasText: 'Forms' }).click();
  await page.getByRole('button', { name: 'pregnancy.xlsx' }).click();

  const row = gravidityRow(page);
  await row.getByRole('button', { name: /show advanced/ }).click();
  const strip = row.locator('.cond-strip-unified');
  const dropdowns = strip.locator('.ref-chip-select');
  await dropdowns.nth(0).selectOption('relevant');
  await dropdowns.nth(2).selectOption('>');

  const fieldSelect = dropdowns.nth(1);
  const snap = await optgroupSnapshot(fieldSelect);
  // `patient_id` is a `calculate` whose harvested field has no choices →
  // unknown kind → always-pass.
  expect(snap['Typical for this check']).toContain('patient_id');
});

test('v0.3 — relabeled op dropdown saves byte-identical canonical XPath (no label leakage)', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('.nav-item', { hasText: 'Forms' }).click();
  await page.getByRole('button', { name: 'pregnancy.xlsx' }).click();

  // Use the existing `lmp_date` row anchor for parity with the Slice 2 happy path.
  const lmpRow = page
    .locator('.survey-row')
    .filter({ has: page.locator('code.type-chip-raw', { hasText: /^date$/ }) });
  await lmpRow.getByRole('button', { name: /show advanced/ }).click();
  const strip = lmpRow.locator('.cond-strip-unified');
  await strip.locator('.ref-chip-select').nth(0).selectOption('relevant');

  // Build `${patient_sex} = 'female'` using the relabeled dropdown ("equals value").
  await buildClause(strip, 'patient_sex', '=', 'female');
  await strip.getByRole('button', { name: '+ insert' }).click();

  // The persisted raw XPath uses the canonical `=` token, not "equals".
  const relevantField = lmpRow.locator('.expr-field', {
    hasText: 'Show this question when…',
  });
  const rawValue = await relevantField.locator('textarea, input').first().inputValue();
  expect(rawValue).toBe(`\${patient_sex} = 'female'`);
  expect(rawValue).not.toMatch(/equals|includes|is more than|has an answer/i);
});

/* ====== Punch-list B2 — cancel-safety × start over (QA #1 regression) ====== */
/*
 * Plan v0.2 §3.5: `× start over` clears reducer state only and MUST NOT
 * call setColumn/setExtra. Therefore opening a row with an existing
 * single-clause `relevant`, staging two new clauses (without inserting),
 * pressing `× start over`, and saving the form MUST leave the on-disk
 * `relevant` byte-identical to its original spelling.
 *
 * The proof is at the API/serializer level: we GET the form via the
 * Fastify route before AND after the dance, and compare the persisted
 * `row.extras['relevant']` byte-for-byte. The reducer-level start-over
 * tests (conditionReducer.test.ts) pin the state-shape contract but
 * cannot prove byte-safety — a pure reducer has no write side-effect to
 * assert against.
 *
 * Setup nuance: the committed fixture's lmp_note row carries
 * `${lmp_date} != ''` which the relevant parser maps to the
 * `kind: 'answered'` rule — that rule has no Clause representation, so
 * the reducer's hydrateColumn routes it to raw-fallback (chaining
 * disabled, controls greyed out). We can't drive the dance against
 * lmp_note as-is.
 *
 * Instead we SEED a builder-buildable single-clause relevant on the
 * lmp_date row via the UI first ("setup phase"), save it, capture the
 * persisted bytes, then run the cancel-safety dance against THAT row
 * ("test phase"). The setup-phase save is its own implicit byte-stability
 * check; the test-phase assertion is the actual §3.5 regression guard.
 */
test('punch-list B2 — × start over saves byte-identical row.extras[relevant] (cancel-safety)', async ({
  page,
  request,
}) => {
  // Isolate the save target — never touch the committed fixture even if
  // (especially if) a regression leaks a write through start-over.
  const tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), 'cht-ui-e2e-cancel-'));
  try {
    await fs.cp(FIXTURE_DIR, tmpProject, { recursive: true });

    const opened = await request.post('http://127.0.0.1:5174/api/project/open', {
      data: { path: tmpProject },
    });
    expect(opened.ok()).toBeTruthy();

    /* -------------------------- SETUP PHASE -------------------------- */

    // The lmp_date row starts with NO relevant. Seed a builder-buildable
    // single clause via the UI so we have an "existing single-clause" to
    // exercise the §3.5 contract against.
    await page.goto('/');
    await expect(page.getByText(path.basename(tmpProject)).first()).toBeVisible();
    await page.locator('.nav-item', { hasText: 'Forms' }).click();
    await page.getByRole('button', { name: 'pregnancy.xlsx' }).click();

    const dateRow = page
      .locator('.survey-row')
      .filter({ has: page.locator('code.type-chip-raw', { hasText: /^date$/ }) });
    await dateRow.getByRole('button', { name: /show advanced/ }).click();
    const setupStrip = dateRow.locator('.cond-strip-unified');
    await expect(setupStrip).toBeVisible();
    await setupStrip.locator('.ref-chip-select').nth(0).selectOption('relevant');
    await buildClause(setupStrip, 'patient_sex', '=', 'female');
    await setupStrip.getByRole('button', { name: '+ insert' }).click();

    // Save the seeded relevant.
    await page.locator('.page-header').getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('.rule-builder-card').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      page.locator('.page-header').getByRole('button', { name: 'Saved', exact: true }),
    ).toBeVisible();

    // Capture the persisted byte-string. This is the contract's anchor.
    const before = await readRelevantForLmpDate(request);
    expect(before, 'setup phase must have persisted a non-empty relevant').not.toBe('');

    /* --------------------------- TEST PHASE -------------------------- */

    // Reload from scratch so the lmp_date row's strip rehydrates from
    // the just-saved disk bytes (the existing single-clause we need).
    await page.goto('/');
    await page.locator('.nav-item', { hasText: 'Forms' }).click();
    await page.getByRole('button', { name: 'pregnancy.xlsx' }).click();
    const reloadedDate = page
      .locator('.survey-row')
      .filter({ has: page.locator('code.type-chip-raw', { hasText: /^date$/ }) });
    await reloadedDate.getByRole('button', { name: /show advanced/ }).click();
    const strip = reloadedDate.locator('.cond-strip-unified');
    await expect(strip).toBeVisible();

    // Picking the column rehydrates the existing single-clause into the
    // builder state — no write yet.
    await strip.locator('.ref-chip-select').nth(0).selectOption('relevant');

    // Stage 2 new clauses WITHOUT clicking `+ insert`. Each `+ add another
    // rule` push updates reducer state only; the value column is also
    // reducer-state, never row.extras. (`sex` and `_id` are the only
    // earlierFields reachable for the lmp_date row.)
    await buildClause(strip, 'patient_sex', '=', 'male');
    await strip.getByRole('button', { name: '+ add another rule' }).click();
    await buildClause(strip, 'patient_id', '=', 'x');
    await strip.getByRole('button', { name: '+ add another rule' }).click();

    // Discard. §3.5 contract: zero call to setColumn/setExtra.
    await strip.getByRole('button', { name: '× start over' }).click();

    // §3.5 byte-safety proof, dual signal:
    //
    //   (a) The page-header dirty flag — `Saved` (disabled) means no
    //       setExtra/patch was called by the reducer's start-over. If the
    //       reducer had leaked a write, the button would flip to
    //       `Save` (enabled). This is the in-memory contract guard.
    //
    //   (b) The on-disk bytes — re-reading via the API returns the
    //       setup-phase value verbatim. (Even if (a) somehow lied, we
    //       never invoked the save path after the staging dance, so the
    //       disk bytes remain authoritative.)
    //
    // Both must hold. Together they pin §3.5: a present row.extras key
    // is NEVER mutated as a side-effect of the cancel flow.
    await expect(
      page.locator('.page-header').getByRole('button', { name: 'Saved', exact: true }),
      '× start over must not dirty the form — proves zero setExtra call',
    ).toBeVisible();

    const after = await readRelevantForLmpDate(request);
    expect(after).toBe(before);
  } finally {
    await fs.rm(tmpProject, { recursive: true, force: true });
  }
});

/** Read `row.extras['relevant']` for the `lmp_date` row via the form API.
 *  Returns the empty string when missing — preserves the §3.5 setExtra
 *  delete-on-empty semantics ("absent" and "empty" are indistinguishable
 *  through the serializer). */
async function readRelevantForLmpDate(
  request: APIRequestContext,
): Promise<string> {
  const res = await request.get('http://127.0.0.1:5174/api/forms/app:pregnancy');
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as {
    form: { survey: Array<{ name: string; extras: Record<string, string> }> };
  };
  const row = body.form.survey.find((r) => r.name === 'lmp_date');
  expect(row, 'mini-config fixture must carry lmp_date').toBeTruthy();
  return row!.extras['relevant'] ?? '';
}
