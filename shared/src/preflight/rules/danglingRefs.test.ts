/**
 * Tests for the dangling-refs rule.
 *
 * Pins:
 *   - `${x}` where x is a same-form row name → passes
 *   - a `../inputs/…` reference passes IFF the form declares that node.
 *     It used to pass unconditionally, on the assumption that "the runtime
 *     injects it". Measured across 200-plus real forms, the only injected
 *     subtree is `inputs/meta/*`; everything else — all of `contact/*`,
 *     `user/*`, `source` — is declared in every real form that uses it, and
 *     an undeclared one makes cht-conf's validate-app-forms reject the
 *     entire project. See the rule's module doc.
 *   - `${nonexistent}` → error result
 *   - empty braces `${}` / `${ }` → error result ("empty reference")
 *   - refs are scanned in relevant / calculation / constraint / etc.
 *   - path-shaped refs like `${/data/group/age}` resolve on last segment
 *   - substring collisions do not accidentally resolve (`${age_years}`
 *     does NOT resolve against a row named `age`)
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { runDanglingRefsRule } from './danglingRefs.js';
import { mkContext, mkForm, surveyRow } from './testFixtures.js';
import type { SurveyRow } from '../../xlsform/types.js';

test('ref to a known same-form name passes', () => {
  const form = mkForm([
    surveyRow('integer', 'age'),
    surveyRow('note', 'msg', { relevant: '${age} > 18' }),
  ]);
  assert.deepEqual(runDanglingRefsRule(mkContext([{ formId: 'app', xlsform: form }])), []);
});

/** The standard CHT inputs block, as the scaffold now emits it. */
function inputsBlock(contactFields: string[] = ['_id', 'patient_id', 'name']): SurveyRow[] {
  return [
    surveyRow('begin group', 'inputs'),
    surveyRow('hidden', 'source'),
    surveyRow('begin group', 'user'),
    surveyRow('hidden', 'contact_id'),
    surveyRow('hidden', 'name'),
    surveyRow('end group', 'user'),
    surveyRow('begin group', 'contact'),
    ...contactFields.map((f) => surveyRow('hidden', f)),
    surveyRow('end group', 'contact'),
    surveyRow('end group', 'inputs'),
  ];
}

test('a DECLARED ../inputs/contact/* reference passes', () => {
  const form = mkForm([
    ...inputsBlock(),
    surveyRow('calculate', 'patient_uuid', { calculation: '../inputs/contact/_id' }),
    surveyRow('calculate', 'patient_name', { calculation: '../inputs/contact/name' }),
  ]);
  assert.deepEqual(runDanglingRefsRule(mkContext([{ formId: 'app', xlsform: form }])), []);
});

test('an UNDECLARED ../inputs/contact/* ref is now an error — the deploy blocker', () => {
  // The exact cell that failed the whole NSSD run:
  //   ERROR  …_for_elder_population.xml contains invalid XPath:
  //          calculate for /data/patient_name contains [../inputs/contact/name]
  // A BARE xpath with no braces, which this rule previously never scanned.
  const bad = surveyRow('calculate', 'patient_sex', { calculation: '../inputs/contact/sex' });
  const form = mkForm([...inputsBlock(), bad]);
  const results = runDanglingRefsRule(mkContext([{ formId: 'app', xlsform: form }]));
  assert.equal(results.length, 1);
  assert.equal(results[0]?.severity, 'error');
  assert.equal(results[0]?.rowId, bad.rowId);
  assert.equal(results[0]?.column, 'calculation');
  assert.match(results[0]?.message ?? '', /inputs\/contact\/sex/);
  assert.match(results[0]?.message ?? '', /validate-app-forms/);
});

test('the braced spelling is judged the same way, and reported once', () => {
  const form = mkForm([
    ...inputsBlock(),
    surveyRow('calculate', 'a', { calculation: '${../inputs/contact/name}' }),
    surveyRow('calculate', 'b', { calculation: '${../inputs/contact/sex}' }),
  ]);
  const results = runDanglingRefsRule(mkContext([{ formId: 'app', xlsform: form }]));
  assert.equal(results.length, 1, 'declared one passes; undeclared one reported exactly once');
  assert.match(results[0]?.message ?? '', /inputs\/contact\/sex/);
});

test('the ../ step count is irrelevant — only the path inside inputs matters', () => {
  // A cell two groups deep legitimately needs `../../../inputs/user/name`.
  // The step count depends on where the cell sits, not on which node is
  // meant, so it must not change the verdict either way.
  for (const prefix of ['../', '../../', '../../../']) {
    const ok = mkForm([
      ...inputsBlock(),
      surveyRow('calculate', 'created_by', { calculation: `${prefix}inputs/user/name` }),
    ]);
    assert.deepEqual(runDanglingRefsRule(mkContext([{ formId: 'app', xlsform: ok }])), [], prefix);

    const bad = mkForm([
      ...inputsBlock(),
      surveyRow('calculate', 'nope', { calculation: `${prefix}inputs/user/nonexistent` }),
    ]);
    assert.equal(
      runDanglingRefsRule(mkContext([{ formId: 'app', xlsform: bad }])).length,
      1,
      prefix,
    );
  }
});

test('inputs/meta/* needs no declaration — measured, it really is injected', () => {
  // cht-core's own PLACE_TYPE-create.xlsx contains
  //   concat(../../inputs/meta/location/lat, concat(' ', …/long))
  // with no `meta` group declared anywhere, and it deploys. 31 forms across
  // the four real configs and our four templates do this, so requiring a
  // declaration here would flag all of them — including our own.
  const form = mkForm([
    ...inputsBlock(),
    surveyRow('calculate', 'geolocation', {
      calculation:
        "concat(../../inputs/meta/location/lat, concat(' ', ../../inputs/meta/location/long))",
    }),
  ]);
  assert.deepEqual(runDanglingRefsRule(mkContext([{ formId: 'app', xlsform: form }])), []);
});

test('a top-level question named `name` does NOT satisfy inputs/contact/name', () => {
  // The distinction a flattened name-set cannot make: these are different
  // nodes and only one of them makes the xpath resolve.
  const form = mkForm([
    surveyRow('begin group', 'inputs'),
    surveyRow('begin group', 'contact'),
    surveyRow('hidden', '_id'),
    surveyRow('end group', 'contact'),
    surveyRow('end group', 'inputs'),
    surveyRow('string', 'name'),
    surveyRow('calculate', 'patient_name', { calculation: '../inputs/contact/name' }),
  ]);
  assert.equal(
    runDanglingRefsRule(mkContext([{ formId: 'app', xlsform: form }])).length,
    1,
    'the decoy must not satisfy the reference',
  );
});

test('a `contact` group outside inputs does not declare inputs/contact/*', () => {
  const form = mkForm([
    surveyRow('begin group', 'household'),
    surveyRow('begin group', 'contact'),
    surveyRow('hidden', 'sex'),
    surveyRow('end group', 'contact'),
    surveyRow('end group', 'household'),
    surveyRow('calculate', 'patient_sex', { calculation: '../inputs/contact/sex' }),
  ]);
  assert.equal(runDanglingRefsRule(mkContext([{ formId: 'app', xlsform: form }])).length, 1);
});

test('unknown ref → error with column populated', () => {
  const bad = surveyRow('note', 'msg', { relevant: '${nonexistent} = 1' });
  const form = mkForm([bad]);
  const results = runDanglingRefsRule(mkContext([{ formId: 'app', xlsform: form }]));
  assert.equal(results.length, 1);
  const r = results[0]!;
  assert.equal(r.ruleId, 'dangling-refs');
  assert.equal(r.severity, 'error');
  assert.equal(r.affectedItemId, 'app');
  assert.equal(r.rowId, bad.rowId);
  assert.equal(r.column, 'relevant');
});

test('empty braces ${} → error labelled "Empty"', () => {
  const bad = surveyRow('calculate', 'x', { calculation: '${} + 1' });
  const form = mkForm([bad]);
  const results = runDanglingRefsRule(mkContext([{ formId: 'app', xlsform: form }]));
  assert.equal(results.length, 1);
  assert.equal(results[0]!.column, 'calculation');
  assert.match(results[0]!.message, /Empty/);
});

test('whitespace-only ${ } → error', () => {
  const bad = surveyRow('calculate', 'x', { calculation: '${   } + 1' });
  const form = mkForm([bad]);
  const results = runDanglingRefsRule(mkContext([{ formId: 'app', xlsform: form }]));
  assert.equal(results.length, 1);
  assert.match(results[0]!.message, /Empty/);
});

test('path-shaped ref resolves on last segment', () => {
  const form = mkForm([
    surveyRow('integer', 'age'),
    surveyRow('note', 'msg', { relevant: '${/data/group/age} > 18' }),
  ]);
  assert.deepEqual(runDanglingRefsRule(mkContext([{ formId: 'app', xlsform: form }])), []);
});

test('substring collision: ${age_years} does NOT resolve to `age`', () => {
  const form = mkForm([
    surveyRow('integer', 'age'),
    surveyRow('note', 'msg', { relevant: '${age_years} > 18' }),
  ]);
  const results = runDanglingRefsRule(mkContext([{ formId: 'app', xlsform: form }]));
  assert.equal(results.length, 1);
});

test('scans multiple ref columns — one bad ref per column', () => {
  const bad = surveyRow('integer', 'age', {
    relevant: '${nope}',
    calculation: '${also_nope}',
    constraint: '${ok}',
  });
  const ok = surveyRow('integer', 'ok');
  const form = mkForm([ok, bad]);
  const results = runDanglingRefsRule(mkContext([{ formId: 'app', xlsform: form }]));
  assert.equal(results.length, 2);
  const cols = results.map((r) => r.column).sort();
  assert.deepEqual(cols, ['calculation', 'relevant']);
});

test('scans label::en for ${output} refs', () => {
  const form = mkForm([
    surveyRow('note', 'greeting', {}, { en: 'Hello ${nope}' }),
  ]);
  const results = runDanglingRefsRule(mkContext([{ formId: 'app', xlsform: form }]));
  assert.equal(results.length, 1);
  assert.equal(results[0]!.column, 'label::en');
});

test('scans hint::en columns via extras', () => {
  const form = mkForm([
    surveyRow('note', 'q', { 'hint::en': 'See ${missing}' }),
  ]);
  const results = runDanglingRefsRule(mkContext([{ formId: 'app', xlsform: form }]));
  assert.equal(results.length, 1);
  assert.equal(results[0]!.column, 'hint::en');
});

test('multiple ${} tokens in one cell → one result per token', () => {
  const bad = surveyRow('note', 'msg', { relevant: '${nope1} > 0 and ${nope2} > 0' });
  const form = mkForm([bad]);
  const results = runDanglingRefsRule(mkContext([{ formId: 'app', xlsform: form }]));
  assert.equal(results.length, 2);
});
