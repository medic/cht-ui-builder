/**
 * T9b (#15) — `${field}` / `not(${field})` as a structured rule.
 *
 * Every positive case calls the serializer and asserts byte identity; the
 * negative cases pin that spacing-divergent spellings stay raw (and still
 * byte-identical), and that the new kind does not steal `${f} != ''` from
 * `answered`.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  parseRelevant,
  parseRelevantGrouped,
  serializeAnyParsed,
  serializeRelevant,
} from './relevantParser.js';

test('truthy: `${f}` parses as truthy and serializes byte-identical', () => {
  const src = '${lmp_approx}';
  const parsed = parseRelevant(src);
  assert.equal(parsed.isRawFallback, false);
  assert.deepEqual(parsed.rules, [{ kind: 'truthy', field: 'lmp_approx', negated: false }]);
  assert.equal(serializeRelevant(parsed), src);
});

test('truthy: `not(${f})` parses as negated truthy and serializes byte-identical', () => {
  const src = 'not(${danger_signs})';
  const parsed = parseRelevant(src);
  assert.equal(parsed.isRawFallback, false);
  assert.deepEqual(parsed.rules, [{ kind: 'truthy', field: 'danger_signs', negated: true }]);
  assert.equal(serializeRelevant(parsed), src);
});

test('truthy: chains with other kinds and inside a grouped expression', () => {
  const flat = "${a} and not(${b}) and ${c} = 'x'";
  const p = parseRelevant(flat);
  assert.equal(p.isRawFallback, false);
  assert.deepEqual(
    p.rules.map((r) => r.kind),
    ['truthy', 'truthy', 'comparison'],
  );
  assert.equal(serializeRelevant(p), flat);

  const grouped = "(${a} and not(${b})) or ${c} = 'x'";
  const g = parseRelevantGrouped(grouped);
  assert.equal(g.isRawFallback, false);
  assert.ok('subgroups' in g);
  assert.equal(serializeAnyParsed(g), grouped);
});

test('truthy: spacing-divergent spellings never become a truthy rule, and stay byte-identical', () => {
  // `${ f }` is outside every grammar and stays raw. The `not( … )` variants
  // parse as a negated group carrying the author's text (T9a, #14); either
  // way nothing is rewritten and none of them is mistaken for `not(${f})`.
  const raw = parseRelevant('${ f }');
  assert.equal(raw.isRawFallback, true);
  assert.equal(serializeRelevant(raw), '${ f }');
  for (const src of ['not( ${f} )', 'not(${f} )', 'not (${f})', 'NOT(${f})']) {
    const parsed = parseRelevant(src);
    assert.notEqual(parsed.rules[0]?.kind, 'truthy', `must not be truthy: ${src}`);
    assert.equal(serializeRelevant(parsed), src);
  }
});

test("truthy: does not steal `${f} != ''` / `${f} = ''` from `answered`", () => {
  const answered = parseRelevant("${f} != ''");
  assert.equal(answered.rules[0]?.kind, 'answered');
  assert.equal(serializeRelevant(answered), "${f} != ''");
  const notAnswered = parseRelevant("${f} = ''");
  assert.equal(notAnswered.rules[0]?.kind, 'answered');
  assert.equal(serializeRelevant(notAnswered), "${f} = ''");
});
