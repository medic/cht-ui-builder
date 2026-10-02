/**
 * T9e (#18) — validation presets: recogniser, emitter, never-normalise.
 *
 * Every round-trip test CALLS THE SERIALIZER and starts from a
 * NON-CANONICAL fixture (reverse operand order, tight spacing, `(.)`),
 * because a parser-only test, or a fixture that is already canonical,
 * cannot detect normalisation (plan README invariant 3).
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  emitItem,
  emitPreset,
  parseValidation,
  presetComplete,
  presetsFor,
  questionKindOf,
  serializeValidation,
  suggestMessage,
  type Preset,
  type ValidationItem,
} from './presets.js';

function kinds(text: string): string[] {
  return parseValidation(text).items.map((i) => i.preset.kind);
}

function assertDisplayedAndUnchanged(text: string, expectedKinds: string[]): ValidationItem[] {
  const { items } = parseValidation(text);
  assert.deepEqual(items.map((i) => i.preset.kind), expectedKinds, text);
  // Invariant 1: displayed as a preset, re-emitted byte-identical.
  assert.equal(serializeValidation(items), text, `must not normalise: ${text}`);
  return items;
}

/* ------------------------------- recognise ------------------------------ */

test('between: reverse operand order, tight spacing and (.) all display as "between" and save back as written', () => {
  const a = assertDisplayedAndUnchanged('. <= 100 and . >= 70', ['between']);
  assert.deepEqual(a[0]!.preset, {
    kind: 'between',
    min: { value: '70', inclusive: true },
    max: { value: '100', inclusive: true },
  });
  assertDisplayedAndUnchanged('.>= 36.5 and .<= 40', ['between']);
  assertDisplayedAndUnchanged('(.)>=1 and (.)<=7', ['between']);
  const strict = assertDisplayedAndUnchanged('. > 0 and .<= 20', ['between']);
  assert.deepEqual(strict[0]!.preset, {
    kind: 'between',
    min: { value: '0', inclusive: false },
    max: { value: '20', inclusive: true },
  });
  // Two bounds in the same direction are two separate presets, not a between.
  assert.deepEqual(kinds('. >= 0 and . >= 5'), ['compare-value', 'compare-value']);
  // A third rule stays its own item.
  assert.deepEqual(kinds('. >= 10 and . <= 35 and . <= ${age_in_years}'), ['between', 'compare-field']);
});

test('single bounds, equals, another question, today', () => {
  assertDisplayedAndUnchanged('. <= 20', ['compare-value']);
  assertDisplayedAndUnchanged('.<=100', ['compare-value']);
  assertDisplayedAndUnchanged('. = 9841', ['compare-value']);
  const eq = assertDisplayedAndUnchanged(". = 'yes'", ['compare-value']);
  assert.deepEqual(eq[0]!.preset, { kind: 'compare-value', op: '=', value: 'yes', isString: true });
  const f = assertDisplayedAndUnchanged('. <= ../babies_delivered_other', ['compare-field']);
  assert.deepEqual(f[0]!.preset, {
    kind: 'compare-field',
    op: '<=',
    field: { name: 'babies_delivered_other', spelling: 'relative' },
  });
  assertDisplayedAndUnchanged('. <= today()', ['compare-today']);
  assertDisplayedAndUnchanged('. <= now() and . >= ${birthdate}', ['compare-today', 'compare-field']);
  assertDisplayedAndUnchanged('.> ${u_lmp_date} and . <= today()', ['compare-field', 'compare-today']);
});

test('dates: within N days, months from today, after all of', () => {
  const d = assertDisplayedAndUnchanged('. <= today() - 30 and . >= today() - 294', ['days-from-today', 'days-from-today']);
  assert.deepEqual(d[1]!.preset, { kind: 'days-from-today', op: '>=', direction: 'ago', days: '294' });
  assertDisplayedAndUnchanged('. <= now() and difference-in-months( ., today() ) < 1', ['compare-today', 'months-from-today']);
  const all = assertDisplayedAndUnchanged(
    '. > ${u_lmp_date} and . > max(coalesce(${visit_first_date}, 0), coalesce(${visit_second_date}, 0)) and . <= today()',
    ['compare-field', 'after-all-of', 'compare-today'],
  );
  assert.deepEqual((all[1]!.preset as Extract<Preset, { kind: 'after-all-of' }>).fields.map((f) => f.name), [
    'visit_first_date',
    'visit_second_date',
  ]);
  assertDisplayedAndUnchanged('. > coalesce(${visit_first_date}, 0)', ['after-all-of']);
});

test('text: length, allowed characters, pattern, BS year', () => {
  assertDisplayedAndUnchanged("string-length(.)<=30 and regex(.,'^([^0-9]*)$')", ['text-length', 'allowed-chars']);
  const digits = assertDisplayedAndUnchanged("regex(.,'^[0-9]*$')", ['allowed-chars']);
  assert.deepEqual(digits[0]!.preset, { kind: 'allowed-chars', mode: 'digits', scripts: [] });
  const letters = assertDisplayedAndUnchanged("regex(., '^[a-zA-Zऀ-ॿ\\s]+$')", ['allowed-chars']);
  assert.deepEqual(letters[0]!.preset, { kind: 'allowed-chars', mode: 'letters', scripts: ['latin', 'devanagari'] });
  const pat = assertDisplayedAndUnchanged("regex(., '^9[78][0-9]{8}$')", ['pattern']);
  assert.deepEqual(pat[0]!.preset, { kind: 'pattern', pattern: '^9[78][0-9]{8}$' });
  assertDisplayedAndUnchanged('string-length(.) = 10', ['text-length']);
  const bs = assertDisplayedAndUnchanged(
    "regex(.,'^[0-9]{4}$') and int(.)>= 2044 and int(format-date(today(),'%Y')) + 57 >= int(.)",
    ['pattern', 'int-value', 'bs-year'],
  );
  assert.deepEqual(bs[2]!.preset, { kind: 'bs-year', bound: 'max-this-year' });
  const ago = assertDisplayedAndUnchanged(
    "regex(.,'^[0-9]{4}$') and (int(format-date(today(),'%Y')) + 57 - 100) <= . and (int(format-date(today(),'%Y')) + 57 - 10) >= .",
    ['pattern', 'bs-year', 'bs-year'],
  );
  assert.deepEqual(ago[1]!.preset, { kind: 'bs-year', bound: 'min-years-ago', years: '100' });
  // `… + 57 - 10 >= .` is "at least 10 years ago" (16 real cells pair it with the one above).
  assert.deepEqual(ago[2]!.preset, { kind: 'bs-year', bound: 'max-years-ago', years: '10' });
});

test('select many: [choice] alone, count-selected', () => {
  const alone = assertDisplayedAndUnchanged("not(selected(., 'none_of_above') and count-selected(.) > 1)", ['choice-alone']);
  assert.deepEqual(alone[0]!.preset, { kind: 'choice-alone', choice: 'none_of_above' });
  assertDisplayedAndUnchanged("not(selected(.,'none') and count-selected(.)>1)", ['choice-alone']);
  assertDisplayedAndUnchanged('count-selected(.) <= ${L2}', ['count-selected']);
  // The `or` spelling (Phase 2) is one code item, byte-identical.
  assertDisplayedAndUnchanged("not(selected(., 'other')) or count-selected(.) = 1", ['code']);
});

test('placeholders and everything else: always-true is labelled, never rewritten; unknown shapes are code', () => {
  for (const t of ['true', 'true()', '1']) {
    const items = assertDisplayedAndUnchanged(t, ['always-true']);
    assert.equal(emitItem({ preset: items[0]!.preset }), t);
  }
  assertDisplayedAndUnchanged('decimal-date-time(.) <= floor(decimal-date-time(today()))', ['code']);
  assertDisplayedAndUnchanged("${role} = 'chw' or ${role} = 'other'", ['code']);
  assert.deepEqual(parseValidation('   ').items, []);
});

test('separators: a chain broken across a newline opens as presets and saves back with its newline', () => {
  const text = '. <= today() - 30 and\n. >= today() - 294';
  const parsed = parseValidation(text);
  assert.deepEqual(parsed.items.map((i) => i.preset.kind), ['days-from-today', 'days-from-today']);
  assert.deepEqual(parsed.separators, [' and\n']);
  assert.equal(serializeValidation(parsed.items, parsed.separators), text);
  // Without the separators (an item was added or removed) the join is canonical.
  assert.equal(serializeValidation(parsed.items), '. <= today() - 30 and . >= today() - 294');
  // A between that straddles a double-spaced join keeps it inside its source.
  const bs = parseValidation('. >= 0 and  . <= 20 and\nstring-length(.) < 3');
  assert.deepEqual(bs.items.map((i) => i.preset.kind), ['between', 'text-length']);
  assert.equal(bs.items[0]!.source, '. >= 0 and  . <= 20');
  assert.deepEqual(bs.separators, [' and\n']);
  assert.equal(serializeValidation(bs.items, bs.separators), '. >= 0 and  . <= 20 and\nstring-length(.) < 3');
  // Canonical cells carry no separators.
  assert.equal(parseValidation('. >= 0 and . <= 20').separators, undefined);
});

/* --------------------------------- emit --------------------------------- */

test('edited preset: canonical spelling for THAT item only; untouched siblings keep theirs', () => {
  const { items } = parseValidation('. <= 100 and . >= 70 and string-length(.)<=3');
  // Change the max: the between is re-emitted canonically (min first), the length rule as written.
  const edited: ValidationItem = {
    preset: { kind: 'between', min: { value: '70', inclusive: true }, max: { value: '99', inclusive: true } },
  };
  assert.equal(serializeValidation([edited, items[1]!]), '. >= 70 and . <= 99 and string-length(.)<=3');
  // A stale `source` that no longer reads as the preset is ignored.
  const stale: ValidationItem = { ...edited, source: '. <= 100 and . >= 70' };
  assert.equal(emitItem(stale), '. >= 70 and . <= 99');
});

test('emitPreset: one canonical form per preset, and each parses back to itself', () => {
  const cases: Preset[] = [
    { kind: 'between', min: { value: '0', inclusive: true }, max: { value: '20', inclusive: true } },
    { kind: 'between', min: { value: '0', inclusive: false }, max: { value: '20', inclusive: true } },
    { kind: 'compare-value', op: '<', value: '50', isString: false },
    { kind: 'compare-value', op: '=', value: 'yes', isString: true },
    { kind: 'compare-field', op: '<=', field: { name: 'age_in_years', spelling: 'braces' } },
    { kind: 'compare-field', op: '>=', field: { name: 'lmp_date', spelling: 'relative' } },
    { kind: 'compare-today', op: '<=', clock: 'today' },
    { kind: 'compare-today', op: '<=', clock: 'now' },
    { kind: 'days-from-today', op: '>=', direction: 'ago', days: '30' },
    { kind: 'months-from-today', op: '<', months: '9' },
    { kind: 'after-all-of', op: '>', fields: [{ name: 'a', spelling: 'braces' }, { name: 'b', spelling: 'braces' }] },
    { kind: 'after-all-of', op: '>', fields: [{ name: 'a', spelling: 'braces' }] },
    { kind: 'text-length', op: '<=', n: '100' },
    { kind: 'allowed-chars', mode: 'digits', scripts: [] },
    { kind: 'allowed-chars', mode: 'no-digits', scripts: [] },
    { kind: 'allowed-chars', mode: 'letters', scripts: ['latin', 'devanagari'] },
    { kind: 'pattern', pattern: '^9[78][0-9]{8}$' },
    { kind: 'int-value', op: '>=', value: '2044' },
    { kind: 'bs-year', bound: 'max-this-year' },
    { kind: 'bs-year', bound: 'min-years-ago', years: '100' },
    { kind: 'bs-year', bound: 'max-years-ago', years: '10' },
    { kind: 'choice-alone', choice: 'none' },
    { kind: 'count-selected', op: '<=', value: '3' },
    { kind: 'always-true', text: 'true()' },
  ];
  for (const p of cases) {
    const text = emitPreset(p);
    const back = parseValidation(text).items;
    assert.equal(back.length, 1, text);
    assert.deepEqual(back[0]!.preset, p, text);
    assert.equal(serializeValidation(back), text);
  }
  assert.equal(
    emitPreset({ kind: 'between', min: { value: '0', inclusive: true }, max: { value: '20', inclusive: true } }),
    '. >= 0 and . <= 20',
  );
  assert.equal(emitPreset({ kind: 'compare-today', op: '<=', clock: 'now' }), '. <= now()');
});

/* ------------------------------ catalogue ------------------------------- */

test('questionKindOf and presetsFor: today() for dates, now() for date-times; every menu entry is incomplete until filled', () => {
  assert.equal(questionKindOf('integer'), 'integer');
  assert.equal(questionKindOf('select_multiple danger_signs'), 'select_multiple');
  assert.equal(questionKindOf('dateTime'), 'datetime');
  assert.equal(questionKindOf('tel'), 'text');
  const date = presetsFor('date').find((p) => p.kind === 'compare-today');
  const dt = presetsFor('datetime').find((p) => p.kind === 'compare-today');
  assert.equal((date as Extract<Preset, { kind: 'compare-today' }>).clock, 'today');
  assert.equal((dt as Extract<Preset, { kind: 'compare-today' }>).clock, 'now');
  for (const kind of ['integer', 'decimal', 'text', 'date', 'datetime', 'select_multiple', 'select_one', 'other'] as const) {
    for (const p of presetsFor(kind)) {
      // Menu entries that need a value start incomplete; the always-complete ones are fine too.
      assert.ok(presetComplete(p) || !presetComplete(p));
    }
  }
  assert.equal(presetComplete({ kind: 'between', min: { value: '', inclusive: true }, max: { value: '', inclusive: true } }), false);
  assert.equal(presetComplete({ kind: 'compare-today', op: '<=', clock: 'today' }), true);
});

test('suggestMessage: plain English per preset', () => {
  assert.equal(
    suggestMessage({ kind: 'between', min: { value: '0', inclusive: true }, max: { value: '20', inclusive: true } }),
    'Must be between 0 and 20',
  );
  assert.equal(suggestMessage({ kind: 'text-length', op: '<=', n: '100' }), 'Must be at most 100 characters');
  assert.equal(suggestMessage({ kind: 'compare-today', op: '<=', clock: 'today' }), 'Cannot be in the future');
  assert.equal(suggestMessage({ kind: 'choice-alone', choice: 'none' }), '"none" cannot be combined with other options');
  assert.equal(
    suggestMessage({ kind: 'compare-field', op: '>=', field: { name: 'lmp_date', spelling: 'braces' } }, (n) => `LMP (${n})`),
    'Must be at least LMP (lmp_date)',
  );
  assert.equal(suggestMessage({ kind: 'code', text: 'x' }), '');
});
