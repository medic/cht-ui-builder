/**
 * Round-trip + recognizer tests for the Tier 1.5 "Reference a value"
 * helpers (`shared/src/xlsform/calcReference.ts`).
 *
 * Three buckets per docs/plans/calc-reference-builder.md §"Test plan":
 *
 *   Bucket A — canonical, byte-stable, re-hydrates. One per idiom.
 *     For each: emit → recognize → emit produces the same canonical
 *     string AND the recognizer agrees on kind + argument + wrapper.
 *     Also: parseCalculation+serializeCalculation byte-identity for
 *     the same input (the parent calc Tier-0 §3.1 guarantee).
 *
 *   Bucket B — real fixture. Every distinct `calculation` cell from
 *     `nssd/chis/forms/app/diabetes_referral.xlsx` (10 cells; 3 input-
 *     copies, 5 ctx reads, 2 genuine if-chains). The 3+5 references
 *     are recognized; the 2 if-chains are NOT recognized (caller routes
 *     them to the If-then table mode or raw — out of scope here).
 *     Every cell round-trips byte-identical through parseCalculation.
 *
 *   Bucket C — safety. Free-text typed keys / fields / mismatched
 *     wrapper variants degrade gracefully without crashing or false-
 *     recognizing.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  emitContactInput,
  emitContactSummary,
  emitFieldRef,
  recognizeReference,
  type ContextWrapper,
} from './calcReference.js';
import {
  deriveHarvestName,
  insertContactFieldRef,
} from './insertContactFieldRef.js';
import { parseCalculation, serializeCalculation } from './calculationBuilder.js';
import { findStructuralViolations } from './structuralBalance.js';
import { renameSurveyRow } from './renameSurveyRow.js';
import { parseXlsForm } from './parse.js';
import { serializeXlsForm } from './serialize.js';
import type { SurveyRow, XLSForm } from './types.js';

/* ============================== Bucket A ================================ */

test('Bucket A — contact-input emit/recognize round-trip', () => {
  const s = emitContactInput('_id');
  assert.equal(s, '../inputs/contact/_id');
  const r = recognizeReference(s);
  assert.deepEqual(r, {
    kind: 'contact-input',
    argument: '_id',
    wrapper: 'none',
    sentinel: null,
  });
  // And the parent self-check preserves the bytes.
  const parsed = parseCalculation(s);
  assert.equal(parsed.shape, 'single');
  assert.equal(serializeCalculation(parsed), s);
});

test('Bucket A — contact-summary (bare) emit/recognize round-trip', () => {
  const s = emitContactSummary('glucometer_ctx', 'none');
  assert.equal(s, "instance('contact-summary')/context/glucometer_ctx");
  const r = recognizeReference(s);
  assert.deepEqual(r, {
    kind: 'contact-summary',
    argument: 'glucometer_ctx',
    wrapper: 'none',
    sentinel: null,
  });
  const parsed = parseCalculation(s);
  assert.equal(parsed.shape, 'single');
  assert.equal(serializeCalculation(parsed), s);
});

test('Bucket A — contact-summary fallback-to-current emit/recognize round-trip', () => {
  const s = emitContactSummary('glucometer_ctx', 'fallback-to-current');
  assert.equal(
    s,
    "if(instance('contact-summary')/context/glucometer_ctx, instance('contact-summary')/context/glucometer_ctx, .)",
  );
  const r = recognizeReference(s);
  assert.deepEqual(r, {
    kind: 'contact-summary',
    argument: 'glucometer_ctx',
    wrapper: 'fallback-to-current',
    sentinel: null,
  });
  // parseCalculation may classify this as decision_table (the if-shape) OR
  // raw (the self-check demoted it). Either way the bytes survive.
  const parsed = parseCalculation(s);
  assert.equal(serializeCalculation(parsed), s);
});

test('Bucket A — contact-summary read-once emit/recognize round-trip', () => {
  const s = emitContactSummary('previous_bmi_ctx', 'read-once');
  assert.equal(s, "once(instance('contact-summary')/context/previous_bmi_ctx)");
  const r = recognizeReference(s);
  assert.deepEqual(r, {
    kind: 'contact-summary',
    argument: 'previous_bmi_ctx',
    wrapper: 'read-once',
    sentinel: null,
  });
  const parsed = parseCalculation(s);
  assert.equal(parsed.shape, 'single');
  assert.equal(serializeCalculation(parsed), s);
});

test('Bucket A — bare ${field} field-ref recognize', () => {
  const s = emitFieldRef('lmp_date');
  assert.equal(s, '${lmp_date}');
  const r = recognizeReference(s);
  assert.deepEqual(r, {
    kind: 'field-ref',
    argument: 'lmp_date',
    wrapper: 'none',
    sentinel: null,
  });
});

test('Bucket A — every emit/recognize is a fixpoint (re-emit identical string)', () => {
  // The recognizer is the inverse of the emitter for every supported idiom.
  const cases: Array<{ s: string; kind: 'contact-input' | 'contact-summary' | 'field-ref'; wrapper: ContextWrapper }> = [
    { s: emitContactInput('name'), kind: 'contact-input', wrapper: 'none' },
    { s: emitContactSummary('k', 'none'), kind: 'contact-summary', wrapper: 'none' },
    { s: emitContactSummary('k', 'fallback-to-current'), kind: 'contact-summary', wrapper: 'fallback-to-current' },
    { s: emitContactSummary('k', 'read-once'), kind: 'contact-summary', wrapper: 'read-once' },
    { s: emitFieldRef('x'), kind: 'field-ref', wrapper: 'none' },
  ];
  for (const c of cases) {
    const r = recognizeReference(c.s);
    assert.ok(r, `${c.s} should be recognized`);
    assert.equal(r!.kind, c.kind);
    assert.equal(r!.wrapper, c.wrapper);
    let reEmitted: string;
    if (r!.kind === 'contact-input') reEmitted = emitContactInput(r!.argument);
    else if (r!.kind === 'contact-summary') reEmitted = emitContactSummary(r!.argument, r!.wrapper);
    else reEmitted = emitFieldRef(r!.argument);
    assert.equal(reEmitted, c.s);
  }
});

/* ============================== Bucket B ================================ */

interface FixtureCell {
  name: string;
  calc: string;
}

function loadDiabetesReferralCells(): FixtureCell[] {
  const here = import.meta.dirname;
  const candidates = [
    join(here, '__fixtures__', 'diabetes-referral-calc-cells.json'),
    join(here, '..', '..', 'src', 'xlsform', '__fixtures__', 'diabetes-referral-calc-cells.json'),
  ];
  for (const c of candidates) {
    try {
      const txt = readFileSync(c, 'utf8');
      return JSON.parse(txt) as FixtureCell[];
    } catch {
      // try next
    }
  }
  return [];
}

test('Bucket B — diabetes_referral.xlsx: 10 cells, recognizer breakdown matches the picker surface', () => {
  const cells = loadDiabetesReferralCells();
  assert.equal(cells.length, 10, 'fixture must carry exactly the 10 measured cells');

  let inputCopies = 0;
  let ctxReadsRecognized = 0;
  let unrecognized = 0;

  for (const cell of cells) {
    const r = recognizeReference(cell.calc);
    if (r === null) {
      unrecognized++;
      continue;
    }
    if (r.kind === 'contact-input') inputCopies++;
    else if (r.kind === 'contact-summary') ctxReadsRecognized++;
  }

  // Source-level breakdown (per the plan): 3 input-copies + 5 ctx reads
  // + 2 genuine if-chains. The picker's conservative recognizer rejects
  // ONE of the 5 ctx reads (`avg_result_ctx`, whose if-wrapper uses two
  // DIFFERENT refs — intentional semantics, not a stock wrapper). So the
  // picker exposes 3 + 4 = 7 references; 3 cells fall through to the
  // expression/raw kinds and survive verbatim via the §3.1 self-check.
  assert.equal(inputCopies, 3, 'expected 3 input-copies recognized');
  assert.equal(ctxReadsRecognized, 4, 'expected 4 ctx reads recognized (1 non-matching wrapper falls through)');
  assert.equal(unrecognized, 3, 'expected 3 unrecognized (2 if-chains + the non-matching wrapper)');
});

test('Bucket B — every diabetes_referral cell round-trips byte-identical through parseCalculation', () => {
  const cells = loadDiabetesReferralCells();
  assert.ok(cells.length > 0, 'fixture must be present');
  for (const cell of cells) {
    const parsed = parseCalculation(cell.calc);
    assert.equal(
      serializeCalculation(parsed),
      cell.calc.trim(),
      `byte-stability failed for ${cell.name}`,
    );
  }
});

test('Bucket B — the avg_result_ctx if(REF_A, REF_B, .) variant is NOT recognized as a wrapper', () => {
  // The actual nssd cell uses `avg_result` in the condition but
  // `avg_result_ctx` in the value — intentionally different references,
  // not a wrapper. The recognizer must require ref equality, so this
  // cell falls through to expression kind. It still round-trips
  // byte-identical because the parent self-check preserves it.
  const cells = loadDiabetesReferralCells();
  const avg = cells.find((c) => c.name === 'avg_result_ctx');
  assert.ok(avg, 'fixture must include avg_result_ctx');
  const r = recognizeReference(avg!.calc);
  // Either null OR a strict recognition that the wrapper is NOT
  // 'fallback-to-current' (i.e. it didn't false-match).
  if (r !== null) {
    assert.notEqual(r.wrapper, 'fallback-to-current');
  }
});

/* ============================== Bucket C ================================ */

test('Bucket C — empty string is not a reference', () => {
  assert.equal(recognizeReference(''), null);
  assert.equal(recognizeReference('   '), null);
});

test('Bucket C — literal / numeric / arbitrary expressions are not references', () => {
  for (const s of [`'yes'`, '"no"', '42', '3.14', `floor( today() div 365 )`, `concat('a','b')`]) {
    assert.equal(recognizeReference(s), null, `${s} should not be a reference`);
  }
});

test('Bucket C — wrapper with non-matching refs falls through (no false-recognize)', () => {
  // Mirrors the avg_result_ctx case but synthetic for clarity.
  const s =
    "if(instance('contact-summary')/context/a, instance('contact-summary')/context/b, .)";
  const r = recognizeReference(s);
  // Recognizer must NOT classify this as a fallback wrapper.
  if (r !== null) assert.notEqual(r.wrapper, 'fallback-to-current');
});

test('Bucket C — nested xpath in contact-input falls through (conservative recognizer)', () => {
  // `../inputs/contact/parent/_id` — nested. Plan §3 says the conservative
  // recognizer rejects nested paths; they survive via raw byte-identity.
  const s = '../inputs/contact/parent/_id';
  assert.equal(recognizeReference(s), null);
  const parsed = parseCalculation(s);
  assert.equal(serializeCalculation(parsed), s);
});

test('Bucket C — emitter accepts a free-typed key not in any project contextOrder', () => {
  // The picker allows free-type; the emitter doesn't care whether the key
  // is in the project's contact-summary or not. Round-trip still holds.
  const s = emitContactSummary('not_a_real_key', 'none');
  assert.equal(s, "instance('contact-summary')/context/not_a_real_key");
  const r = recognizeReference(s);
  assert.equal(r?.argument, 'not_a_real_key');
  const parsed = parseCalculation(s);
  assert.equal(parsed.shape, 'single');
  assert.equal(serializeCalculation(parsed), s);
});

/* ============== §H1 — widened once() whitespace tolerance ============== */
/*
 * docs/plans/shipped-batch-triad-punchlist.md §H1: the original
 * `CONTACT_SUMMARY_ONCE_RE` only matched the canonical no-spaces form
 * `once(<ref>)`, so spaced variants like `once( ref )` fell through to
 * the `expression` kind and re-opened in Custom-expression instead of
 * the Reference sub-mode. Tolerate internal whitespace inside the
 * parens — the inner reference itself stays canonical (no spaces
 * around `instance` or the slashes).
 */
test('§H1 — once() recognizer tolerates internal whitespace', () => {
  const variants = [
    "once(instance('contact-summary')/context/glucometer_ctx)",
    "once( instance('contact-summary')/context/glucometer_ctx )",
    "once(  instance('contact-summary')/context/glucometer_ctx  )",
    "once(\tinstance('contact-summary')/context/glucometer_ctx\t)",
    "once(\ninstance('contact-summary')/context/glucometer_ctx\n)",
  ];
  for (const s of variants) {
    const r = recognizeReference(s);
    assert.ok(r, `expected to recognize: ${JSON.stringify(s)}`);
    assert.equal(r!.kind, 'contact-summary');
    assert.equal(r!.argument, 'glucometer_ctx');
    assert.equal(r!.wrapper, 'read-once');
  }
});

/* ============== Wave 3 · Note 6 — cross-form bridge picker source ============== */
/*
 * The Wave-3 cross-form-value picker in `CalculationBuilder` uses the
 * existing `emitContactSummary(key, 'fallback-to-current')` engine to
 * emit the bridge calc for a context key defined in the contact-summary
 * "Context values" sub-tab. Since Wave 3 adds no new emit machinery on
 * the form-calc side — only a new source group in the picker whose keys
 * come from the contact-summary populator — this test pins the round-
 * trip contract the picker relies on:
 *
 *   1. `emitContactSummary(key, 'fallback-to-current')` produces the
 *       canonical `if(ref, ref, .)` shape.
 *   2. `recognizeReference` re-hydrates it to
 *       `{ kind: 'contact-summary', argument: key, wrapper: 'fallback-to-current' }`.
 *   3. `parseCalculation → serializeCalculation` preserves the bytes.
 */
test('Wave 3 · Note 6 — cross-form bridge fallback-to-current round-trips through the calc engine', () => {
  // Simulate the picker: user has defined `bmi` in Contact Summary's
  // Context values sub-tab, then in the form's calc builder they pick
  // `bmi` from the "From another form (via contact summary)" source
  // group with the wrapper set to fallback-to-current.
  const key = 'bmi';
  const emitted = emitContactSummary(key, 'fallback-to-current');
  assert.equal(
    emitted,
    "if(instance('contact-summary')/context/bmi, instance('contact-summary')/context/bmi, .)",
    'canonical fallback-to-current shape',
  );

  // Re-hydrate through the recognizer.
  const r = recognizeReference(emitted);
  assert.deepEqual(r, {
    kind: 'contact-summary',
    argument: 'bmi',
    wrapper: 'fallback-to-current',
    sentinel: null,
  });

  // Byte-stable through the parent calc engine (parseCalculation +
  // serializeCalculation self-check §3.1 — the picker relies on this
  // to guarantee no-op open/save doesn't drift the cell).
  const parsed = parseCalculation(emitted);
  assert.equal(serializeCalculation(parsed), emitted);

  // Re-emitting from the recognized record is a fixpoint.
  assert.equal(emitContactSummary(r!.argument, r!.wrapper), emitted);
});

test('Wave 3 · Note 6 — bridge picker keys with hyphens survive the calcReference emitter', () => {
  // `useContactSummaryContextKeys` returns whatever `parseContactSummary`
  // saw. The contact-summary parser tolerates hyphen-carrying string
  // keys (via JSON.stringify quoting). Confirm the calc-side emitter +
  // recognizer accept the same alphabet (the `[\w-]+` recognizer group).
  const key = 'previous-bmi';
  const emitted = emitContactSummary(key, 'fallback-to-current');
  const r = recognizeReference(emitted);
  assert.ok(r, 'hyphen key must be recognized');
  assert.equal(r!.argument, key);
  assert.equal(r!.wrapper, 'fallback-to-current');
});

/* ================ Wave 2 · §5b — insert-contact-field flow ================ */
/*
 * The "insert contact field" label affordance calls `insertContactFieldRef`
 * to (idempotently) add a hidden harvest `calculate` row and returns the
 * name to splice into the label as `${<harvestName>}`. These tests pin
 * the four contractual guarantees from the design note
 * (docs/handoff-waves-1-3-2026-07-29.md §5):
 *
 *   1. Exactly one calc row is created, with the canonical
 *      `../inputs/contact/<field>` calculation, placed right after the
 *      outermost `end group inputs` — i.e. as a top-level sibling of the
 *      `inputs` group, matching pregnancy.xlsx's convention (placing it
 *      INSIDE `inputs/contact` would break the `../` xpath).
 *   2. Structural balance is preserved.
 *   3. Re-inserting the same contact field is a no-op (referential
 *      equality on the form; no new row).
 *   4. The `${harvestName}` token spliced into a label round-trips
 *      byte-stable through parseXlsForm → serializeXlsForm → parseXlsForm.
 *   5. Name-collision safety: if `patient_<field>` is already taken by
 *      an unrelated row, a numeric suffix is appended.
 */

function mkFormWithInputsScaffold(extraSurvey: SurveyRow[] = []): XLSForm {
  // Minimal `inputs/contact` scaffold that mirrors the shape
  // `buildAppFormScaffold` emits — enough survey rows for the helper's
  // "insert after end group inputs" locator to fire.
  const row = (i: number, type: string, name: string, extras: Record<string, string> = {}): SurveyRow => ({
    rowId: `r${i}`,
    type,
    name,
    labels: { en: '' },
    extras,
  });
  const survey: SurveyRow[] = [
    row(0, 'begin group', 'inputs', { appearance: 'field-list', relevant: `./source = 'user'` }),
    row(1, 'hidden', 'source', { default: 'user' }),
    row(2, 'begin group', 'contact'),
    row(3, 'string', '_id', { appearance: 'select-contact type-person' }),
    row(4, 'hidden', 'patient_id'),
    row(5, 'end group', 'contact'),
    row(6, 'end group', 'inputs'),
    ...extraSurvey,
  ];
  return {
    locales: ['en'],
    surveyHeaders: {
      ordered: ['type', 'name', 'label::en', 'appearance', 'relevant', 'calculation', 'default'],
      labelLocales: ['en'],
    },
    choicesHeaders: { ordered: ['list_name', 'name', 'label::en'], labelLocales: ['en'] },
    survey,
    choices: [],
    settings: { form_id: 'test', form_title: 'Test', version: '2026-07-29', extras: {} },
    extraSheets: [],
  };
}

test('§5b — deriveHarvestName: `patient_` prefix, no double-prefix, strips leading underscores', () => {
  assert.equal(deriveHarvestName('name'), 'patient_name');
  assert.equal(deriveHarvestName('sex'), 'patient_sex');
  assert.equal(deriveHarvestName('date_of_birth'), 'patient_date_of_birth');
  // Already-prefixed field names stay as-is (no `patient_patient_id`).
  assert.equal(deriveHarvestName('patient_id'), 'patient_id');
  assert.equal(deriveHarvestName('patient_name'), 'patient_name');
  // Leading underscores stripped so `_id` produces `patient_id`, not
  // the ugly `patient__id`. (Collision with an existing `patient_id`
  // harvest is resolved by the caller's suffix logic — see §5b§C.)
  assert.equal(deriveHarvestName('_id'), 'patient_id');
  // Whitespace-only input returns empty (short-circuits the helper).
  assert.equal(deriveHarvestName(''), '');
  assert.equal(deriveHarvestName('   '), '');
});

test('§5b — inserting `name` creates exactly one calc row `../inputs/contact/name`', () => {
  const form = mkFormWithInputsScaffold();
  const result = insertContactFieldRef(form, 'name');
  assert.equal(result.wasCreated, true, 'a new row should have been inserted');
  assert.equal(result.harvestName, 'patient_name');
  assert.equal(result.hadNameCollision, false);

  // Exactly ONE new calculate row referencing `../inputs/contact/name`.
  const matching = result.form.survey.filter(
    (r) =>
      r.type.trim().toLowerCase() === 'calculate' &&
      (r.extras['calculation'] ?? '').trim() === '../inputs/contact/name',
  );
  assert.equal(matching.length, 1, 'exactly one harvest calc row');
  assert.equal(matching[0]!.name, 'patient_name');
});

test('§5b — the new harvest calc lands right after `end group inputs` (top-level sibling)', () => {
  // Placement matters: inside `inputs/contact` would break the
  // `../inputs/contact/name` xpath. The helper places the row as a
  // top-level sibling of `inputs`, matching cht-conf/pregnancy.xlsx.
  const form = mkFormWithInputsScaffold();
  const result = insertContactFieldRef(form, 'name');
  const endInputsIdx = result.form.survey.findIndex(
    (r) => r.type.trim().toLowerCase() === 'end group' && r.name === 'inputs',
  );
  assert.ok(endInputsIdx > 0, 'form must have an `end group inputs`');
  const harvestIdx = result.form.survey.findIndex((r) => r.name === 'patient_name');
  assert.equal(harvestIdx, endInputsIdx + 1, 'harvest row must sit immediately after end group inputs');
});

test('§5b — structural balance is preserved after inserting a harvest calc', () => {
  const form = mkFormWithInputsScaffold();
  const before = findStructuralViolations(form.survey);
  assert.deepEqual(before, [], 'baseline scaffold must be balanced');
  const result = insertContactFieldRef(form, 'name');
  const after = findStructuralViolations(result.form.survey);
  assert.deepEqual(after, [], 'balance must survive the insert');
});

test('§5b — re-inserting the same contact field is idempotent (no duplicate calc, same form ref)', () => {
  const form = mkFormWithInputsScaffold();
  const first = insertContactFieldRef(form, 'name');
  assert.equal(first.wasCreated, true);
  // Second call on the ALREADY-updated form must dedupe.
  const second = insertContactFieldRef(first.form, 'name');
  assert.equal(second.wasCreated, false, 'no new row on the second call');
  assert.equal(second.harvestName, 'patient_name');
  // Referential equality — callers can fast-path on this.
  assert.equal(second.form, first.form, 'dedupe returns the SAME form instance');
  // And still exactly one matching calc row.
  const matching = second.form.survey.filter(
    (r) =>
      r.type.trim().toLowerCase() === 'calculate' &&
      (r.extras['calculation'] ?? '').trim() === '../inputs/contact/name',
  );
  assert.equal(matching.length, 1);
});

test('§5b — dedupe reuses ANY existing row with the same calculation, even if named oddly', () => {
  // If the form already carries a calc row named `patient_uuid` whose
  // calculation is `../inputs/contact/name` (odd but legal), inserting
  // `name` returns `patient_uuid` — we don't fight the author's naming.
  const form = mkFormWithInputsScaffold([
    {
      rowId: 'pre-existing',
      type: 'calculate',
      name: 'patient_uuid',
      labels: { en: '' },
      extras: { calculation: '../inputs/contact/name' },
    },
  ]);
  const result = insertContactFieldRef(form, 'name');
  assert.equal(result.wasCreated, false);
  assert.equal(result.harvestName, 'patient_uuid');
  assert.equal(result.form, form, 'dedupe short-circuits to referential equality');
});

test('§5b — name-collision safety: default name taken by an unrelated row → numeric suffix', () => {
  // Pre-existing row named `patient_name` pointing somewhere ELSE — the
  // dedupe path can't reuse it, so the helper suffixes `_2` and flags
  // `hadNameCollision` so the UI can surface a soft warning.
  const form = mkFormWithInputsScaffold([
    {
      rowId: 'collision',
      type: 'string',
      name: 'patient_name',
      labels: { en: '' },
      extras: {},
    },
  ]);
  const result = insertContactFieldRef(form, 'name');
  assert.equal(result.wasCreated, true);
  assert.equal(result.hadNameCollision, true);
  assert.equal(result.harvestName, 'patient_name_2');
  // The new calc row was inserted with the suffixed name.
  const newRow = result.form.survey.find((r) => r.name === 'patient_name_2');
  assert.ok(newRow, 'suffixed harvest row must be present');
  assert.equal((newRow!.extras['calculation'] ?? '').trim(), '../inputs/contact/name');
});

test('§5b — no inputs group → harvest calc is appended at end (still deployable)', () => {
  // Edge case: a survey with no `inputs` block at all (e.g. a scaffold-
  // less test form). Helper falls back to appending; the caller's form
  // has no plumbing to reference the calc, but at least the shape is
  // legal and the invariant holds.
  const form: XLSForm = {
    locales: ['en'],
    surveyHeaders: { ordered: ['type', 'name', 'label::en'], labelLocales: ['en'] },
    choicesHeaders: { ordered: [], labelLocales: [] },
    survey: [
      { rowId: 'q1', type: 'text', name: 'q1', labels: { en: '' }, extras: {} },
    ],
    choices: [],
    settings: { form_id: 't', form_title: 'T', version: 'v', extras: {} },
    extraSheets: [],
  };
  const result = insertContactFieldRef(form, 'name');
  assert.equal(result.wasCreated, true);
  assert.equal(result.form.survey.length, 2);
  assert.equal(result.form.survey[1]!.name, 'patient_name');
  assert.deepEqual(findStructuralViolations(result.form.survey), []);
});

test('§5b — inserted label token `${patient_name}` round-trips through the survey serializer', async () => {
  // Full xlsx round-trip: build a form, insert the harvest calc, splice
  // `${patient_name}` into a real question's label, serialize to xlsx,
  // re-parse. The label token must survive verbatim.
  const base = mkFormWithInputsScaffold([
    {
      rowId: 'q_greeting',
      type: 'note',
      name: 'greeting',
      labels: { en: 'Hello ' },
      extras: {},
    },
  ]);
  const result = insertContactFieldRef(base, 'name');
  // Splice `${patient_name}` at the end of the greeting label.
  const withLabel: XLSForm = {
    ...result.form,
    survey: result.form.survey.map((r) =>
      r.name === 'greeting'
        ? { ...r, labels: { ...r.labels, en: `Hello \${${result.harvestName}}` } }
        : r,
    ),
  };
  const buf = await serializeXlsForm(withLabel);
  const reparsed = await parseXlsForm(buf);
  const greeting = reparsed.survey.find((r) => r.name === 'greeting');
  assert.ok(greeting, 'greeting must survive the round-trip');
  assert.equal(greeting!.labels['en'], 'Hello ${patient_name}');
  // The harvest calc row also survives with the canonical calc cell.
  const harvest = reparsed.survey.find((r) => r.name === 'patient_name');
  assert.ok(harvest, 'harvest calc row must survive the round-trip');
  assert.equal((harvest!.extras['calculation'] ?? '').trim(), '../inputs/contact/name');
});

test('§5b — after insert, renaming the harvest calc rewrites the `${patient_name}` label token in lockstep', () => {
  // The rename-macro guarantees any auto-created harvest calc can later
  // be renamed by the user without leaving dangling label refs — the
  // spec's "renamed field's label ref stays in lockstep" acceptance.
  const base = mkFormWithInputsScaffold([
    {
      rowId: 'q_greeting',
      type: 'note',
      name: 'greeting',
      labels: { en: 'Hello ' },
      extras: {},
    },
  ]);
  const inserted = insertContactFieldRef(base, 'name');
  // Splice the token into the greeting label as the UI would.
  const withLabel: XLSForm = {
    ...inserted.form,
    survey: inserted.form.survey.map((r) =>
      r.name === 'greeting'
        ? { ...r, labels: { ...r.labels, en: `Hello \${${inserted.harvestName}}` } }
        : r,
    ),
  };
  // Now rename the auto-created calc via the rename macro.
  const renamed = renameSurveyRow(withLabel, 'patient_name', 'patient_display_name');
  const harvest = renamed.survey.find((r) => r.type.trim().toLowerCase() === 'calculate' && (r.extras['calculation'] ?? '').trim() === '../inputs/contact/name');
  assert.ok(harvest, 'harvest row must still be present');
  assert.equal(harvest!.name, 'patient_display_name');
  const greeting = renamed.survey.find((r) => r.name === 'greeting');
  assert.ok(greeting, 'greeting row must be present');
  // Label ref stays in lockstep with the rename.
  assert.equal(greeting!.labels['en'], 'Hello ${patient_display_name}');
});
