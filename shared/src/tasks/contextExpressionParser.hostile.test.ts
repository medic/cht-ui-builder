/**
 * Hostile-fixture pins for the form-context expression parser/serializer
 * (docs/handoff-nssd-safety-batch-2026-08-11.md, item A5).
 *
 * The NSSD config parenthesises OR-groups inside `context.expression`
 * (`A && (B || C) && D`). HEAD's `classify()` strips the outer parens
 * (`e.trim().replace(/^\((.*)\)$/, '$1')`) and the `raw` serializer re-emits
 * the text bare, so the expression comes back as `A && B || C && D` —
 * `&&` binds tighter than `||`, so eligibility flips (11 of 24 NSSD forms,
 * every flip false→true: muted/deceased contacts become eligible).
 *
 * KNOWN TRAP (planner-verified): the corruption is IDEMPOTENT — a
 * parse→serialize→parse stability test PASSES on the corrupted output, and
 * `validateContextExpression` returns `[]` on it. So the pins here assert
 * two independent things on NON-canonical input:
 *   1. byte-preservation of the original source, and
 *   2. SEMANTIC equivalence of original vs emitted over a full truth table
 *      of operand values (catches any future precedence-corrupting rewrite
 *      even if it happens to be byte-idempotent).
 *
 * Tests marked `{ todo: true }` pin the CORRECT config-agnostic behavior
 * that HEAD fails today — flip todo off when the A5 fix lands.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  parseContextExpression,
  serializeContextExpression,
  validateContextExpression,
} from './contextExpressionParser.js';

function roundtrip(src: string): string {
  return serializeContextExpression(parseContextExpression(src));
}

/* ============================ semantic-equivalence harness ============================ */

type Bag = Record<string, unknown>;

/**
 * Compile an expression the way CHT evaluates `context.expression` — as a
 * bare JS expression over `contact` / `summary` / `report`.
 */
function compileExpr(expr: string): (contact: Bag, summary: Bag) => boolean {
  const fn = new Function('contact', 'summary', 'report', 'return ' + expr + ';') as (
    contact: Bag,
    summary: Bag,
    report: Bag,
  ) => unknown;
  return (contact, summary) => Boolean(fn(contact, summary, {}));
}

/**
 * Every operand value combination used by the fixtures below (2^11 = 2048
 * cases). One shared space keeps the harness uniform; unused fields are
 * inert for any given expression.
 */
function operandSpace(): Array<{ contact: Bag; summary: Bag }> {
  const bools = [true, false];
  const cases: Array<{ contact: Bag; summary: Bag }> = [];
  for (const contact_type of ['patient', 'household'])
    for (const sex of ['female', 'male'])
      for (const date_of_birth of ['', '1988-05-14'])
        for (const date_of_death of ['', '2025-12-01'])
          for (const muted of bools)
            for (const is_pregnant of bools)
              for (const is_postpartum of bools)
                for (const hiv_positive of bools)
                  for (const on_art of bools)
                    for (const tb_active of bools)
                      for (const tb_suspect of bools) {
                        cases.push({
                          contact: { contact_type, sex, date_of_birth, date_of_death, muted },
                          summary: {
                            is_pregnant,
                            is_postpartum,
                            hiv_positive,
                            on_art,
                            tb_active,
                            tb_suspect,
                          },
                        });
                      }
  return cases;
}

/** Assert `original` and `emitted` agree on EVERY combination of operands. */
function assertSameOutcomes(original: string, emitted: string): void {
  const evalOriginal = compileExpr(original);
  const evalEmitted = compileExpr(emitted);
  for (const { contact, summary } of operandSpace()) {
    const want = evalOriginal(contact, summary);
    const got = evalEmitted(contact, summary);
    assert.equal(
      got,
      want,
      `eligibility flips (${want} -> ${got}) for contact=${JSON.stringify(contact)} ` +
        `summary=${JSON.stringify(summary)}\n  original: ${original}\n  emitted : ${emitted}`,
    );
  }
}

/* ============================ §1 — single paren OR-group (the A5 core shape) ============================ */

// Paraphrased NSSD shape: AND-chain with one parenthesised OR-group in the
// middle. `contact.contact_type === 'patient'` and `!contact.muted` are
// recognized rule kinds; the paren group lands in the raw fallback.
const PAREN_OR_GROUP =
  "contact.contact_type === 'patient' && (summary.is_pregnant || contact.date_of_birth !== '') && !contact.muted";

// A5 — HEAD strips the parens and re-emits the group bare, flipping operator
// precedence. Flip todo off when the fix lands.
test('A5: paren OR-group survives parse -> serialize byte-for-byte', { todo: true }, () => {
  assert.equal(roundtrip(PAREN_OR_GROUP), PAREN_OR_GROUP);
});

// A5 — the semantic pin. On HEAD the emitted form disagrees with the original
// on 512 of 2048 operand combinations (measured), every flip false→true —
// e.g. a muted or non-patient contact with a date_of_birth becomes eligible.
// This assertion holds even against a FUTURE rewrite that is byte-unstable
// but idempotent (the known trap). Flip todo off when the fix lands.
test('A5: paren OR-group — original and emitted agree on every operand combination', { todo: true }, () => {
  assertSameOutcomes(PAREN_OR_GROUP, roundtrip(PAREN_OR_GROUP));
});

/* ============================ §2 — nested parens (progressive stripping) ============================ */

const NESTED_PARENS =
  "contact.contact_type === 'patient' && ((summary.is_pregnant || summary.is_postpartum))";

// A5 — HEAD's single-pass regex strips exactly ONE paren layer per save, so
// the first save emits `(summary.is_pregnant || summary.is_postpartum)`:
// still semantically intact, but not the bytes the user wrote — and one save
// away from the precedence flip. Flip todo off when the fix lands.
test('A5: nested parens are preserved byte-for-byte (no layer stripping)', { todo: true }, () => {
  assert.equal(roundtrip(NESTED_PARENS), NESTED_PARENS);
});

// A5 — the progressive corruption: save #1 strips a layer (measured: still
// equivalent), save #2 strips the last layer and FLIPS the meaning. A plain
// idempotence test never sees this because it starts from canonical output.
// Flip todo off when the fix lands.
test('A5: nested parens — two consecutive saves stay semantically equivalent', { todo: true }, () => {
  const twice = roundtrip(roundtrip(NESTED_PARENS));
  assertSameOutcomes(NESTED_PARENS, twice);
});

/* ============================ §3 — adjacent paren groups joined by || ============================ */

// One AND-leg of the form `(B || C) || (D || E)`: `splitAnd` keeps it whole
// (it only splits on top-level `&&`), then the GREEDY strip regex
// `/^\((.*)\)$/` matches from the FIRST `(` to the LAST `)`, capturing
// `B || C) || (D || E` — the emitted expression has unbalanced parens and is
// a SyntaxError at deploy.
const ADJACENT_PAREN_GROUPS =
  "contact.sex === 'female' && (summary.hiv_positive || summary.on_art) || (summary.tb_active || summary.tb_suspect)";

// A5 — flip todo off when the fix lands.
test('A5: adjacent paren groups joined by || are not unbalanced by the greedy strip', { todo: true }, () => {
  const emitted = roundtrip(ADJACENT_PAREN_GROUPS);
  assert.equal(emitted, ADJACENT_PAREN_GROUPS);
  // The emitted expression must at minimum still be valid JS (on HEAD it is
  // `... && summary.hiv_positive || summary.on_art) || (...` — SyntaxError).
  assert.doesNotThrow(() => compileExpr(emitted), 'emitted expression must compile');
  assertSameOutcomes(ADJACENT_PAREN_GROUPS, emitted);
});

/* ============================ §4 — green pins (HEAD already correct; keep it that way) ============================ */

test('A5: parenthesised NOT-group round-trips byte-for-byte', () => {
  // `!(...)` does NOT start with `(`, so the strip regex never fires — the
  // whole leg lands in raw verbatim. Green pin so the A5 fix cannot regress
  // the one paren shape HEAD already preserves.
  const src = "!(contact.muted || contact.date_of_death) && contact.contact_type === 'patient'";
  assert.equal(roundtrip(src), src);
  assert.ok(parseContextExpression(src).hasRawFallback, 'NOT-group is a raw-fallback leg');
  assertSameOutcomes(src, roundtrip(src));
});

test('A5: paren-free mixed && / || stays verbatim (guards against re-wrap over-correction)', () => {
  // A user-authored `A && B || C && D` (no parens) means `(A && B) || (C && D)`.
  // `splitAnd` models it as three AND-legs with `B || C` in a raw middle leg —
  // a fix variant that re-wraps every raw leg containing `||` would emit
  // `A && (B || C) && D` and corrupt THIS shape in the opposite direction.
  // The serializer must re-emit the original bytes.
  const src =
    "contact.contact_type === 'patient' && summary.is_pregnant || contact.date_of_birth !== '' && !contact.muted";
  assert.equal(roundtrip(src), src);
  assertSameOutcomes(src, roundtrip(src));
});

test('A5: redundant parens around recognized operands stay semantically equivalent', () => {
  // `(summary.is_pregnant)` paren-strips into the summary_flag matcher, so
  // HEAD emits `summary.is_pregnant && contact.sex === 'female'` — a byte
  // change, but a semantically safe one (the parens were redundant), and the
  // rules classify to real kinds (no raw demotion). The A5 fix only touches
  // raw legs, so this pins semantics + classification, not bytes.
  const src = "(summary.is_pregnant) && (contact.sex === 'female')";
  const emitted = roundtrip(src);
  assertSameOutcomes(src, emitted);
  const kinds = parseContextExpression(src).rules.map((r) => r.kind);
  assert.deepEqual(kinds, ['summary_flag', 'contact_sex']);
  const reKinds = parseContextExpression(emitted).rules.map((r) => r.kind);
  assert.deepEqual(reKinds, kinds, 'emitted form classifies to the same rule kinds');
});

test('A5: validator does not block parenthesised expressions (raw-fallback invariant)', () => {
  // Parenthesised groups are deliberate raw JS — the save-time gate must let
  // them through today AND after the fix (when raw legs keep their parens).
  assert.deepEqual(validateContextExpression(PAREN_OR_GROUP), []);
  assert.deepEqual(validateContextExpression(NESTED_PARENS), []);
  assert.deepEqual(validateContextExpression(ADJACENT_PAREN_GROUPS), []);
  assert.deepEqual(
    validateContextExpression(
      "!(contact.muted || contact.date_of_death) && contact.contact_type === 'patient'",
    ),
    [],
  );
});
