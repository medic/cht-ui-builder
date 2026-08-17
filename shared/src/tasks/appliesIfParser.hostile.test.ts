/**
 * Hostile-by-construction fixtures for the appliesIf parser — shapes taken
 * from the four real configs (gandaki, lumbini, moh-nepal, nssd) that differ
 * from the cht-default shape the code was written against. Pins handoff
 * items A2 and A3 (docs/handoff-nssd-safety-batch-2026-08-11.md) under the
 * config-agnostic principle (docs/principle-config-agnostic.md): PRESERVE —
 * never emit a token you didn't read; REFUSE — a body the rule set can't
 * fully account for is emitted as its original bytes, all-or-nothing.
 *
 * Tests marked `{ todo: true }` assert the CORRECT behavior that HEAD does
 * not yet implement (probed against shared/dist on 2026-08-11); Node reports
 * failing todo tests without failing the suite, so CI stays green until the
 * batch lands. Flip todo off when the fix lands.
 *
 * Every test here CALLS THE SERIALIZER on non-canonical input and asserts on
 * the emitted bytes (memory: feedback_roundtrip_tests_must_call_serializer —
 * idempotent corruption is a known failure mode; string stability alone
 * proves nothing when parse already lost the token).
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseAppliesIf, serializeAppliesIf } from './appliesIfParser.js';

function roundTrip(source: string): string {
  return serializeAppliesIf(parseAppliesIf(source));
}

/* ============ A2 — helper-argument preservation (isAlive / isMuted) ============ */
/* The wild disagrees with the CHT docs: lumbini passes `contact` ×9, nssd     */
/* `contact` ×31, gandaki `contact.contact` ×4. Both are correct CHT. HEAD's   */
/* rule model has no `args` for is_alive/is_muted — parse discards the real    */
/* argument and serialize hardcodes `contact.contact`, so on nssd the guard    */
/* reads `contact.contact.contact.date_of_death` (undefined): isAlive always  */
/* true, isMuted always false — tasks fire for dead and muted patients.       */

test('A2: gandaki/CHT-docs shape — isAlive/isMuted(contact.contact) guards are byte-stable, both polarities', () => {
  // The shape the code already assumes MUST keep working after the A2 fix —
  // emitting `isAlive(contact)` unconditionally would be a different
  // hardcode, not a fix (principle doc §4). Green regression pin.
  const fixtures = [
    { src: 'if (!isAlive(contact.contact)) { return false; }', kind: 'is_alive' },
    { src: 'if (isAlive(contact.contact)) { return false; }', kind: 'is_alive' },
    { src: 'if (isMuted(contact.contact)) { return false; }', kind: 'is_muted' },
    { src: 'if (!isMuted(contact.contact)) { return false; }', kind: 'is_muted' },
  ];
  for (const f of fixtures) {
    const src = `function (contact, report) {\n  ${f.src}\n  return true;\n}`;
    const p = parseAppliesIf(src);
    // Kind only, deliberately NOT deepEqual on the rule object: the A2 fix
    // adds an `args` property and must not turn this pin red.
    assert.equal(p.rules[0]?.kind, f.kind, f.src);
    assert.equal(serializeAppliesIf(p), src, `${f.src} must round-trip byte-stable`);
  }
});

// flip todo off when the fix lands (A2)
test('A2: lumbini/nssd shape — isAlive(contact) guard re-emits EXACTLY the argument that was read', { todo: true }, () => {
  // ×40 in the wild (lumbini ×9, nssd ×31). HEAD rewrites the argument to
  // `contact.contact` — a token it never read — which on these configs
  // dereferences `contact.contact.contact.date_of_death`: undefined, so the
  // guard silently stops guarding.
  const src = `function (contact, report) {
  if (!isAlive(contact)) { return false; }
  return true;
}`;
  const out = roundTrip(src);
  assert.equal(/contact\.contact/.test(out), false, 'must not invent the contact.contact token');
  assert.match(out, /!isAlive\(contact\)/, 'the argument that was read is the argument emitted');
  assert.equal(out, src, 'no-op open+save is byte-stable');
});

// flip todo off when the fix lands (A2)
test('A2: lumbini/nssd shape — isMuted(contact) guard re-emits EXACTLY the argument that was read', { todo: true }, () => {
  const src = `function (contact, report) {
  if (isMuted(contact)) { return false; }
  return true;
}`;
  const out = roundTrip(src);
  assert.equal(/contact\.contact/.test(out), false, 'must not invent the contact.contact token');
  assert.match(out, /isMuted\(contact\)/, 'the argument that was read is the argument emitted');
  assert.equal(out, src, 'no-op open+save is byte-stable');
});

// flip todo off when the fix lands (A2)
test('A2: return-form isAlive(contact) && !isMuted(contact) keeps both arguments through the canonical restructure', { todo: true }, () => {
  // The serializer canonicalizes return-form helpers into guard lines —
  // that restructure is accepted, existing tests pin it via rule stability.
  // What must NOT change is the argument inside the call. HEAD emits
  // `isAlive(contact.contact)` / `isMuted(contact.contact)` here.
  const src = `function (contact, report) {
  return isAlive(contact) && !isMuted(contact);
}`;
  const p = parseAppliesIf(src);
  const out = serializeAppliesIf(p);
  assert.equal(/contact\.contact/.test(out), false, 'must not invent the contact.contact token');
  assert.match(out, /isAlive\(contact\)/);
  assert.match(out, /isMuted\(contact\)/);
  // Semantic stability: re-parsing the emitted form lands on the same rules.
  assert.deepEqual(parseAppliesIf(out).rules, p.rules);
});

// flip todo off when the fix lands (A2)
test('A2: an argument that is something else entirely — isAlive(c.contact) — round-trips verbatim', { todo: true }, () => {
  // Neither of the two known shapes. PRESERVE applies all the same: HEAD
  // classifies this as is_alive and rewrites the argument AND ignores that
  // the param is named `c`, emitting a reference to an undefined `contact`.
  const src = `function (c, report) {
  if (!isAlive(c.contact)) { return false; }
  return true;
}`;
  const out = roundTrip(src);
  assert.match(out, /isAlive\(c\.contact\)/, 'the argument that was read is the argument emitted');
  assert.equal(out, src, 'no-op open+save is byte-stable');
});

/* ============ A3a — all-or-nothing on dropped declarations ============ */
/* nssd shape (pnc_service_after_delivery, anxiety_session_1,             */
/* depression_session_1, motivational_interviewing): a declaration        */
/* followed by a return that references it. The parser correctly flags    */
/* hasRawFallback; HEAD's serializer never reads the flag — it drops the  */
/* const and keeps the expression, emitting valid JS that throws          */
/* ReferenceError inside the rules engine, per contact.                   */

test('A3a: parse flags the unmodelled declaration body (hasRawFallback) — the gate input for the fix', () => {
  // Green pin: the DETECTION already works on HEAD, and stays raw across a
  // serialize round-trip. The todo tests below pin what the serializer must
  // DO with that flag.
  const src = `function (contact, report) {
  const x = Utils.getField(report, 'f');
  return x > 1;
}`;
  const p = parseAppliesIf(src);
  assert.equal(p.hasRawFallback, true, 'a body with an unaccounted statement is a raw fallback');
  const out = serializeAppliesIf(p);
  assert.equal(parseAppliesIf(out).hasRawFallback, true, 'raw-ness survives a round-trip');
});

// flip todo off when the fix lands (A3a)
test('A3a: declaration + return referencing it — serializer emits the ORIGINAL body, all-or-nothing', { todo: true }, () => {
  const src = `function (contact, report) {
  const x = Utils.getField(report, 'f');
  return x > 1;
}`;
  const out = roundTrip(src);
  assert.equal(
    out.includes(`const x = Utils.getField(report, 'f');`),
    true,
    'the declaration must not be dropped while the expression referencing it is kept',
  );
  assert.equal(out, src, 'unmodelled body re-emits its original bytes');
});

// flip todo off when the fix lands (A3a)
test('A3a: two var declarations (nssd mental-health shape) — nothing is dropped', { todo: true }, () => {
  // Paraphrased shape of the four nssd tasks: compute an intermediate from
  // the report, then return a comparison on it. HEAD emits only
  // `return weeks >= 42;` — both vars vanish, `weeks` is undefined.
  const src = `function (contact, report) {
  var lmp = Utils.getField(report, 'lmp_date');
  var weeks = (Date.now() - new Date(lmp).getTime()) / 604800000;
  return weeks >= 42;
}`;
  const out = roundTrip(src);
  assert.equal(out.includes(`var lmp = Utils.getField(report, 'lmp_date');`), true, 'first declaration preserved');
  assert.equal(out.includes('var weeks ='), true, 'second declaration preserved');
  assert.equal(out, src, 'unmodelled body re-emits its original bytes');
});

/* ============ A3b — bare function reference ============ */
/* nssd shape (mental_health_referral_followup, cervical_cancer            */
/* referral_followup): `appliesIf: someHelper` — a reference, not a call.  */
/* HEAD wraps it as `function () { return someHelper; }`, which returns    */
/* the function OBJECT: unconditionally truthy, the task fires for every   */
/* matching report on every patient.                                       */

// flip todo off when the fix lands (A3b)
test('A3b: bare function reference serializes as the bare reference, not a truthy wrapper', { todo: true }, () => {
  for (const src of ['someHelper', 'extras.isEligible']) {
    const p = parseAppliesIf(src);
    assert.equal(p.hasRawFallback, true, `${src}: unmodelled source is a raw fallback`);
    const out = serializeAppliesIf(p);
    assert.equal(
      /return\s/.test(out),
      false,
      `${src}: must not wrap the reference in a function that returns it (unconditionally truthy)`,
    );
    assert.equal(out, src, `${src}: the bare reference round-trips verbatim`);
  }
});
