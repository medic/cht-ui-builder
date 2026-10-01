/**
 * T9a (#14) — `.` as a subject, `../field` as an alias of `${field}`, the
 * function forms real configs use on `.`, and the always-true placeholder.
 *
 * Every positive test here CALLS THE SERIALIZER and starts from a
 * NON-CANONICAL fixture (`.<=100`, `(.)>=1 and (.)<=7`, `regex(.,'…')`): a
 * parser-only test, or a fixture that is already canonical, cannot detect
 * normalisation (plan README invariant 3). The structural half asserts the
 * rule kinds so a regression to raw is caught too.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  parseRelevant,
  parseRelevantGrouped,
  serializeAnyParsed,
  serializeRelevant,
  serializeRule,
  type ExprComparisonRule,
  type Rule,
} from './relevantParser.js';

function kinds(src: string): string[] {
  const p = parseRelevantGrouped(src);
  const rules = 'subgroups' in p ? p.subgroups.flatMap((s) => s.rules) : p.rules;
  return rules.map((r) => r.kind);
}

/** Byte identity through the serializer, and no raw fallback. */
function assertStructuredRoundTrip(src: string, expectedKinds: string[]): void {
  const p = parseRelevantGrouped(src);
  assert.equal(p.isRawFallback, false, `expected structured parse for: ${src}`);
  assert.deepEqual(kinds(src), expectedKinds, `kinds for: ${src}`);
  assert.equal(serializeAnyParsed(p), src, `must re-emit as written: ${src}`);
}

/* ------------------------------ `.` subject ------------------------------ */

test('self subject: tight and spaced spellings both open as expr-comparison and save back unchanged', () => {
  assertStructuredRoundTrip('.<=100', ['expr-comparison']);
  assertStructuredRoundTrip('. <= 100', ['expr-comparison']);
  assertStructuredRoundTrip('.>= 36.5 and .<= 40', ['expr-comparison', 'expr-comparison']);
  assertStructuredRoundTrip('(.)>=1 and (.)<=7', ['expr-comparison', 'expr-comparison']);
  // Reverse operand order is preserved, not sorted into "between".
  assertStructuredRoundTrip('. <= 100 and . >= 70', ['expr-comparison', 'expr-comparison']);
});

test('self subject: values may be a number, a string, ${field}, ../field, today() ± N, date(…)', () => {
  assertStructuredRoundTrip('. = 9841', ['expr-comparison']);
  assertStructuredRoundTrip(". != ''", ['expr-comparison']);
  assertStructuredRoundTrip('. <= ${age_in_years}', ['expr-comparison']);
  assertStructuredRoundTrip('. > ../lmp_date', ['expr-comparison']);
  assertStructuredRoundTrip('. <= today()', ['expr-comparison']);
  assertStructuredRoundTrip('. <= today() - 30 and . >= today() - 294', ['expr-comparison', 'expr-comparison']);
  assertStructuredRoundTrip(". >= date('2026-08-05')", ['expr-comparison']);
  const p = parseRelevant('. > ../lmp_date');
  const r = p.rules[0] as ExprComparisonRule;
  assert.deepEqual(r.lhs, { kind: 'self' });
  assert.deepEqual(r.rhs, { kind: 'field', name: 'lmp_date', spelling: 'relative' });
});

test('self subject: the function forms real configs use', () => {
  assertStructuredRoundTrip('string-length(.) <= 100', ['expr-comparison']);
  assertStructuredRoundTrip('string-length(.)=10', ['expr-comparison']);
  assertStructuredRoundTrip("regex(.,'^([^0-9]*)$')", ['predicate']);
  assertStructuredRoundTrip("regex(., '^9[78][0-9]{8}$')", ['predicate']);
  assertStructuredRoundTrip("selected(., 'none')", ['predicate']);
  assertStructuredRoundTrip("not(selected(., 'other')) or count-selected(.) = 1", ['predicate', 'expr-comparison']);
  assertStructuredRoundTrip('count-selected(.) <= ${L2}', ['expr-comparison']);
  assertStructuredRoundTrip('int(.) > 0', ['expr-comparison']);
  assertStructuredRoundTrip("int(format-date(.,'%Y')) >= 1990", ['expr-comparison']);
  assertStructuredRoundTrip("int(format-date(today(),'%Y')) + 57 >= int(.)", ['expr-comparison']);
  assertStructuredRoundTrip('. > max(coalesce(${visit_first_date}, 0), coalesce(${visit_second_date}, 0))', ['expr-comparison']);
  assertStructuredRoundTrip('. >= add-date(today(), 0, 0, -294)', ['expr-comparison']);
  assertStructuredRoundTrip('difference-in-months(., today()) > 3', ['expr-comparison']);
  assertStructuredRoundTrip('decimal-date-time(.) <= decimal-date-time(today()) + 30', ['expr-comparison']);
  assertStructuredRoundTrip(
    'floor( difference-in-months( ${date_of_birth}, today() ) div 12 ) >= 15',
    ['expr-comparison'],
  );
});

test('self subject: "[None] must be chosen alone" is a negated group of structured rules', () => {
  const src = "not(selected(., 'none') and count-selected(.) > 1)";
  assertStructuredRoundTrip(src, ['not-group']);
  const r = parseRelevant(src).rules[0]!;
  assert.equal(r.kind, 'not-group');
  if (r.kind === 'not-group') {
    assert.equal(r.combinator, 'and');
    assert.deepEqual(r.rules.map((x) => x.kind), ['predicate', 'expr-comparison']);
  }
  // Tight-spaced inner chain, same shape.
  assertStructuredRoundTrip("not(selected(.,'none') and count-selected(.)>1)", ['not-group']);
});

test('always-true: `true`, `true()` and `1` are a labelled kind and are never rewritten', () => {
  for (const src of ['true', 'true()', '1']) {
    const p = parseRelevant(src);
    assert.equal(p.rules[0]?.kind, 'always-true', src);
    assert.equal(serializeRelevant(p), src);
  }
});

/* ------------------------------ `../field` ------------------------------- */

test('../field: alias of ${field} on every field-subject kind, re-emitted exactly as written', () => {
  const cases: Array<[string, string]> = [
    ["../lmp_approx = 'approx_weeks'", 'comparison'],
    ['../gravidity > 3', 'comparison'],
    ["selected(../lmp_approx, 'approx_weeks')", 'selected'],
    ["not(selected(../danger_signs, 'none'))", 'selected'],
    ["../lmp_date_8601 != ''", 'answered'],
    ["../lmp_date_8601 = ''", 'answered'],
    ['../lmp_approx', 'truthy'],
    ['not(../lmp_approx)', 'truthy'],
  ];
  for (const [src, kind] of cases) {
    const p = parseRelevant(src);
    assert.equal(p.isRawFallback, false, src);
    assert.equal(p.rules[0]?.kind, kind, src);
    const r = p.rules[0] as Rule & { refSpelling?: string; field?: string };
    assert.equal(r.refSpelling, 'relative', src);
    assert.equal(serializeRelevant(p), src, `never rewritten to \${}: ${src}`);
    // Flipping the spelling flag is the ONLY way to get the ${} form.
    const braces = serializeRule({ ...r, refSpelling: undefined } as Rule);
    assert.ok(braces.includes('${'), `canonical form uses \${}: ${braces}`);
    assert.notEqual(braces, src);
  }
});

test('../field: a ${} rule is never rewritten to ../ either', () => {
  const src = "${lmp_approx} = 'approx_weeks' and selected(${danger_signs}, 'none')";
  assert.equal(serializeRelevant(parseRelevant(src)), src);
  assert.equal(parseRelevant("${a} = ../b").rules[0]?.kind, 'comparison');
  assert.equal(serializeRelevant(parseRelevant('${a} = ../b')), '${a} = ../b');
});

test('../field: hostile fixtures from the analysis — mixed spellings in one chain, grouped', () => {
  assertStructuredRoundTrip(
    "selected(../lmp_approx, 'approx_weeks') and ${lmp_date} != ''",
    ['selected', 'answered'],
  );
  assertStructuredRoundTrip(
    "(../lmp_approx = 'approx_weeks' and ../lmp_date_8601 != '') or ${gravidity} > 3",
    ['comparison', 'answered', 'comparison'],
  );
});

test('../field: multi-segment paths and the contact-input reference are not the alias', () => {
  // Contact input keeps its own kind.
  const ci = parseRelevant("../inputs/contact/sex = 'female'");
  assert.equal(ci.rules[0]?.kind, 'contact-input-comparison');
  assert.equal(serializeRelevant(ci), "../inputs/contact/sex = 'female'");
  // Anything else with a slash stays raw and byte-identical.
  const raw = parseRelevant('../group/field = 1');
  assert.equal(raw.isRawFallback, true);
  assert.equal(serializeRelevant(raw), '../group/field = 1');
});

/* ------------------------- self-check stays authoritative ------------------ */

test('self-check: an all-raw chain with a double space is ONE raw rule, byte-identical', () => {
  // Before T9a the split parts were rejoined with single spaces, one byte
  // off from the cell. Six distinct real constraints have this shape.
  const src = "int(format-date(.,'%Y')) >= 1987 and  frobnicate(.) and  . < today()";
  const p = parseRelevant(src);
  assert.equal(p.isRawFallback, true);
  assert.equal(p.rules.length, 1);
  assert.equal(p.rules[0]?.kind, 'raw');
  assert.equal(serializeRelevant(p), src);
});

test('self-check: chain-level spacing variants stay raw and byte-identical even when every part is structured', () => {
  for (const src of ["selected(., 'a') and  . != 1", '. <= 100 AND . >= 70', '. <= 100 and\n. >= 70']) {
    const p = parseRelevant(src);
    assert.equal(p.isRawFallback, true, src);
    assert.equal(serializeRelevant(p), src);
  }
});

test('source: a consumer that edits a parsed rule gets canonical spacing for THAT rule only', () => {
  const p = parseRelevant('.<=100 and .>= 36.5');
  const edited = { ...(p.rules[0] as ExprComparisonRule), op: '<' as const };
  const out = serializeRelevant({ ...p, rules: [edited, p.rules[1]!] });
  // The stale `source` (`.<=100`) no longer describes `<`, so it is dropped;
  // the untouched sibling keeps its own spelling.
  assert.equal(out, '. < 100 and .>= 36.5');
});

test('source: a rule built from scratch (no source) emits canonical spacing', () => {
  const fresh: Rule = {
    kind: 'expr-comparison',
    lhs: { kind: 'self' },
    op: '>=',
    rhs: { kind: 'number', text: '0' },
  };
  assert.equal(serializeRule(fresh), '. >= 0');
  const pred: Rule = {
    kind: 'predicate',
    fn: 'regex',
    args: [{ kind: 'self' }, { kind: 'string', value: '^[0-9]*$', quote: "'" }],
    negated: false,
  };
  assert.equal(serializeRule(pred), "regex(., '^[0-9]*$')");
  const group: Rule = {
    kind: 'not-group',
    combinator: 'and',
    rules: [
      pred,
      {
        kind: 'expr-comparison',
        lhs: { kind: 'call', fn: 'count-selected', args: [{ kind: 'self' }] },
        op: '>',
        rhs: { kind: 'number', text: '1' },
      },
    ],
  };
  assert.equal(serializeRule(group), "not(regex(., '^[0-9]*$') and count-selected(.) > 1)");
  // And what it emits parses back to the same thing (no raw).
  assert.equal(parseRelevant(serializeRule(group)).rules[0]?.kind, 'not-group');
});

test('additive: every ${field}-subject fixture from before T9a parses to the same kind', () => {
  const unchanged: Array<[string, string]> = [
    ["${sex} = 'female'", 'comparison'],
    ['${age} >= 15', 'comparison'],
    ["selected(${conds}, 'x')", 'selected'],
    ["not(selected(${conds}, 'none'))", 'selected'],
    ["${f} != ''", 'answered'],
    ['${f}', 'truthy'],
    ['today() - ${visit_date} < 30', 'date_offset'],
    ['floor((today() - ${dob}) div 365.25) > 20', 'age'],
    ["../inputs/contact/sex = 'female'", 'contact-input-comparison'],
    ["instance('contact-summary')/context/show_pregnancy = 'true'", 'contact-summary-comparison'],
  ];
  for (const [src, kind] of unchanged) {
    assert.equal(parseRelevant(src).rules[0]?.kind, kind, src);
    assert.equal(serializeRelevant(parseRelevant(src)), src);
  }
  // And the canonical-only policy for ${}-subject spacing is untouched.
  assert.equal(parseRelevant("${a}='x'").isRawFallback, true);
});
