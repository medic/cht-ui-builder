/**
 * The declaration half of "insert a contact field" — P1-DEPLOY in
 * docs/plans/pick-preexisting-context-values.md.
 *
 * ## What broke, and why nine green tests missed it
 *
 * `insertContactFieldRef` wrote the harvest calculate
 * (`../inputs/contact/name`) but never declared the node it points at. The
 * scaffold declares exactly `_id` and `patient_id`, so those two resolved
 * and every other contact field was a dangling XPath. `validate-app-forms`
 * fails the WHOLE run, so one bad reference in one form blocked every form
 * and the app settings from deploying.
 *
 * It shipped with nine green flow tests and a clean typecheck because
 * nothing asserted the pairing — the flow tests checked that a calc row
 * appeared, which it did.
 *
 * ## The invariant these tests pin
 *
 * Measured over the four real configs' app forms: every `../inputs/*`
 * reference in them is declared. Zero exceptions. `contact/name` alone is
 * declared in 60 forms and referenced in 68. So the rule is not ours to
 * invent — real configs already hold it, and the tool was the only thing
 * breaking it.
 *
 * The check below is the cheap hermetic form of the pyxform oracle: walk
 * the survey's group structure, collect what `inputs` actually declares,
 * and assert every `../inputs/...` cell resolves. That is exactly the class
 * `validate-app-forms` catches, without needing python in the loop.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { insertContactFieldRef } from './insertContactFieldRef.js';
import { buildAppFormScaffold } from './scaffolds.js';
import { findStructuralViolations } from './structuralBalance.js';
import type { SurveyRow, XLSForm } from './types.js';

/* ------------------------- the hermetic oracle -------------------------- */

/** Every path declared inside the outermost `inputs` group, e.g.
 *  `contact/name`, `user/contact_id`, `source`. */
function declaredInputPaths(survey: readonly SurveyRow[]): Set<string> {
  const out = new Set<string>();
  const stack: string[] = [];
  for (const r of survey) {
    const t = r.type.trim().toLowerCase();
    if (t === 'begin group' || t === 'begin repeat') {
      stack.push(r.name);
      continue;
    }
    if (t === 'end group' || t === 'end repeat') {
      stack.pop();
      continue;
    }
    if (stack[0] === 'inputs') {
      out.add([...stack.slice(1), r.name].join('/'));
    }
  }
  return out;
}

/** Every `../inputs/<path>` referenced by any cell in the survey. */
function referencedInputPaths(survey: readonly SurveyRow[]): string[] {
  const out: string[] = [];
  for (const r of survey) {
    for (const v of Object.values(r.extras)) {
      if (typeof v !== 'string') continue;
      for (const m of v.matchAll(/\.\.\/inputs\/([A-Za-z0-9_/-]+)/g)) out.push(m[1]!);
    }
  }
  return out;
}

/** The assertion `validate-app-forms` would make, run in-process. */
function assertEveryInputRefResolves(form: XLSForm, context: string): void {
  const declared = declaredInputPaths(form.survey);
  const dangling = referencedInputPaths(form.survey).filter((p) => !declared.has(p));
  assert.deepEqual(
    [...new Set(dangling)],
    [],
    `${context}: these ../inputs refs point at nodes the form never declares — ` +
      `validate-app-forms would fail the entire run. Declared: ${[...declared].join(', ')}`,
  );
}

/* ---------------------------- the scaffold ------------------------------ */

test('the shipped app scaffold declares every input path it references', () => {
  // This alone would have caught the bug on day one: before the fix the
  // scaffold declared `_id` + `patient_id` and its own calcs referenced
  // `user/name` and `user/contact_id` too.
  const form = buildAppFormScaffold({ basename: 'demo', title: 'Demo' });
  assertEveryInputRefResolves(form, 'app scaffold');
});

test('the app scaffold now declares inputs/contact/name', () => {
  const form = buildAppFormScaffold({ basename: 'demo' });
  assert.ok(
    declaredInputPaths(form.survey).has('contact/name'),
    'name is the field authors reach for and the docs\' typical inputs group lists it',
  );
  // …and it is the CONTACT name, not the user's username. Both exist and
  // confusing them is what let the bug ship.
  assert.ok(declaredInputPaths(form.survey).has('user/name'), 'the username is separate');
});

test('the app scaffold does NOT gain the wider cht-core input set', () => {
  // PO decision 2026-08-14: one row, not five. These are declared on demand.
  const declared = declaredInputPaths(buildAppFormScaffold({ basename: 'demo' }).survey);
  for (const f of ['contact/short_name', 'contact/date_of_birth', 'contact/sex']) {
    assert.equal(declared.has(f), false, `${f} should be declare-on-demand, not scaffolded`);
  }
});

test('the app scaffold stays structurally balanced', () => {
  assert.deepEqual(findStructuralViolations(buildAppFormScaffold({ basename: 'd' }).survey), []);
});

/* ------------------------- declare on demand ---------------------------- */

test('picking a field outside the scaffolded set declares it in the same patch', () => {
  // `sickle_cell_test` is the kind of config-specific field that cannot be
  // enumerated ahead of time — NSSD's c82_person carries it alongside
  // `house_number`. One gesture must produce both halves so one undo
  // reverses both.
  const form = buildAppFormScaffold({ basename: 'demo' });
  const r = insertContactFieldRef(form, 'sickle_cell_test');

  assert.equal(r.wasCreated, true, 'the harvest calc is created');
  assert.equal(r.declaredInput, true, 'and the declaration alongside it');
  assert.equal(r.undeclarableReason, null);
  assert.ok(declaredInputPaths(r.form.survey).has('contact/sickle_cell_test'));
  assertEveryInputRefResolves(r.form, 'after declare-on-demand');
  assert.deepEqual(findStructuralViolations(r.form.survey), []);
});

test('the declaration lands INSIDE inputs/contact, the calc OUTSIDE inputs', () => {
  // Both placements are load-bearing: a calc inside `inputs/contact` would
  // break its own `../inputs/contact/...` xpath (the `..` step exits past
  // `inputs`), and a declaration outside the group would not be the node
  // the xpath names.
  const r = insertContactFieldRef(buildAppFormScaffold({ basename: 'demo' }), 'house_number');
  const survey = r.form.survey;
  const declIdx = survey.findIndex((x) => x.name === 'house_number');
  const calcIdx = survey.findIndex((x) => x.name === 'patient_house_number');
  const endContact = survey.findIndex(
    (x) => x.type.trim().toLowerCase() === 'end group' && x.name === 'contact',
  );
  const endInputs = survey.findIndex(
    (x) => x.type.trim().toLowerCase() === 'end group' && x.name === 'inputs',
  );
  assert.ok(declIdx < endContact, 'declaration is inside the contact group');
  assert.equal(declIdx, endContact - 1, 'declaration is the last row of the group');
  assert.equal(calcIdx, endInputs + 1, 'harvest calc sits immediately after end group inputs');
  assert.equal(survey[declIdx]?.type, 'hidden');
});

test('a field the scaffold already declares gets no duplicate declaration', () => {
  const r = insertContactFieldRef(buildAppFormScaffold({ basename: 'demo' }), 'name');
  assert.equal(r.declaredInput, false, 'name is already in the scaffold');
  const declared = r.form.survey.filter((x) => x.name === 'name');
  // One under inputs/contact, one under inputs/user — both pre-existing.
  assert.equal(declared.length, 2, 'no third `name` row was added');
});

test('re-picking the same field twice is fully idempotent', () => {
  const first = insertContactFieldRef(buildAppFormScaffold({ basename: 'demo' }), 'house_number');
  const second = insertContactFieldRef(first.form, 'house_number');
  assert.equal(second.wasCreated, false);
  assert.equal(second.declaredInput, false);
  assert.equal(second.form, first.form, 'nothing needed doing, so the same instance comes back');
  assert.equal(second.form.survey.filter((r) => r.name === 'house_number').length, 1);
});

test('a form the tool broke earlier is REPAIRED by re-picking the field', () => {
  // The state already on disk in real projects: the harvest calc exists,
  // the declaration never did. Re-picking must add the missing half rather
  // than short-circuiting on "the calc is there, nothing to do".
  const scaffold = buildAppFormScaffold({ basename: 'demo' });
  const broken: XLSForm = {
    ...scaffold,
    survey: [
      ...scaffold.survey,
      {
        rowId: 'legacy',
        type: 'calculate',
        name: 'patient_sex',
        labels: { en: '' },
        extras: { calculation: '../inputs/contact/sex' },
      },
    ],
  };
  // Precondition: this form is exactly what validate-app-forms rejects.
  assert.throws(() => assertEveryInputRefResolves(broken, 'broken form'));

  const r = insertContactFieldRef(broken, 'sex');
  assert.equal(r.wasCreated, false, 'the calc already existed');
  assert.equal(r.harvestName, 'patient_sex', 'and its name is reused');
  assert.equal(r.declaredInput, true, 'but the missing declaration is added');
  assert.notEqual(r.form, broken, 'so a new form instance comes back');
  assertEveryInputRefResolves(r.form, 'after repair');
});

test('the declaration carries an empty label per active locale, not English', () => {
  // Same decision as the harvest calc: a hidden plumbing row has no
  // user-facing text, and inventing an English label would push a token the
  // project never wrote into a config that may not be in English.
  const scaffold = buildAppFormScaffold({ basename: 'demo' });
  const multi: XLSForm = {
    ...scaffold,
    surveyHeaders: { ...scaffold.surveyHeaders, labelLocales: ['en', 'ne'] },
  };
  const r = insertContactFieldRef(multi, 'house_number');
  const decl = r.form.survey.find((x) => x.name === 'house_number' && x.type === 'hidden');
  assert.deepEqual(decl?.labels, { en: '', ne: '' });
});

/* --------------------- when it cannot declare, say so ------------------- */

test('a form with no inputs/contact group refuses rather than dangling silently', () => {
  const bare: XLSForm = {
    locales: ['en'],
    surveyHeaders: { ordered: ['type', 'name', 'label::en', 'calculation'], labelLocales: ['en'] },
    choicesHeaders: { ordered: ['list_name', 'name', 'label::en'], labelLocales: ['en'] },
    survey: [
      { rowId: 'a', type: 'string', name: 'q1', labels: { en: 'Q1' }, extras: {} },
    ],
    choices: [],
    settings: { form_id: 'bare', form_title: 'Bare', version: '', extras: {} },
    extraSheets: [],
  };
  const r = insertContactFieldRef(bare, 'name');
  assert.equal(r.declaredInput, false);
  assert.match(r.undeclarableReason ?? '', /inputs\/contact/);
  // The calc is still emitted — the author asked for it, and refusing the
  // whole gesture would be worse than telling them what to fix — but the
  // caller now has a reason string to surface.
  assert.equal(r.wasCreated, true);
});

test('a nested path refuses loudly instead of guessing at intermediate groups', () => {
  // `contact/parent/_id` is real (16 forms declare it), but placing it means
  // synthesising the intermediate groups, and the pickers only offer flat
  // field names.
  const r = insertContactFieldRef(buildAppFormScaffold({ basename: 'demo' }), 'parent/_id');
  assert.equal(r.declaredInput, false);
  assert.match(r.undeclarableReason ?? '', /nested path/);
});

test('a blank field name is still a no-op', () => {
  const form = buildAppFormScaffold({ basename: 'demo' });
  for (const blank of ['', '   ']) {
    const r = insertContactFieldRef(form, blank);
    assert.equal(r.form, form);
    assert.equal(r.harvestName, '');
    assert.equal(r.declaredInput, false);
    assert.equal(r.undeclarableReason, null);
  }
});

/* ---------------------- the scoping that matters ------------------------ */

test('a top-level question named `name` does not count as a declaration', () => {
  // A survey-wide name check would answer the wrong question: a question
  // called `name` at the top level does not make ../inputs/contact/name
  // resolve. The check has to be scoped to the inputs/contact subtree.
  const scaffold = buildAppFormScaffold({ basename: 'demo' });
  // Strip the scaffolded declaration so only the top-level decoy remains.
  const withoutDecl = scaffold.survey.filter(
    (r, i) =>
      !(
        r.name === 'name' &&
        r.type === 'hidden' &&
        scaffold.survey[i - 1]?.name === 'patient_id'
      ),
  );
  const decoyed: XLSForm = {
    ...scaffold,
    survey: [
      ...withoutDecl,
      { rowId: 'decoy', type: 'string', name: 'name', labels: { en: 'Your name' }, extras: {} },
    ],
  };
  const r = insertContactFieldRef(decoyed, 'name');
  assert.equal(r.declaredInput, true, 'the top-level `name` must not satisfy the check');
  assertEveryInputRefResolves(r.form, 'after declaring past a decoy');
});

test('a `contact` group elsewhere in the survey is not the plumbing block', () => {
  // Writing into some other group called `contact` would not make the
  // xpath resolve, so it must not be treated as the inputs block.
  const form: XLSForm = {
    locales: ['en'],
    surveyHeaders: { ordered: ['type', 'name', 'label::en', 'calculation'], labelLocales: ['en'] },
    choicesHeaders: { ordered: ['list_name', 'name', 'label::en'], labelLocales: ['en'] },
    survey: [
      { rowId: 'a', type: 'begin group', name: 'household', labels: { en: '' }, extras: {} },
      { rowId: 'b', type: 'begin group', name: 'contact', labels: { en: '' }, extras: {} },
      { rowId: 'c', type: 'string', name: 'sex', labels: { en: '' }, extras: {} },
      { rowId: 'd', type: 'end group', name: 'contact', labels: { en: '' }, extras: {} },
      { rowId: 'e', type: 'end group', name: 'household', labels: { en: '' }, extras: {} },
    ],
    choices: [],
    settings: { form_id: 'x', form_title: 'X', version: '', extras: {} },
    extraSheets: [],
  };
  const r = insertContactFieldRef(form, 'sex');
  assert.equal(r.declaredInput, false, 'the unrelated `contact` group is not inputs/contact');
  assert.match(r.undeclarableReason ?? '', /inputs\/contact/);
});

/* ============ the ${} namespace: a harvest name must be UNIQUE ===========
 *
 * The label reference this helper produces is `${harvestName}`, and pyxform
 * resolves `${x}` by NAME across the whole survey. Two elements with one name
 * make it unresolvable and the workbook does not convert at all:
 *
 *   Could not convert …: There has been a problem trying to replace
 *   ${patient_id} with the XPath to the survey element named 'patient_id'.
 *   There are multiple survey elements with this name.
 *
 * Real configs live with duplicate names happily — 40 of their app forms
 * declare `inputs/contact/patient_id` AND carry a top-level calculate called
 * `patient_id` — because they never write `${patient_id}`. This tool always
 * writes the reference, so for us uniqueness is a hard requirement, and the
 * numeric suffix is load-bearing rather than cosmetic.
 *
 * Both cases below were found by pointing the real cht-conf + pyxform oracle
 * at generated forms (scripts/validate-generated-forms.mjs); nothing else we
 * run could see them.
 */

/** Rows that actually occupy the `${}` namespace (group markers don't). */
function nameCounts(survey: readonly SurveyRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of survey) {
    const t = r.type.trim().toLowerCase();
    if (t.startsWith('begin ') || t.startsWith('end ')) continue;
    if (r.name) m.set(r.name, (m.get(r.name) ?? 0) + 1);
  }
  return m;
}

test('picking `patient_id` does not splice an ambiguous reference', () => {
  // Reachable from a fresh form in ONE click — "put the patient's Medic ID in
  // this label" — and it predates the declare-on-demand work. The scaffold
  // ships BOTH `inputs/contact/patient_id` and a top-level calculate called
  // `patient_id`, so the dedupe path used to reuse that calc's name.
  const r = insertContactFieldRef(buildAppFormScaffold({ basename: 'demo' }), 'patient_id');
  expect: {
    // The reference the caller will splice must resolve to exactly one row.
    const counts = nameCounts(r.form.survey);
    assert.equal(
      counts.get(r.harvestName),
      1,
      `\${${r.harvestName}} must name exactly one survey element`,
    );
  }
  // And the scaffold's own `patient_id` calc is left alone: its name is the
  // report's field name, so renaming it to resolve the clash would silently
  // change the submitted document's schema.
  const scaffoldCalc = r.form.survey.find(
    (x) =>
      x.name === 'patient_id' &&
      x.type.trim().toLowerCase() === 'calculate' &&
      (x.extras['calculation'] ?? '') === '../inputs/contact/patient_id',
  );
  assert.ok(scaffoldCalc, "the scaffold's patient_id calculate is untouched");
  assert.notEqual(r.harvestName, 'patient_id', 'so the harvest takes a free name instead');
});

test('a field already `patient_`-prefixed still gets a unique harvest name', () => {
  // `deriveHarvestName('patient_name')` returns it verbatim, which collides
  // with the declaration this same call writes. Guaranteed, not incidental.
  const r = insertContactFieldRef(buildAppFormScaffold({ basename: 'demo' }), 'patient_name');
  assert.equal(r.declaredInput, true);
  assert.notEqual(r.harvestName, 'patient_name');
  assert.equal(nameCounts(r.form.survey).get(r.harvestName), 1);
  assert.equal(
    nameCounts(r.form.survey).get('patient_name'),
    1,
    'only the declaration carries the bare field name',
  );
  assertEveryInputRefResolves(r.form, 'patient_-prefixed field');
});

test('an unresolvable clash is DECLINED with a reason, never emitted', () => {
  // Order-dependent: inserting `name` names the harvest `patient_name`, and
  // declaring the contact field `patient_name` afterwards would make the FIRST
  // insert's own reference ambiguous. We can rename neither the declaration
  // (the XPath names it) nor the other row (that is the report's field name),
  // so the only honest outcome is to decline.
  const first = insertContactFieldRef(buildAppFormScaffold({ basename: 'demo' }), 'name');
  assert.equal(first.harvestName, 'patient_name');

  const clash = insertContactFieldRef(first.form, 'patient_name');
  assert.equal(clash.harvestName, '', 'nothing is spliced');
  assert.equal(clash.form, first.form, 'and nothing is written');
  assert.match(clash.undeclarableReason ?? '', /already has a question or calculation/);
  assert.match(clash.undeclarableReason ?? '', /patient_name/);
});

test('the reverse order needs no refusal — both inserts succeed', () => {
  // Same two fields, other way round: the declaration lands first, so each
  // harvest simply takes the next free name. Worth pinning so the refusal
  // above is understood as narrow rather than a blanket ban.
  let form = buildAppFormScaffold({ basename: 'demo' });
  const a = insertContactFieldRef(form, 'patient_name');
  assert.equal(a.undeclarableReason, null);
  form = a.form;
  const b = insertContactFieldRef(form, 'name');
  assert.equal(b.undeclarableReason, null);
  const counts = nameCounts(b.form.survey);
  assert.equal(counts.get(a.harvestName), 1);
  assert.equal(counts.get(b.harvestName), 1);
  assert.notEqual(a.harvestName, b.harvestName);
  assertEveryInputRefResolves(b.form, 'both fields, declaration first');
});
