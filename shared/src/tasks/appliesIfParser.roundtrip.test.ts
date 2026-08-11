/**
 * Round-trip + numeric-operator tests for the appliesIf parser.
 *
 * Run via `node --test --import tsx shared/src/tasks/appliesIfParser.roundtrip.test.ts`
 * (or any test runner that consumes node:test).
 *
 * These exist to defend two invariants that broke real configs in the past:
 *   1. parse → serialize → parse is stable (no diff drift on open+save).
 *   2. Numeric comparisons (`age > 20`) survive a round trip; previously
 *      the parser fell back to `raw` and the structured row vanished.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseAppliesIf, serializeAppliesIf } from './appliesIfParser.js';

function roundTrip(source: string): string {
  return serializeAppliesIf(parseAppliesIf(source));
}

test('numeric `>` survives parse → serialize → parse', () => {
  const src = `function (contact, report) {
  if (contact.contact.age <= 20) { return false; }
  return true;
}`;
  const first = parseAppliesIf(src);
  assert.equal(first.rules.length, 1);
  const rule = first.rules[0];
  assert.equal(rule?.kind, 'contact_field');
  if (rule?.kind === 'contact_field') {
    assert.equal(rule.field, 'age');
    assert.equal(rule.op, '>');
    assert.equal(rule.value, '20');
  }
  const second = parseAppliesIf(roundTrip(src));
  assert.deepEqual(first.rules, second.rules);
});

test('string equality still round-trips', () => {
  const src = `function (contact) {
  if (contact.contact.role !== 'patient') { return false; }
  return true;
}`;
  const first = parseAppliesIf(src);
  assert.equal(first.rules[0]?.kind, 'contact_field');
  if (first.rules[0]?.kind === 'contact_field') {
    assert.equal(first.rules[0].op, '===');
    assert.equal(first.rules[0].value, 'patient');
  }
  const second = parseAppliesIf(roundTrip(src));
  assert.deepEqual(first.rules, second.rules);
});

test('OR-grouped guards do not explode into multiple lines on serialize', () => {
  const src = `function (contact, report) {
  if (!isTaskUser(user) || !isAlive(contact.contact) || isMuted(contact.contact) || hasError(report)) { return false; }
  return true;
}`;
  const serialized = roundTrip(src);
  const ifCount = (serialized.match(/\bif\b/g) ?? []).length;
  assert.equal(ifCount, 1, `expected one combined guard, got: ${serialized}`);
});

test('numeric guard inversion is exact (no off-by-one)', () => {
  // age > 20: guard becomes age <= 20, then back to age > 20.
  const rule = parseAppliesIf(
    `function (contact) { if (contact.contact.age <= 20) { return false; } return true; }`,
  ).rules[0];
  assert.equal(rule?.kind, 'contact_field');
  if (rule?.kind === 'contact_field') assert.equal(rule.op, '>');

  // age >= 20: guard becomes age < 20.
  const rule2 = parseAppliesIf(
    `function (contact) { if (contact.contact.age < 20) { return false; } return true; }`,
  ).rules[0];
  if (rule2?.kind === 'contact_field') assert.equal(rule2.op, '>=');
});

test('decimal values round-trip', () => {
  const src = `function (contact) {
  if (contact.contact.bmi < 18.5) { return false; }
  return true;
}`;
  const first = parseAppliesIf(src);
  if (first.rules[0]?.kind === 'contact_field') {
    assert.equal(first.rules[0].op, '>=');
    assert.equal(first.rules[0].value, '18.5');
  }
  const second = parseAppliesIf(roundTrip(src));
  assert.deepEqual(first.rules, second.rules);
});

test('negative values round-trip', () => {
  const src = `function (contact) {
  if (contact.contact.score <= -1) { return false; }
  return true;
}`;
  const first = parseAppliesIf(src);
  if (first.rules[0]?.kind === 'contact_field') {
    assert.equal(first.rules[0].op, '>');
    assert.equal(first.rules[0].value, '-1');
  }
  const second = parseAppliesIf(roundTrip(src));
  assert.deepEqual(first.rules, second.rules);
});

test('report_field numeric round-trip', () => {
  const src = `function (contact, report) {
  if (getField(report, 'weight') < 50) { return false; }
  return true;
}`;
  const first = parseAppliesIf(src);
  if (first.rules[0]?.kind === 'report_field') {
    assert.equal(first.rules[0].field, 'weight');
    assert.equal(first.rules[0].op, '>=');
    assert.equal(first.rules[0].value, '50');
  }
  assert.deepEqual(first.rules, parseAppliesIf(roundTrip(src)).rules);
});

test('mixed guard + return clauses preserve guard grouping', () => {
  const src = `function (contact, report) {
  if (!isAlive(contact.contact) || isMuted(contact.contact)) { return false; }
  return contact.contact.role === 'patient';
}`;
  const serialized = roundTrip(src);
  assert.match(serialized, /!isAlive\(contact\.contact\) \|\| isMuted\(contact\.contact\)/);
});

/* ============ field_presence — "is set" / "is not set" ============ */

test('field_presence: report field IS set (positive `!!getField`)', () => {
  const src = `function (contact, report) {
  return !!getField(report, 'lmp_date');
}`;
  const parsed = parseAppliesIf(src);
  assert.equal(parsed.rules.length, 1);
  const r = parsed.rules[0]!;
  assert.equal(r.kind, 'field_presence');
  if (r.kind === 'field_presence') {
    assert.equal(r.source, 'report');
    assert.equal(r.field, 'lmp_date');
    assert.equal(r.negated, false);
  }
  // Round-trip: parse → serialize → parse must land on the same rule
  const twice = parseAppliesIf(roundTrip(src));
  assert.deepEqual(twice.rules, parsed.rules);
});

test('field_presence: report field is NOT set (positive `!getField`) — via guard', () => {
  // Source uses the guard form: exit when field IS set (i.e. positive
  // = "not set"). Should round-trip via field_presence negated=true.
  const src = `function (contact, report) {
  if (getField(report, 'lmp_date')) { return false; }
  return true;
}`;
  const parsed = parseAppliesIf(src);
  // Guard `getField(...)` (truthy → exit) is a raw for the parser since
  // we only pattern-match `!` / `!!` at classify time. Let's test the
  // return-form instead.
  void parsed;
  const src2 = `function (contact, report) {
  return !getField(report, 'lmp_date');
}`;
  const p2 = parseAppliesIf(src2);
  assert.equal(p2.rules[0]?.kind, 'field_presence');
  if (p2.rules[0]?.kind === 'field_presence') {
    assert.equal(p2.rules[0].negated, true);
  }
  assert.deepEqual(parseAppliesIf(roundTrip(src2)).rules, p2.rules);
});

test('field_presence: contact field IS set (`!!contact.contact.role`)', () => {
  const src = `function (contact, report) {
  return !!contact.contact.role;
}`;
  const parsed = parseAppliesIf(src);
  assert.equal(parsed.rules[0]?.kind, 'field_presence');
  if (parsed.rules[0]?.kind === 'field_presence') {
    assert.equal(parsed.rules[0].source, 'contact');
    assert.equal(parsed.rules[0].field, 'role');
    assert.equal(parsed.rules[0].negated, false);
  }
  assert.deepEqual(parseAppliesIf(roundTrip(src)).rules, parsed.rules);
});

test('field_presence: contact field is NOT set (`!contact.contact.date_of_death`)', () => {
  const src = `function (contact, report) {
  return !contact.contact.date_of_death;
}`;
  const parsed = parseAppliesIf(src);
  assert.equal(parsed.rules[0]?.kind, 'field_presence');
  if (parsed.rules[0]?.kind === 'field_presence') {
    assert.equal(parsed.rules[0].source, 'contact');
    assert.equal(parsed.rules[0].field, 'date_of_death');
    assert.equal(parsed.rules[0].negated, true);
  }
});

/* ============ field_age — days/weeks/months before today ============ */

test('field_age: report field weeks-old comparison round-trips (>= 42 weeks)', () => {
  const src = `function (contact, report) {
  return (Date.now() - new Date(getField(report, 'lmp_date')).getTime()) / 604800000 >= 42;
}`;
  const parsed = parseAppliesIf(src);
  assert.equal(parsed.rules[0]?.kind, 'field_age');
  if (parsed.rules[0]?.kind === 'field_age') {
    assert.equal(parsed.rules[0].source, 'report');
    assert.equal(parsed.rules[0].field, 'lmp_date');
    assert.equal(parsed.rules[0].unit, 'weeks');
    assert.equal(parsed.rules[0].op, '>=');
    assert.equal(parsed.rules[0].value, 42);
  }
  assert.deepEqual(parseAppliesIf(roundTrip(src)).rules, parsed.rules);
});

test('field_age: contact field days-old comparison (< 30 days)', () => {
  const src = `function (contact, report) {
  return (Date.now() - new Date(contact.contact.date_of_birth).getTime()) / 86400000 < 30;
}`;
  const parsed = parseAppliesIf(src);
  assert.equal(parsed.rules[0]?.kind, 'field_age');
  if (parsed.rules[0]?.kind === 'field_age') {
    assert.equal(parsed.rules[0].source, 'contact');
    assert.equal(parsed.rules[0].field, 'date_of_birth');
    assert.equal(parsed.rules[0].unit, 'days');
    assert.equal(parsed.rules[0].op, '<');
    assert.equal(parsed.rules[0].value, 30);
  }
  assert.deepEqual(parseAppliesIf(roundTrip(src)).rules, parsed.rules);
});

test('field_age: months unit uses avg 30.4375d multiplier', () => {
  const src = `function (contact, report) {
  return (Date.now() - new Date(getField(report, 'last_visit')).getTime()) / 2629800000 >= 6;
}`;
  const parsed = parseAppliesIf(src);
  assert.equal(parsed.rules[0]?.kind, 'field_age');
  if (parsed.rules[0]?.kind === 'field_age') {
    assert.equal(parsed.rules[0].unit, 'months');
    assert.equal(parsed.rules[0].value, 6);
  }
});

test('field_age: unknown ms multiplier falls back to raw (preserves hand-picked constant)', () => {
  // A project-authored constant we don't recognize (e.g. 500000) should
  // stay raw so the user's expression survives round-trip.
  const src = `function (contact, report) {
  return (Date.now() - new Date(getField(report, 'lmp_date')).getTime()) / 500000 >= 42;
}`;
  const parsed = parseAppliesIf(src);
  assert.equal(parsed.rules[0]?.kind, 'raw');
});

/* ============ field_age_between — "at least N and at most M" ============ */

test('field_age_between: guard OR-form fuses on parse into a single between rule', () => {
  // Real config shape: `if (age < 84 || age > 90) return false;` — parser
  // yields two field_age rules with the same guardGroup, then the fusion
  // pass collapses them into one field_age_between.
  const src = `function (contact, report) {
  if ((Date.now() - new Date(getField(report, 'lmp_date')).getTime()) / 86400000 < 84 || (Date.now() - new Date(getField(report, 'lmp_date')).getTime()) / 86400000 > 90) { return false; }
  return true;
}`;
  const parsed = parseAppliesIf(src);
  assert.equal(parsed.rules.length, 1);
  const r = parsed.rules[0]!;
  assert.equal(r.kind, 'field_age_between');
  if (r.kind === 'field_age_between') {
    assert.equal(r.source, 'report');
    assert.equal(r.field, 'lmp_date');
    assert.equal(r.unit, 'days');
    assert.equal(r.min, 84);
    assert.equal(r.max, 90);
    assert.equal(r.minOp, '>=');
    assert.equal(r.maxOp, '<=');
  }
});

test('field_age_between: round-trips (parse → serialize → parse is stable)', () => {
  const src = `function (contact, report) {
  if ((Date.now() - new Date(getField(report, 'lmp_date')).getTime()) / 86400000 < 84 || (Date.now() - new Date(getField(report, 'lmp_date')).getTime()) / 86400000 > 90) { return false; }
  return true;
}`;
  const parsed = parseAppliesIf(src);
  const twice = parseAppliesIf(serializeAppliesIf(parsed));
  assert.deepEqual(twice.rules, parsed.rules);
});

test('field_age_between: min-side and max-side in any order fuse the same way', () => {
  // A hand-written source might put the max first then min — the fusion
  // must produce the same between rule regardless of order.
  const src = `function (contact, report) {
  if ((Date.now() - new Date(getField(report, 'lmp_date')).getTime()) / 86400000 > 90 || (Date.now() - new Date(getField(report, 'lmp_date')).getTime()) / 86400000 < 84) { return false; }
  return true;
}`;
  const parsed = parseAppliesIf(src);
  assert.equal(parsed.rules.length, 1);
  if (parsed.rules[0]?.kind === 'field_age_between') {
    assert.equal(parsed.rules[0].min, 84);
    assert.equal(parsed.rules[0].max, 90);
  } else {
    assert.fail('expected field_age_between');
  }
});

test('field_age_between: exclusive endpoints (more than / less than) round-trip', () => {
  // Positive: age > 84 AND age < 90 → guard: age <= 84 || age >= 90.
  const src = `function (contact, report) {
  if ((Date.now() - new Date(getField(report, 'lmp_date')).getTime()) / 86400000 <= 84 || (Date.now() - new Date(getField(report, 'lmp_date')).getTime()) / 86400000 >= 90) { return false; }
  return true;
}`;
  const parsed = parseAppliesIf(src);
  if (parsed.rules[0]?.kind === 'field_age_between') {
    assert.equal(parsed.rules[0].minOp, '>');
    assert.equal(parsed.rules[0].maxOp, '<');
    assert.equal(parsed.rules[0].min, 84);
    assert.equal(parsed.rules[0].max, 90);
  } else {
    assert.fail('expected field_age_between');
  }
  const twice = parseAppliesIf(serializeAppliesIf(parsed));
  assert.deepEqual(twice.rules, parsed.rules);
});

test('field_age_between: DIFFERENT fields do NOT fuse (safety)', () => {
  // Two field_age rules that happen to share source/unit but reference
  // different fields must NOT collapse into a between — that would silently
  // change the semantics.
  const src = `function (contact, report) {
  if ((Date.now() - new Date(getField(report, 'lmp_date')).getTime()) / 86400000 < 84 || (Date.now() - new Date(getField(report, 'due_date')).getTime()) / 86400000 > 90) { return false; }
  return true;
}`;
  const parsed = parseAppliesIf(src);
  assert.equal(parsed.rules.length, 2, 'different fields must stay as two rules');
  assert.equal(parsed.rules[0]?.kind, 'field_age');
  assert.equal(parsed.rules[1]?.kind, 'field_age');
});

test('field_age_between: DIFFERENT units do NOT fuse (safety)', () => {
  const src = `function (contact, report) {
  if ((Date.now() - new Date(getField(report, 'lmp_date')).getTime()) / 86400000 < 84 || (Date.now() - new Date(getField(report, 'lmp_date')).getTime()) / 604800000 > 12) { return false; }
  return true;
}`;
  const parsed = parseAppliesIf(src);
  assert.equal(parsed.rules.length, 2);
});

test('cht-eslint-safe: serialized output uses Utils.getField (NOT bare getField) + single quotes', () => {
  // Regression: cht compile-app-settings runs eslint (single-quote rule)
  // and webpack (no-undef) over tasks.js. Bare `getField` was undefined;
  // double-quoted strings failed the quotes rule. Both must be single-
  // quoted, and every `getField` reference must be `Utils.getField`.
  const p = parseAppliesIf(`function (contact, report) {
  return !!Utils.getField(report, 'lmp_date');
}`);
  const out = serializeAppliesIf(p);
  assert.match(out, /Utils\.getField/);
  assert.equal(/\bgetField\(report/.test(out.replace(/Utils\.getField/g, '')), false,
    'no bare getField(report...) anywhere in the serialized output');
  assert.equal(/"[^"]*"/.test(out), false, 'no double-quoted strings');
});

test('parse accepts BOTH bare getField and Utils.getField (back-compat with old configs)', () => {
  const bare = parseAppliesIf(`function (contact, report) { return !!getField(report, 'x'); }`);
  const withUtils = parseAppliesIf(`function (contact, report) { return !!Utils.getField(report, 'x'); }`);
  assert.equal(bare.rules[0]?.kind, 'field_presence');
  assert.equal(withUtils.rules[0]?.kind, 'field_presence');
});

test('field_age_between: UI-created (undefined guardGroup) also fuses on adjacent field_age pairs', () => {
  // If a user hand-writes `return X >= 84 && X <= 90;` (rather than the
  // guard-OR form), the parser produces two field_age rules with undefined
  // guardGroup. Fusion should collapse those too.
  const src = `function (contact, report) {
  return (Date.now() - new Date(getField(report, 'lmp_date')).getTime()) / 86400000 >= 84 && (Date.now() - new Date(getField(report, 'lmp_date')).getTime()) / 86400000 <= 90;
}`;
  const parsed = parseAppliesIf(src);
  assert.equal(parsed.rules.length, 1);
  assert.equal(parsed.rules[0]?.kind, 'field_age_between');
});

/* ============ Geriatric §3 — OR authoring (orGroups channel) ============ */

test('OR group: author-side emit → parse returns the same OR-joined structure', () => {
  // The nutrition case: "फेल selected for option A OR option B". The
  // builder marks two report_field rules with a shared orGroup id; the
  // serializer must emit the ¬(A ∨ B) guard — inverted comparisons joined
  // with && — and the parser must lift that back into ONE or-group of the
  // ORIGINAL positive rules.
  const authored = {
    params: ['contact', 'report'],
    rules: [
      { kind: 'report_field' as const, field: 'iha.option_a', op: '===' as const, value: 'फेल' },
      { kind: 'report_field' as const, field: 'iha.option_b', op: '===' as const, value: 'फेल' },
    ],
    guardGroups: [undefined, undefined],
    orGroups: [0, 0],
    hasRawFallback: false,
    body: '',
  };
  const out = serializeAppliesIf(authored);
  assert.match(
    out,
    /if \(Utils\.getField\(report, 'iha\.option_a'\) !== 'फेल' && Utils\.getField\(report, 'iha\.option_b'\) !== 'फेल'\) \{ return false; \}/,
    'OR of positives serializes as the &&-joined inverted guard',
  );

  const back = parseAppliesIf(out);
  assert.equal(back.rules.length, 2);
  assert.deepEqual(back.rules[0], authored.rules[0]);
  assert.deepEqual(back.rules[1], authored.rules[1]);
  assert.ok(back.orGroups[0] !== undefined, 'first rule is in an or-group');
  assert.equal(back.orGroups[0], back.orGroups[1], 'both rules share the or-group');
  assert.equal(back.guardGroups[0], undefined);
  assert.equal(back.hasRawFallback, false, 'round-trips structured, not raw');
});

test('OR group round-trip is a fixpoint: serialize → parse → serialize is byte-stable', () => {
  const src = `function (contact, report) {
  if (Utils.getField(report, 'a') !== 'फेल' && Utils.getField(report, 'b') !== 'फेल') { return false; }
  return true;
}`;
  const p1 = parseAppliesIf(src);
  const s1 = serializeAppliesIf(p1);
  const p2 = parseAppliesIf(s1);
  const s2 = serializeAppliesIf(p2);
  assert.equal(s1, src, 'no-op open+save of an OR guard is byte-stable');
  assert.equal(s2, s1);
});

test('(A || B) && C — OR group then AND rule serialize as two guards', () => {
  const authored = {
    params: ['contact', 'report'],
    rules: [
      { kind: 'report_field' as const, field: 'a', op: '===' as const, value: 'x' },
      { kind: 'report_field' as const, field: 'b', op: '===' as const, value: 'x' },
      { kind: 'contact_field' as const, field: 'role', op: '===' as const, value: 'patient' },
    ],
    guardGroups: [undefined, undefined, undefined],
    orGroups: [0, 0, undefined],
    hasRawFallback: false,
    body: '',
  };
  const out = serializeAppliesIf(authored);
  const lines = out.split('\n');
  assert.equal(lines.filter((l) => l.trim().startsWith('if (')).length, 2, 'two guard lines');
  const back = parseAppliesIf(out);
  assert.equal(back.rules.length, 3);
  assert.equal(back.orGroups[0], back.orGroups[1]);
  assert.equal(back.orGroups[2], undefined, 'C stays AND-combined');
});

test('pure-AND fixture is byte-unchanged on no-op open/save (orGroups untouched)', () => {
  const src = `function (contact, report) {
  if (!isAlive(contact.contact)) { return false; }
  if (Utils.getField(report, 'x') !== 'yes') { return false; }
  return true;
}`;
  assert.equal(serializeAppliesIf(parseAppliesIf(src)), src);
  assert.deepEqual(parseAppliesIf(src).orGroups, [undefined, undefined]);
});

test('&&-guard with an unclassifiable conjunct stays ONE raw guard (no partial lift)', () => {
  // A raw conjunct cannot be re-inverted on serialize; lifting the other
  // half would corrupt the expression. Whole condition falls back to a
  // single raw guard row — the pre-feature behavior.
  const src = `function (contact, report) {
  if (someCustomCheck(report).status !== 'ok' && Utils.getField(report, 'x') !== 'yes') { return false; }
  return true;
}`;
  const p = parseAppliesIf(src);
  assert.equal(p.rules.length, 1);
  assert.equal(p.rules[0]?.kind, 'raw');
  assert.equal(p.hasRawFallback, true, 'UI offers the Raw tab (raw text saved verbatim there)');
  assert.equal(
    (p.rules[0] as { text: string }).text,
    "someCustomCheck(report).status !== 'ok' && Utils.getField(report, 'x') !== 'yes'",
    'the whole condition is preserved in one raw rule — no partial lift',
  );
  // P0-1: with guard origin recorded explicitly, this raw guard now
  // SERIALIZES byte-stable too (the earlier version of this test could
  // not assert that — the exact gap the re-audit called out).
  assert.equal(serializeAppliesIf(p), src);
});

test('positive `return A || B` lifts into an OR group (serializes to the && guard)', () => {
  const src = `function (contact, report) {
  return Utils.getField(report, 'a') === 'x' || Utils.getField(report, 'b') === 'x';
}`;
  const p = parseAppliesIf(src);
  assert.equal(p.rules.length, 2);
  assert.equal(p.rules[0]?.kind, 'report_field');
  assert.ok(p.orGroups[0] !== undefined && p.orGroups[0] === p.orGroups[1]);
  const out = serializeAppliesIf(p);
  assert.match(out, /!== 'x' && Utils\.getField\(report, 'b'\) !== 'x'\) \{ return false; \}/);
});

test('OR-joined field_age pair does NOT fuse into a between (complement, not a range)', () => {
  // `if (age >= 84 && age <= 90) return false` means "OUTSIDE 84-90".
  // Positives are age < 84 OR age > 90 — fusing them into a between
  // would silently invert the author's logic.
  const src = `function (contact, report) {
  if ((Date.now() - new Date(Utils.getField(report, 'lmp_date')).getTime()) / 86400000 >= 84 && (Date.now() - new Date(Utils.getField(report, 'lmp_date')).getTime()) / 86400000 <= 90) { return false; }
  return true;
}`;
  const p = parseAppliesIf(src);
  assert.equal(p.rules.length, 2, 'stays two field_age rules');
  assert.equal(p.rules[0]?.kind, 'field_age');
  assert.ok(p.orGroups[0] !== undefined && p.orGroups[0] === p.orGroups[1]);
  assert.equal(serializeAppliesIf(p), src, 'byte-stable round-trip');
});

/* ==== Positive-raw serialization (bug found by the geriatric §3 e2e) ==== */

test('ungrouped raw rules are POSITIVE content, never emitted as guards', () => {
  // Before this fix, a leftover raw row (`return true;` from the parse
  // fallback, or a hand-typed positive expression) was pushed through the
  // guard path: `if (return true;) { return false; }` is invalid JS, and
  // `if (<positive expr>) { return false; }` INVERTS the author's logic.
  const withStatementRaw = serializeAppliesIf({
    params: ['contact', 'report'],
    rules: [
      { kind: 'raw', text: 'return true;' },
      { kind: 'report_field', field: 'x', op: '===', value: 'yes' },
    ],
    guardGroups: [undefined, undefined],
    orGroups: [undefined, undefined],
    hasRawFallback: true,
    body: '',
  });
  assert.equal(/if \(return/.test(withStatementRaw), false, 'no `if (return …)` invalid JS');
  assert.match(withStatementRaw, /if \(Utils\.getField\(report, 'x'\) !== 'yes'\) \{ return false; \}/);
  assert.match(withStatementRaw, /\n {2}return true;\n\}$/, 'statement raw re-emitted as body');

  const withExprRaw = serializeAppliesIf({
    params: ['contact', 'report'],
    rules: [
      { kind: 'report_field', field: 'x', op: '===', value: 'yes' },
      { kind: 'raw', text: 'customCheck(report)' },
    ],
    guardGroups: [undefined, undefined],
    orGroups: [undefined, undefined],
    hasRawFallback: true,
    body: '',
  });
  assert.match(
    withExprRaw,
    /return customCheck\(report\);/,
    'expression raw joins the positive return (not inverted into a guard)',
  );
  assert.equal(/if \(customCheck/.test(withExprRaw), false);
});

test('all-raw parse serializes to the body verbatim (no guard wrapping, no duplication)', () => {
  const src = `function (contact, report) {
  return isCovidVaccinated(contact) ? false : lastVisitDays(contact) > 30;
}`;
  const p = parseAppliesIf(src);
  assert.equal(p.rules.length, 1);
  assert.equal(p.rules[0]?.kind, 'raw');
  assert.equal(serializeAppliesIf(p), src, 'whole-body raw round-trips byte-stable');
});

test('guard-origin raw INSIDE a guardGroup stays in guard position', () => {
  // `report.fields.flag === 'x'` doesn't classify (only getField-shape
  // report reads do) → raw, but it came from a guard so it must stay in
  // its `||` guard slot, verbatim.
  const src = `function (contact, report) {
  if (report.fields.flag === 'x' || Utils.getField(report, 'x') !== 'yes') { return false; }
  return true;
}`;
  const p = parseAppliesIf(src);
  assert.equal(serializeAppliesIf(p), src, 'raw guard alternative keeps its || guard slot');
});

test('REGRESSION — helper guard round-trips without inverting (silent corruption fix)', () => {
  // `if (!isActivePregnancy(...)) return false` = the task fires ONLY for
  // active pregnancies. The old helper mapping in ruleToGuardSource
  // emitted the positive form, so one no-op open+save flipped it to
  // `if (isActivePregnancy(...)) return false` — the exact opposite.
  const src = `function (contact, report) {
  if (!isActivePregnancy(contact.contact, contact.reports, report)) { return false; }
  return true;
}`;
  const p = parseAppliesIf(src);
  assert.equal(p.rules[0]?.kind, 'helper');
  if (p.rules[0]?.kind === 'helper') assert.equal(p.rules[0].negated, false);
  assert.equal(serializeAppliesIf(p), src, 'no-op open+save is byte-stable');

  // NOT-form: positive rule "helper must NOT hold" → guard exits when it does.
  const srcNot = `function (contact, report) {
  if (isActivePregnancy(contact.contact, contact.reports, report)) { return false; }
  return true;
}`;
  const pNot = parseAppliesIf(srcNot);
  if (pNot.rules[0]?.kind === 'helper') assert.equal(pNot.rules[0].negated, true);
  assert.equal(serializeAppliesIf(pNot), srcNot);
});

/* ========= P0-1/P0-2 (re-audit 2026-08-05) — guard-origin polarity + parens ========= */
/* Every test here CALLS THE SERIALIZER — the prior regression shipped     */
/* because the one guard-origin-raw test never did.                        */

test('P0-1 — solo raw guard round-trips in guard position, byte-stable (was: inverted fail-open)', () => {
  // The re-audit's reproducer: a real CHT idiom that classifies as raw.
  // The 3fa6d39 serializer re-emitted it as `return report.form !== …;`
  // — valid JS, opposite meaning, reachable with zero edits.
  const src = `function (contact, report) {
  if (report.form !== 'pregnancy') { return false; }
  return true;
}`;
  const p = parseAppliesIf(src);
  assert.equal(p.rules[0]?.kind, 'raw');
  if (p.rules[0]?.kind === 'raw') assert.equal(p.rules[0].fromGuard, true);
  assert.equal(serializeAppliesIf(p), src);
  // Fixpoint too.
  assert.equal(serializeAppliesIf(parseAppliesIf(serializeAppliesIf(p))), src);
});

test('P0-1 — classified guard + raw guard mix is byte-stable (the re-audit regression case)', () => {
  const src = `function (contact, report) {
  if (!isAlive(contact.contact)) { return false; }
  if (report.fields.flag === 'x') { return false; }
  return true;
}`;
  assert.equal(serializeAppliesIf(parseAppliesIf(src)), src);
});

test('P0-1 — two adjacent raw guards (lumbini immunization shape) are byte-stable', () => {
  const src = `function (contact, report) {
  if (!childDob.isValid) { return false; }
  if (childAgeInYears > 5) { return false; }
  return true;
}`;
  const p = parseAppliesIf(src);
  assert.equal(p.rules.length, 2);
  assert.ok(p.rules.every((r) => r.kind === 'raw'));
  assert.equal(serializeAppliesIf(p), src);
});

test('P0-1 — positive raw return conjunct stays positive (no over-correction)', () => {
  const src = `function (contact, report) {
  return report.fields.x === 'y';
}`;
  const p = parseAppliesIf(src);
  assert.equal(p.rules[0]?.kind, 'raw');
  if (p.rules[0]?.kind === 'raw') assert.notEqual(p.rules[0].fromGuard, true);
  assert.equal(serializeAppliesIf(p), src);
});

test('P0-2 — OR-joining a field_age BETWEEN parenthesizes its || guard inside the && join', () => {
  const authored = {
    params: ['contact', 'report'],
    rules: [
      {
        kind: 'field_age_between' as const,
        source: 'report' as const,
        field: 'lmp_date',
        unit: 'days' as const,
        min: 84,
        max: 90,
        minOp: '>=' as const,
        maxOp: '<=' as const,
      },
      { kind: 'report_field' as const, field: 'x', op: '===' as const, value: 'yes' },
    ],
    guardGroups: [undefined, undefined],
    orGroups: [0, 0],
    hasRawFallback: false,
    body: '',
  };
  const out = serializeAppliesIf(authored);
  // Without parens this emitted `X < 84 || X > 90 && Y !== 'yes'`, which
  // JS precedence reads as `X < 84 || (X > 90 && …)` — mangled logic.
  assert.match(out, /if \(\(.+ < 84 \|\| .+ > 90\) && Utils\.getField\(report, 'x'\) !== 'yes'\) \{ return false; \}/);
  // Re-parse falls back to a raw guard (mixed nesting is outside the
  // model) — but it must be LOSSLESS and a serialize fixpoint.
  const s2 = serializeAppliesIf(parseAppliesIf(out));
  assert.equal(s2, out);
});

test('P0-2 — || guard join parenthesizes a raw operand carrying top-level &&', () => {
  const src = `function (contact, report) {
  if (a.x === 1 && a.y === 2 || !isAlive(contact.contact)) { return false; }
  return true;
}`;
  const s1 = serializeAppliesIf(parseAppliesIf(src));
  assert.match(s1, /if \(\(a\.x === 1 && a\.y === 2\) \|\| !isAlive\(contact\.contact\)\) \{ return false; \}/);
  // Semantics preserved (parens pin what precedence already meant), and
  // the parenthesized form is a fixpoint.
  assert.equal(serializeAppliesIf(parseAppliesIf(s1)), s1);
});

test('P0-2 — plain multi-|| guards stay unwrapped (byte-stability of existing sources)', () => {
  const src = `function (contact, report) {
  if (!isTaskUser(user) || !isAlive(contact.contact) || hasError(report)) { return false; }
  return true;
}`;
  assert.equal(serializeAppliesIf(parseAppliesIf(src)), src);
});

/* ===== docs/NEXT.md item 4 — report_field_includes ("any of these options") ===== */
/* Closes Task R8. Every test CALLS THE SERIALIZER (memory:                        */
/* feedback_roundtrip_tests_must_call_serializer).                                 */

test('includes: positive rule ("must include") emits the NEGATED guard and round-trips', () => {
  const authored = {
    params: ['contact', 'report'],
    rules: [
      { kind: 'report_field_includes' as const, field: 'eye_findings', value: 'cataract', negated: false },
    ],
    guardGroups: [undefined],
    orGroups: [undefined],
    hasRawFallback: false,
    body: '',
  };
  const out = serializeAppliesIf(authored);
  assert.match(
    out,
    /if \(!\(Utils\.getField\(report, 'eye_findings'\) \|\| ''\)\.split\(' '\)\.includes\('cataract'\)\) \{ return false; \}/,
    'positive "must include" guards on NOT-includes',
  );
  const back = parseAppliesIf(out);
  assert.deepEqual(back.rules, authored.rules, 'polarity survives the round-trip');
  assert.equal(back.hasRawFallback, false);
  assert.equal(serializeAppliesIf(back), out, 'fixpoint');
});

test('includes: NEGATED rule ("must NOT include") emits the bare guard and round-trips', () => {
  const authored = {
    params: ['contact', 'report'],
    rules: [
      { kind: 'report_field_includes' as const, field: 'eye_findings', value: 'cataract', negated: true },
    ],
    guardGroups: [undefined],
    orGroups: [undefined],
    hasRawFallback: false,
    body: '',
  };
  const out = serializeAppliesIf(authored);
  assert.match(
    out,
    /if \(\(Utils\.getField\(report, 'eye_findings'\) \|\| ''\)\.split\(' '\)\.includes\('cataract'\)\) \{ return false; \}/,
  );
  assert.equal(/if \(!\(/.test(out), false, 'negated rule must NOT emit a leading !');
  assert.deepEqual(parseAppliesIf(out).rules, authored.rules);
});

test('includes: the geriatric R8 shape — 5 OR-joined options round-trips structured', () => {
  // "fires when ANY of 5 external-eye findings is ticked": five includes
  // rules in one OR group, which serializes to ¬(A ∨ … ∨ E) as the
  // &&-joined inverted guards.
  const opts = ['cataract', 'redness', 'discharge', 'lid_swelling', 'corneal_opacity'];
  const authored = {
    params: ['contact', 'report'],
    rules: opts.map((v) => ({
      kind: 'report_field_includes' as const, field: 'eye_findings', value: v, negated: false,
    })),
    guardGroups: opts.map(() => undefined),
    orGroups: opts.map(() => 0),
    hasRawFallback: false,
    body: '',
  };
  const out = serializeAppliesIf(authored);
  assert.equal(out.split('\n').filter((l) => l.trim().startsWith('if (')).length, 1, 'one guard line');
  const back = parseAppliesIf(out);
  assert.equal(back.rules.length, 5);
  assert.deepEqual(back.rules, authored.rules);
  assert.ok(back.orGroups.every((g) => g !== undefined && g === back.orGroups[0]), 'one OR group');
  assert.equal(back.hasRawFallback, false, 'structured, not raw');
  assert.equal(serializeAppliesIf(back), out, 'fixpoint');
});

test('includes: the `||` inside the (x || \'\') guard does NOT split the OR group', () => {
  // splitAtTopLevel tracks parens, so the `||` at depth 1 must not be seen
  // as a top-level alternation — and parenFor must not wrap the operand.
  const src = `function (contact, report) {
  if (!(Utils.getField(report, 'f') || '').split(' ').includes('a') && !(Utils.getField(report, 'f') || '').split(' ').includes('b')) { return false; }
  return true;
}`;
  const p = parseAppliesIf(src);
  assert.equal(p.rules.length, 2, 'two rules, not four');
  assert.ok(p.rules.every((r) => r.kind === 'report_field_includes'));
  assert.equal(serializeAppliesIf(p), src, 'byte-stable — no spurious parens');
});

test('includes: bare getField parses, but emit always canonicalizes to Utils.getField', () => {
  const src = `function (contact, report) {
  if (!(getField(report, 'f') || '').split(' ').includes('a')) { return false; }
  return true;
}`;
  const p = parseAppliesIf(src);
  assert.equal(p.rules[0]?.kind, 'report_field_includes');
  const out = serializeAppliesIf(p);
  assert.match(out, /Utils\.getField/);
  assert.equal(/\bgetField\(report/.test(out.replace(/Utils\.getField/g, '')), false);
  assert.equal(/"[^"]*"/.test(out), false, 'single quotes only (cht eslint)');
});

test('includes: NON-canonical spellings fall to raw and are preserved VERBATIM', () => {
  // Rewriting any of these would be a silent semantic change — `.indexOf`
  // substring-matches, and a missing `|| ''` throws on an absent field.
  // They must survive byte-for-byte instead.
  const variants = [
    "(Utils.getField(report, 'f')).split(' ').includes('a')", // no || ''
    "(Utils.getField(report, 'f') || '').split(' ').indexOf('a') >= 0", // indexOf
    `(Utils.getField(report, "f") || "").split(" ").includes("a")`, // double quotes
    "(Utils.getField(report, 'f') || '').includes('a')", // no .split
  ];
  for (const v of variants) {
    const src = `function (contact, report) {\n  if (${v}) { return false; }\n  return true;\n}`;
    const p = parseAppliesIf(src);
    assert.equal(p.rules[0]?.kind, 'raw', `${v} must fall to raw`);
    assert.equal(serializeAppliesIf(p), src, `${v} must round-trip verbatim`);
  }
});

test('includes: mixes with other kinds under AND without disturbing them', () => {
  const src = `function (contact, report) {
  if (!isAlive(contact.contact)) { return false; }
  if (!(Utils.getField(report, 'eye') || '').split(' ').includes('cataract')) { return false; }
  if (Utils.getField(report, 'age_band') !== 'senior') { return false; }
  return true;
}`;
  const p = parseAppliesIf(src);
  assert.deepEqual(p.rules.map((r) => r.kind), ['is_alive', 'report_field_includes', 'report_field']);
  assert.equal(serializeAppliesIf(p), src, 'no-op open+save is byte-stable');
});

test('includes: an empty option value still round-trips (no crash, no drop)', () => {
  const src = `function (contact, report) {
  if (!(Utils.getField(report, 'f') || '').split(' ').includes('')) { return false; }
  return true;
}`;
  const p = parseAppliesIf(src);
  assert.equal(p.rules[0]?.kind, 'report_field_includes');
  assert.equal(serializeAppliesIf(p), src);
});

/* ===================================================================
 * docs/principle-config-agnostic.md posture 1 (Preserve): the standard
 * helpers keep the AUTHOR's argument, because which object the helper
 * wants is the project's decision.
 *
 * Synthetic fixtures distilled from the real spellings on disk — the
 * configs themselves are deliberately not committed (QA rider).
 * =================================================================== */

test('helper args: the majority spelling isAlive(contact) survives a no-op save', () => {
  // What lumbini, nssd, moh-nepal AND our own cht-default template write.
  // We used to rewrite it to isAlive(contact.contact); cht-default's own
  // isAlive() takes the wrapper and reads contact.contact.date_of_death
  // internally, so that rewrite made the helper always falsy and the task
  // never applied. Valid JS, compiles clean, silently disabled.
  const src = `function (contact) {
  if (!isAlive(contact) || isMuted(contact)) { return false; }
  return true;
}`;
  const out = serializeAppliesIf(parseAppliesIf(src));
  assert.match(out, /!isAlive\(contact\) \|\| isMuted\(contact\)/);
  assert.equal(/contact\.contact/.test(out), false, 'no invented contact.contact');
  assert.equal(out, src, 'byte-stable');
});

test("helper args: gandaki's isAlive(contact.contact) ALSO survives", () => {
  // The point is not picking the other constant — both spellings are the
  // project's to keep.
  const src = `function (contact) {
  if (!isAlive(contact.contact) || isMuted(contact.contact)) { return false; }
  return true;
}`;
  assert.equal(serializeAppliesIf(parseAppliesIf(src)), src);
});

test('helper args: a SECOND argument is no longer dropped', () => {
  // gandaki: isAlive(contact.contact, contact.reports). The structured
  // is_alive kind used to discard every argument, so this round-tripped to
  // a one-arg call — a different function call.
  const src = `function (contact) {
  if (!isAlive(contact.contact, contact.reports)) { return false; }
  return true;
}`;
  const out = serializeAppliesIf(parseAppliesIf(src));
  assert.match(out, /isAlive\(contact\.contact, contact\.reports\)/);
  assert.equal(out, src);
});

test('helper args: hasError keeps the author\'s report identifier', () => {
  // moh-nepal has hasError(r) inside a .filter(r => …). Substituting
  // `report` there changes which object is checked.
  const src = `function (contact, report) {
  if (hasError(r)) { return false; }
  return true;
}`;
  assert.equal(serializeAppliesIf(parseAppliesIf(src)), src);
});

test('helper args: unusual parameter names are respected, not normalised', () => {
  const src = `function (c, rep) {
  if (!isAlive(c) || hasError(rep)) { return false; }
  return true;
}`;
  const out = serializeAppliesIf(parseAppliesIf(src));
  assert.match(out, /!isAlive\(c\) \|\| hasError\(rep\)/);
  assert.equal(out, src);
});

test('helper args: a UI-BUILT rule derives its argument from the signature', () => {
  // No `args` — nothing to preserve — so the serializer takes the shape
  // from the body it is writing into rather than a hardcoded constant.
  // Built the way the UI builds one: start from a parsed body, append rules
  // that carry no authored text.
  const base = parseAppliesIf(`function (contact, report) {
  return true;
}`);
  const built = serializeAppliesIf({
    ...base,
    rules: [
      { kind: 'is_alive', negated: false },
      { kind: 'has_error', negated: false },
      { kind: 'is_task_user' },
    ],
    guardGroups: [undefined, undefined, undefined],
  });
  assert.match(built, /!isAlive\(contact\)/);
  assert.match(built, /!hasError\(report\)/);
  assert.match(built, /!isTaskUser\(user\)/);

  // Same rules, a project that names its params differently.
  const renamedBase = parseAppliesIf(`function (c, r) {
  return true;
}`);
  const renamed = serializeAppliesIf({
    ...renamedBase,
    rules: [
      { kind: 'is_alive', negated: false },
      { kind: 'has_error', negated: false },
    ],
    guardGroups: [undefined, undefined],
  });
  assert.match(renamed, /!isAlive\(c\)/);
  assert.match(renamed, /!hasError\(r\)/);
});

test('helper args: negated guards keep the argument too', () => {
  const src = `function (contact) {
  if (isMuted(contact)) { return false; }
  return true;
}`;
  assert.equal(serializeAppliesIf(parseAppliesIf(src)), src);
});

test("helper args: the shipped cht-default template's own appliesIf is stable", () => {
  // The regression that mattered most: our own template, opened and saved
  // with no edits, used to have its aliveness check inverted in effect.
  const src = `function (contact, report) {
  if (Utils.getField(report, 't_danger_signs_referral_follow_up') !== 'yes') { return false; }
  if (!isAlive(contact)) { return false; }
  return true;
}`;
  assert.equal(serializeAppliesIf(parseAppliesIf(src)), src);
});
