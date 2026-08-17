/**
 * Idiom coverage for `calcReference.ts` — the two contact-summary read
 * shapes the recognizer was blind to, and the derivation that replaces a
 * hardcoded "house idiom".
 *
 * ## Where the fixtures come from
 *
 * Every `instance('contact-summary')` cell across the five real config
 * roots on this machine (nssd/chis, gandaki, lumbini, moh-nepal province and
 * master-direct-client-messaging) was normalised by replacing each reference
 * with `REF` and collapsing whitespace. Result: **132 occurrences, 12
 * distinct shapes, all in the `calculation` column and nowhere else.**
 *
 *   47  if(REF, REF, .)                  fallback-to-current   already known
 *   29  if(REF != '', REF, .)            guarded-fallback      WAS BLIND
 *   17  coalesce(REF,.)                  coalesce              WAS BLIND
 *   15  REF                              none                  already known
 *    9  once(REF)                        read-once             already known
 *    5  if(REF != '', REF,.)             guarded (spacing)     WAS BLIND
 *    4  if(REF != 0, REF, .)             guarded, sentinel 0   WAS BLIND
 *    2  if(REF != '', REF , .)           guarded (spacing)     WAS BLIND
 *    1  coalesce(REF, .)                 coalesce (spacing)    WAS BLIND
 *    1  if(REF != '', REF,'no')          bespoke -> raw
 *    1  if(REF >0 , REF,0)               bespoke -> raw
 *    1  if(REF != '', REF, if(${x}…))    bespoke -> raw
 *
 * The three already-known wrappers covered 71 of 132 (54%). The blind spot
 * was not spread evenly, which is the part that matters:
 * `guarded-fallback` is the ONLY idiom gandaki and moh-nepal use (6 of 6
 * cells each) and `coalesce` is lumbini's vaccination idiom (17 of its 35).
 * So the picker recognised **zero** of two real configs' context reads.
 * "Works on NSSD" was hiding it — docs/principle-config-agnostic.md.
 *
 * The fixtures are hand-written from those normalised shapes, not copied
 * from a customer file (QA rider: distil the divergent shape, don't commit
 * the config). Every case drives the EMITTER too, not just the recognizer
 * (feedback_roundtrip_tests_must_call_serializer).
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  DEFAULT_GUARD_SENTINEL,
  emitContactSummary,
  inferContextWrapper,
  recognizeReference,
  type ContextWrapper,
} from './calcReference.js';

/** The bare reference, spelled the one way every real config spells it. */
const CTX = (k: string) => `instance('contact-summary')/context/${k}`;

const ALL_WRAPPERS: ContextWrapper[] = [
  'none',
  'fallback-to-current',
  'guarded-fallback',
  'coalesce',
  'read-once',
];

/* ============ the guarded fallback: if(REF != <sentinel>, REF, .) ========= */

test("guarded fallback if(ref != '', ref, .) is recognized", () => {
  // gandaki's and moh-nepal's ONLY context idiom (6 of 6 cells each), plus
  // 29 of nssd's. Unrecognized before, so the picker offered those two
  // configs nothing at all.
  const cell = `if(${CTX('lmp_date')} != '', ${CTX('lmp_date')}, .)`;
  const rec = recognizeReference(cell);
  assert.equal(rec?.kind, 'contact-summary');
  assert.equal(rec?.argument, 'lmp_date');
  assert.equal(rec?.wrapper, 'guarded-fallback');
  assert.equal(rec?.sentinel, "''");
  // Emitting it back reproduces the cell byte-for-byte.
  assert.equal(emitContactSummary('lmp_date', 'guarded-fallback', rec?.sentinel), cell);
});

test('the != 0 sentinel is preserved, never normalised to != empty-string', () => {
  // 4 real cells compare against 0 rather than ''. Rewriting one into the
  // other changes which values count as missing — the same class of silent
  // substitution that made isAlive(contact) into isAlive(contact.contact).
  const cell = `if(${CTX('lmp_date_8601')} != 0, ${CTX('lmp_date_8601')}, .)`;
  const rec = recognizeReference(cell);
  assert.equal(rec?.wrapper, 'guarded-fallback');
  assert.equal(rec?.sentinel, '0');
  const out = emitContactSummary('lmp_date_8601', 'guarded-fallback', rec?.sentinel);
  assert.equal(out, cell);
  assert.equal(out.includes("!= ''"), false, 'the 0 sentinel must not become empty-string');
});

test('guarded fallback with no authored sentinel uses the common one', () => {
  assert.equal(DEFAULT_GUARD_SENTINEL, "''");
  assert.equal(
    emitContactSummary('k', 'guarded-fallback'),
    `if(${CTX('k')} != '', ${CTX('k')}, .)`,
  );
});

/* ==================== coalesce: coalesce(REF, .) ========================= */

test("coalesce(ref, .) is recognized — lumbini's vaccination idiom", () => {
  // 18 real cells; 17 of them spelled with no space after the comma.
  for (const cell of [`coalesce(${CTX('have_bcg')},.)`, `coalesce(${CTX('have_bcg')}, .)`]) {
    const rec = recognizeReference(cell);
    assert.equal(rec?.kind, 'contact-summary', cell);
    assert.equal(rec?.argument, 'have_bcg', cell);
    assert.equal(rec?.wrapper, 'coalesce', cell);
    assert.equal(rec?.sentinel, null, cell);
  }
  const canonical = emitContactSummary('have_bcg', 'coalesce');
  assert.equal(canonical, `coalesce(${CTX('have_bcg')}, .)`);
  assert.equal(recognizeReference(canonical)?.wrapper, 'coalesce');
});

/* ========================= spacing tolerance ============================= */

test('real spacing variants all re-hydrate to the same wrapper', () => {
  // `REF,.` (5 cells) and `REF , .` (2 cells) occur alongside the canonical
  // spelling. Recognition is READ-ONLY — it only pre-selects the picker's
  // dropdown, and a cell is rewritten solely when the author actively picks
  // — so tolerating these costs no byte-stability.
  const variants = [
    `if(${CTX('prina')} != '', ${CTX('prina')}, .)`,
    `if(${CTX('prina')} != '', ${CTX('prina')},.)`,
    `if(${CTX('prina')} != '', ${CTX('prina')} , .)`,
    `if(${CTX('prina')}!=''  ,  ${CTX('prina')} ,.)`,
  ];
  for (const v of variants) {
    const rec = recognizeReference(v);
    assert.equal(rec?.wrapper, 'guarded-fallback', v);
    assert.equal(rec?.argument, 'prina', v);
  }
});

/* ===================== what must stay UNrecognized ======================= */

test('the three genuinely bespoke real cells stay unrecognized', () => {
  // Their else-branch is a literal or a nested `if` — different behaviour
  // from "fall back to my own answer". They must route to the raw path,
  // where the bytes survive untouched.
  const bespoke = [
    `if(${CTX('prina')} != '', ${CTX('prina')},'no')`,
    `if(${CTX('total_visit')} >0 , ${CTX('total_visit')},0)`,
    `if(${CTX('lmp_date_8601')} != '', ${CTX('lmp_date_8601')}, ` +
      `if(\${taskLmpDate} != '', \${taskLmpDate}, .))`,
  ];
  for (const cell of bespoke) {
    assert.equal(recognizeReference(cell), null, `must not claim to understand: ${cell}`);
  }
});

test('a guard on one key yielding a DIFFERENT key is not a wrapper', () => {
  // Same rule the bare fallback already enforced (nssd's avg_result /
  // avg_result_ctx cell): a mismatch is bespoke logic, not a wrapper.
  const cell = `if(${CTX('avg_result')} != '', ${CTX('avg_result_ctx')}, .)`;
  assert.equal(recognizeReference(cell), null);
});

test('a partial or truncated read is not recognized', () => {
  for (const junk of [
    `if(${CTX('a')} != '', ${CTX('a')})`, // no else branch
    `coalesce(${CTX('a')})`, // no `.`
    `coalesce(${CTX('a')}, ${CTX('b')})`, // second arg is another ref
    `once(${CTX('a')}`, // unbalanced
    `if(${CTX('a')} == '', ${CTX('a')}, .)`, // `==`, not `!=`
  ]) {
    assert.equal(recognizeReference(junk), null, junk);
  }
});

/* ========================== emitter fixpoint ============================= */

test('every wrapper survives emit -> recognize -> emit', () => {
  for (const w of ALL_WRAPPERS) {
    const once = emitContactSummary('previous_bmi_ctx', w);
    const rec = recognizeReference(once);
    assert.equal(rec?.kind, 'contact-summary', w);
    assert.equal(rec?.argument, 'previous_bmi_ctx', w);
    assert.equal(rec?.wrapper, w, `${w} did not re-hydrate as itself`);
    const twice = emitContactSummary(rec!.argument, rec!.wrapper, rec!.sentinel);
    assert.equal(twice, once, `${w} is not an emit fixpoint`);
  }
});

/* ============ inferContextWrapper: derive, don't impose ================== */

test('inferContextWrapper: nssd shape -> fallback-to-current, NOT once', () => {
  // The plan for this feature stated NSSD's house idiom is `once(...)`.
  // Measured across NSSD's own cells it is `if(REF, REF, .)` 46, guarded 40,
  // once 9, bare 2 — so defaulting to `once()` would have matched 9 of 97.
  const cells = [
    ...Array<string>(6).fill(`if(${CTX('a')}, ${CTX('a')}, .)`),
    ...Array<string>(4).fill(`if(${CTX('b')} != '', ${CTX('b')}, .)`),
    `once(${CTX('c')})`,
    CTX('d'),
  ];
  assert.equal(inferContextWrapper(cells), 'fallback-to-current');
});

test('inferContextWrapper: gandaki / moh-nepal shape -> guarded-fallback', () => {
  assert.equal(
    inferContextWrapper([
      `if(${CTX('lmp_date')} != '', ${CTX('lmp_date')}, .)`,
      `if(${CTX('edd')} != '', ${CTX('edd')}, .)`,
      `if(${CTX('delivery_date')} != '', ${CTX('delivery_date')}, .)`,
    ]),
    'guarded-fallback',
  );
});

test('inferContextWrapper: lumbini shape -> coalesce', () => {
  assert.equal(
    inferContextWrapper([
      ...Array<string>(5).fill(`coalesce(${CTX('have_bcg')},.)`),
      ...Array<string>(3).fill(CTX('plain')),
    ]),
    'coalesce',
  );
});

test('inferContextWrapper: no context reads at all -> null, not a guess', () => {
  // A project with no evidence gets no fabricated "house style"; the caller
  // decides its own starting point rather than being handed one inferred
  // from nothing.
  assert.equal(inferContextWrapper([]), null);
  assert.equal(inferContextWrapper(['${age}', '../inputs/contact/name', '1 + 1']), null);
});

test('inferContextWrapper: ignores non-context cells rather than choking', () => {
  // Callers hand over EVERY calculation cell in the project, so the
  // function has to tolerate the majority being irrelevant.
  assert.equal(
    inferContextWrapper([
      '../inputs/contact/_id',
      '${age} * 2',
      '',
      `coalesce(${CTX('x')},.)`,
      'if(1, 2, 3)',
    ]),
    'coalesce',
  );
});

test('inferContextWrapper: ties break to the globally more common idiom', () => {
  // One cell each. Left to enumeration order this would be arbitrary; the
  // tie-break order is the measured global frequency, so 1-vs-1 lands on
  // the idiom that is more common across real configs overall.
  assert.equal(
    inferContextWrapper([`if(${CTX('a')}, ${CTX('a')}, .)`, `coalesce(${CTX('b')},.)`]),
    'fallback-to-current',
  );
  assert.equal(
    inferContextWrapper([`once(${CTX('a')})`, `coalesce(${CTX('b')},.)`]),
    'coalesce',
  );
});
