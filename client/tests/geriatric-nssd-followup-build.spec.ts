/**
 * NSSD GERIATRIC BUILD — Phase 1, form 2: `geriatric_referral_followup`,
 * built from scratch through the no-code UI directly inside config-nssd/chis.
 * See geriatric-nssd-build.spec.ts (form 1) for the shared context and the
 * documented inputs-block hand-edit, reused verbatim here.
 *
 * CONVENTION CHOICE (documented, not a silent shortcut): NSSD has two valid
 * placements for the receiver nodes that carry task-delivered data into a
 * form (docs/nssd-build-protocol.md, "B2 — the receiver-node affordance"):
 *   (a) newest/dominant (12 of 20 keys) — a top-level hidden row with
 *       `instance::tag = hidden`, named `<field>_ctx`, after the
 *       patient_uuid/patient_id/patient_name calculates.
 *   (b) older (8 of 20 keys) — a hidden row INSIDE the `inputs` group,
 *       same name as the source field.
 * The tool has no UI path to set `instance::tag` on a new row (confirmed by
 * reading FormEditor.tsx — "Raw column overrides" only edits extras a row
 * ALREADY has, never adds a new key) — (a) is not no-code-buildable today.
 * (b) IS: "+ add inside" on the `inputs` accordion is a proven, working
 * no-code affordance. Per the standing instruction to build everything
 * possible through no-code and hand-edit+document only where it can't
 * reach, this form uses (b). Documented product gap: the editor should
 * support authoring `instance::tag` receiver nodes so (a) becomes available
 * too — see the hand-edits/limitations doc.
 *
 * Run:
 *   pnpm --filter @cht-ui/shared build
 *   pnpm --filter @cht-ui/client exec playwright test geriatric-nssd-followup-build.spec.ts --reporter=line
 *
 * Safety: after this run, `git -C W:/medic/config-nssd diff --stat` must
 * show ONLY this form's three new files (plus form-constants.js, already
 * corrected once for form 1's shape bug — expect the same bug to recur and
 * needs the same fix). Revert any collateral changes immediately.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  REFER_FLAGS, FOLLOWUP_ROWS,
  ensureFullMode, rowByName, saveForm, readForm,
  createAppForm, addRow, openProjectAt,
} from './helpers/geriatric.js';
import { PROJECT_PATH } from './setup.js';

// Project under test. Defaults to the committed fixture so a fresh clone runs;
// set CHT_PROJECT (or PLAYWRIGHT_PROJECT_PATH) to drive a real cht-conf project.
const PROJECT = process.env.CHT_PROJECT ?? PROJECT_PATH;
const FOLLOWUP_TITLE = 'Geriatric Referral Followup';
const FOLLOWUP = 'geriatric_referral_followup';
const FOLLOWUP_FORM_ID = `app:${FOLLOWUP}`;
const SLOW = process.env.DEMO ? Number(process.env.DEMO_MS ?? '500') : 0;

test.use({
  video: { mode: 'on', size: { width: 2560, height: 1440 } },
  viewport: { width: 2560, height: 1440 },
  launchOptions: { slowMo: SLOW },
});

async function beat(page: Page, ms: number): Promise<void> {
  if (SLOW) await page.waitForTimeout(ms);
}

/** Same documented hand-edit as form 1 — see geriatric-nssd-build.spec.ts
 *  header for the full rationale (pyxform's `_id`-needs-a-label
 *  requirement, NSSD's literal "NO_LABEL" convention). */
async function fixInputsBlockToNssdConvention(formBasename: string): Promise<void> {
  const m = await import('file:///W:/medic/ui-builder-for-cht/shared/dist/index.js' as string);
  const p = path.join(PROJECT, 'forms', 'app', `${formBasename}.xlsx`);
  const form = await m.parseXlsForm(await fs.readFile(p));
  const s: Array<{ rowId: string; type: string; name: string; labels: Record<string, string>; required?: string; extras: Record<string, string> }> = form.survey;

  const iBegin = s.findIndex((r) => r.name === 'inputs' && /^begin group/.test(r.type.trim()));
  let depth = 0;
  let iEnd = -1;
  for (let i = iBegin; i < s.length; i += 1) {
    const t = s[i]!.type.trim();
    if (/^begin[ _]group/.test(t)) depth += 1;
    else if (/^end[ _]group/.test(t)) { depth -= 1; if (depth === 0) { iEnd = i; break; } }
  }
  if (iBegin < 0 || iEnd < 0) throw new Error('inputs group not found in scaffold');

  const mk = (type: string, name: string, extras: Record<string, string> = {}, en = '', ne = '') => ({
    rowId: `nssd_inputs_${name}_${type.replace(/\s+/g, '_')}`,
    type, name, labels: { en, ne }, extras,
  });
  const nssdInputs = [
    mk('begin group', 'inputs', { relevant: "./source = 'user'", appearance: 'field-list' }),
    mk('hidden', 'source', { default: 'user' }, 'Source', 'Source'),
    mk('hidden', 'source_id', {}, 'Source ID', 'Source ID'),
    mk('begin group', 'contact', {}, 'Contact', 'Contact'),
    mk('db:person', '_id', { appearance: 'db-object' }, 'NO_LABEL', 'NO_LABEL'),
    mk('hidden', 'name', {}, 'NO_LABEL', 'NO_LABEL'),
    mk('hidden', 'patient_id', {}, 'NO_LABEL', 'NO_LABEL'),
    mk('hidden', 'date_of_birth', {}, 'NO_LABEL', 'NO_LABEL'),
    mk('end group', 'contact'),
    mk('end group', 'inputs'),
  ];
  s.splice(iBegin, iEnd - iBegin + 1, ...nssdInputs);

  const calcStart = s.findIndex((r) => r.name === 'patient_uuid');
  let calcEnd = calcStart;
  while (calcEnd < s.length && ['patient_uuid', 'patient_id', 'created_by', 'created_by_person_uuid'].includes(s[calcEnd]!.name)) {
    calcEnd += 1;
  }
  const nssdCalcs = [
    { rowId: 'nssd_calc_patient_uuid', type: 'calculate', name: 'patient_uuid', labels: { en: '', ne: '' }, extras: { calculation: '../inputs/contact/_id' } },
    { rowId: 'nssd_calc_patient_name', type: 'calculate', name: 'patient_name', labels: { en: '', ne: '' }, extras: { calculation: '../inputs/contact/name' } },
    { rowId: 'nssd_calc_patient_id', type: 'calculate', name: 'patient_id', labels: { en: '', ne: '' }, extras: { calculation: '../inputs/contact/_id' } },
  ];
  s.splice(calcStart, calcEnd - calcStart, ...nssdCalcs);

  await fs.writeFile(p, await m.serializeXlsForm(form));
}

/** Hand-edit #2 (documented) — see call site. Moves the refer_* receiver
 *  rows from wherever "+ add inside" nested them (the innermost existing
 *  group) to direct children of `inputs`, matching the shape CHT's
 *  content.<key> binding requires. */
async function relocateReceiverRowsToDirectInputsChildren(): Promise<void> {
  const m = await import('file:///W:/medic/ui-builder-for-cht/shared/dist/index.js' as string);
  const p = path.join(PROJECT, 'forms', 'app', `${FOLLOWUP}.xlsx`);
  const form = await m.parseXlsForm(await fs.readFile(p));
  const isReceiver = (r: { name: string; type: string }) => /^refer_/.test(r.name) && r.type.trim() === 'hidden';
  const moved = form.survey.filter(isReceiver);
  form.survey = form.survey.filter((r: { name: string; type: string }) => !isReceiver(r));
  const s = form.survey;
  const iBegin = s.findIndex((r: { name: string; type: string }) => r.name === 'inputs' && /^begin group/.test(r.type.trim()));
  let depth = 0;
  let iEnd = -1;
  for (let i = iBegin; i < s.length; i += 1) {
    const t = s[i]!.type.trim();
    if (/^begin[ _]group/.test(t)) depth += 1;
    else if (/^end[ _]group/.test(t)) { depth -= 1; if (depth === 0) { iEnd = i; break; } }
  }
  s.splice(iEnd, 0, ...moved);
  await fs.writeFile(p, await m.serializeXlsForm(form));
}

test('NSSD geriatric — build geriatric_referral_followup from scratch', async ({ page }) => {
  test.setTimeout(2_400_000);
  await openProjectAt(page, PROJECT);
  await page.goto('/');

  await createAppForm(page, FOLLOWUP_TITLE, FOLLOWUP);
  await page.getByRole('button', { name: /^Survey/ }).first().click();
  const bar = page.locator('.language-chip-bar');
  await bar.getByRole('button', { name: '+ Add language' }).click();
  await page.locator('.language-chip-popover').locator('button', { hasText: 'नेपाली (Nepali)' }).click();
  await saveForm(page);

  await fixInputsBlockToNssdConvention(FOLLOWUP);
  console.log('[nssd] hand-edit applied: inputs block matched to NSSD convention (form 2)');

  await openProjectAt(page, PROJECT);
  await page.goto('/');
  await page.locator('.nav-item', { hasText: 'Forms' }).click();
  await page.getByRole('button', { name: `${FOLLOWUP}.xlsx` }).click();
  await expect(page.getByRole('button', { name: /^Survey/ }).first()).toBeVisible({ timeout: 15_000 });
  await ensureFullMode(page);

  /* ═══ Receiver rows — convention (b): hidden, same-named, inside `inputs` ═══ */
  const inputsAccordion = page.locator('.survey-group-accordion')
    .filter({ has: page.locator('code', { hasText: /^inputs$/ }) }).first();
  await expect(inputsAccordion, 'inputs group accordion visible in Full mode').toBeVisible();
  if (!(await inputsAccordion.getByRole('button', { name: /\+ add inside|\+ Add question/ }).first().isVisible().catch(() => false))) {
    await inputsAccordion.locator('.survey-group-header').first().click();
  }
  for (const flag of REFER_FLAGS) {
    await inputsAccordion.getByRole('button', { name: /\+ add inside|\+ Add question/ }).first().click();
    const picker = page.locator('.qtype-modal');
    await picker.locator('input[placeholder="e.g. has_fever, patient_age"]').fill(flag.name);
    await picker.locator('.qtype-tile')
      .filter({ has: page.locator('.qtype-tile-label', { hasText: /^Hidden$/ }) }).click();
    await expect(picker).not.toBeVisible();
  }
  await saveForm(page);
  console.log('[nssd] receiver rows added inside inputs:', REFER_FLAGS.map((f) => f.name).join(', '));

  /* HAND-EDIT #2 (documented): "+ add inside" nests new rows inside the
   * innermost existing group (`contact`), not as direct `inputs` children —
   * reproduces the 2026-08-10 finding exactly. CHT binds task-delivered
   * `content.<key>` to `inputs/<key>` DIRECT children only, so relocate. */
  await relocateReceiverRowsToDirectInputsChildren();
  console.log('[nssd] hand-edit applied: receiver rows relocated to direct inputs children');
  await openProjectAt(page, PROJECT);
  await page.goto('/');
  await page.locator('.nav-item', { hasText: 'Forms' }).click();
  await page.getByRole('button', { name: `${FOLLOWUP}.xlsx` }).click();
  await expect(page.getByRole('button', { name: /^Survey/ }).first()).toBeVisible({ timeout: 15_000 });
  await ensureFullMode(page);

  /* ═══ The 16 content rows, flag-gated per domain ═══ */
  for (const row of FOLLOWUP_ROWS) {
    console.log(`[nssd] follow-up row: ${row.name}`);
    await ensureFullMode(page);
    await addRow(page, null, row);
  }
  await saveForm(page);

  /* ═══ Verify from disk — content AND where the receiver rows actually landed ═══ */
  const body = await readForm(page, FOLLOWUP_FORM_ID);
  const names = new Set(body.survey.map((r) => r.name));
  for (const n of [...FOLLOWUP_ROWS.map((r) => r.name), ...REFER_FLAGS.map((f) => f.name)]) {
    expect(names.has(n), `row on disk: ${n}`).toBe(true);
  }
  const inputsIdx = body.survey.findIndex((r) => r.name === 'inputs' && /^begin group/.test(r.type.trim()));
  const inputsEndIdx = body.survey.findIndex((r, i) => i > inputsIdx && r.name === 'inputs' && /^end group/.test(r.type.trim()));
  for (const flag of REFER_FLAGS) {
    const idx = body.survey.findIndex((r) => r.name === flag.name);
    expect(idx, `${flag.name} inside inputs`).toBeGreaterThan(inputsIdx);
    expect(idx, `${flag.name} before end of inputs`).toBeLessThan(inputsEndIdx);
    const nested = body.survey.slice(inputsIdx + 1, idx).some((r) => /^begin group/.test(r.type.trim())) &&
      !body.survey.slice(inputsIdx + 1, idx).some((r) => /^end group/.test(r.type.trim()));
    expect(nested, `${flag.name} is a DIRECT child of inputs, not nested in contact`).toBe(false);
  }
  console.log('[nssd] receiver rows confirmed as direct children of inputs — content.<key> binding will work');
  const memRow = body.survey.find((r) => r.name === 'memory_improvement')!;
  expect(memRow.extras['relevant']).toContain('refer_cognitive');
  console.log(`[nssd] DONE — ${body.survey.length} survey rows, form id ${FOLLOWUP_FORM_ID}`);
});
