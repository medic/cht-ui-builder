/**
 * Hostile-by-construction fixtures for the extras-helpers parser — shapes
 * from the four real configs (gandaki, lumbini, moh-nepal, nssd) that differ
 * from the canonical layout the code was written against. Pins handoff items
 * A6 and A7's patchHelper notes (docs/handoff-nssd-safety-batch-2026-08-11.md)
 * under the config-agnostic principle (docs/principle-config-agnostic.md):
 * PRESERVE — never emit (or eat) a token you didn't read.
 *
 * The A6 bug class: `removeExport()` / `renameExport()` run a single
 * UNANCHORED `src.replace()` over the whole file, so the rewrite lands on the
 * first surviving occurrence of the name — usually a call site inside another
 * helper — instead of the entry in `module.exports`. On nssd that corrupts a
 * call in 30 of 37 helpers and leaves a dangling identifier in
 * `module.exports` for 15 of 22 exported ones → ReferenceError at `require()`
 * → contact-summary dies entirely, every profile blank.
 *
 * Tests marked `{ todo: true }` assert the CORRECT behavior that HEAD does
 * not yet implement (probed against shared/dist on 2026-08-11); Node reports
 * failing todo tests without failing the suite, so CI stays green until the
 * batch lands. Flip todo off when the fix lands.
 *
 * Every test here CALLS parseHelpers AND a rebuild function
 * (patchHelper/removeHelper) on non-canonical input and asserts on the
 * emitted bytes plus CJS-load semantics (memory:
 * feedback_roundtrip_tests_must_call_serializer — idempotent corruption is a
 * known failure mode; parse-only assertions prove nothing here).
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseHelpers, patchHelper, removeHelper } from './helpersParser.js';

type CjsExports = Record<string, unknown>;

/**
 * Evaluate a rebuilt extras file the way the rules engine loads it —
 * CommonJS semantics over `module.exports`. A dangling shorthand identifier
 * in the exports object literal throws HERE, at load time, which is exactly
 * how the A6 corruption presents on a device (function hoisting means a
 * stale call INSIDE a helper body does not throw until invoked — the
 * exports literal is the load-time tripwire).
 */
function evalAsCjs(src: string): CjsExports {
  const mod: { exports: CjsExports } = { exports: {} };
  (new Function('module', src) as (m: { exports: CjsExports }) => void)(mod);
  return mod.exports;
}

/* ============ A6 — the call-before-exports fixture ============ */
/* Helper B calls helper A BEFORE module.exports lists A. Real extras files */
/* are layered exactly like this (base predicates first, composites after,  */
/* exports last), so A's first occurrence after its decl is B's call site — */
/* the unanchored replace lands there instead of on the exports entry.      */

const FIXTURE_CALL_BEFORE_EXPORTS = `const AGE_LIMIT = 60;

function isPatient(c) {
  return c.type === 'person' && !c.date_of_death;
}

function isEligibleWoman(c) {
  if (!isPatient(c)) { return false; }
  return c.sex === 'female';
}

module.exports = {
  isPatient,
  isEligibleWoman
};
`;

// flip todo off when the fix lands (A6)
test('A6: removeHelper scopes the export-entry removal to module.exports — a call site BEFORE the exports block survives verbatim', { todo: true }, () => {
  // HEAD (probed): the replace eats `isPatient` out of B's guard, emitting
  // `if (!(c)) { return false; }` — silently inverted logic — while the
  // exports block still says `{ isPatient, isEligibleWoman }`, a dangling
  // identifier that throws ReferenceError the moment the file is required.
  const out = removeHelper(parseHelpers(FIXTURE_CALL_BEFORE_EXPORTS), 'isPatient');
  assert.equal(/function isPatient\(/.test(out), false, 'the declaration is removed');
  assert.equal(
    out.includes('if (!isPatient(c)) { return false; }'),
    true,
    "B's call site is not the tool's to rewrite — it must survive byte-for-byte " +
      '(the user sees the dangling call in the raw editor; a mangled guard they never see)',
  );
  assert.deepEqual(
    parseHelpers(out).exportedNames,
    ['isEligibleWoman'],
    'the exports entry — the thing removeExport exists to remove — is the one occurrence that changes',
  );
  // Load-time semantics: no dangling shorthand left in the exports literal.
  const mod = evalAsCjs(out);
  assert.equal(typeof mod.isEligibleWoman, 'function', 'file still loads under require()');
});

// flip todo off when the fix lands (A6)
test('A6: rename rewrites the declaration AND the module.exports entry — never the first call site that happens to match', { todo: true }, () => {
  // patchHelper's own contract (its doc comment): "If `newName` differs from
  // `name`, also renames the declaration AND the entry in module.exports."
  // Call sites are outside that contract — rewriting references is a
  // separate, explicit macro, never a side effect of an unanchored replace.
  // HEAD (probed): renames B's call site instead, leaving `isPatient`
  // dangling in module.exports → ReferenceError at require().
  const parsed = parseHelpers(FIXTURE_CALL_BEFORE_EXPORTS);
  const helper = parsed.helpers.find((h) => h.name === 'isPatient')!;
  const out = patchHelper(parsed, 'isPatient', 'isVerifiedPatient', helper.params, helper.body);
  assert.equal(/function isVerifiedPatient\(c\)/.test(out), true, 'declaration is renamed');
  assert.equal(
    out.includes('if (!isPatient(c)) { return false; }'),
    true,
    "B's call site keeps the OLD name — the rename touched only what its contract names",
  );
  assert.deepEqual(
    parseHelpers(out).exportedNames,
    ['isVerifiedPatient', 'isEligibleWoman'],
    'the exports entry is renamed (HEAD leaves the old name dangling there)',
  );
  const mod = evalAsCjs(out);
  assert.equal(typeof mod.isVerifiedPatient, 'function', 'file still loads under require()');
});

/* ============ A7 — patchHelper identity round-trip ============ */

// flip todo off when the fix lands (A7)
test('A7: patching a helper with its OWN unchanged name/params/body is byte-identical', { todo: true }, () => {
  // HEAD fails identity on 37/37 real nssd helpers, and (probed) on both
  // helpers of this fixture, two ways at once: declStart is computed after
  // `\s*` already ate the blank line separating the decls, so the rebuild
  // eats it; and the rebuilt decl adds `\n` around a body that already
  // carries its own boundary newlines, doubling them.
  const parsed = parseHelpers(FIXTURE_CALL_BEFORE_EXPORTS);
  assert.equal(parsed.helpers.length, 2, 'fixture sanity: both helpers parsed');
  for (const h of parsed.helpers) {
    const out = patchHelper(parsed, h.name, h.name, h.params, h.body);
    assert.equal(
      out,
      FIXTURE_CALL_BEFORE_EXPORTS,
      `${h.name}: a no-op edit must round-trip byte-identical`,
    );
  }
});

/* ============ A7 — no-op/body edits must not grow module.exports ============ */
/* nssd keeps 15 internal helpers deliberately un-exported; HEAD's           */
/* `!exportedNames.includes(name)` branch appends every one of them to      */
/* module.exports on any body edit.                                         */

// flip todo off when the fix lands (A7)
test('A7: a body edit on an internal (non-exported) helper must NOT append it to module.exports', { todo: true }, () => {
  const fixture = `function daysSince(d) {
  return Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
}

function isOverdue(c) {
  return daysSince(c.last_visit) > 30;
}

module.exports = {
  isOverdue
};
`;
  const out = patchHelper(
    parseHelpers(fixture),
    'daysSince',
    'daysSince',
    ['d'],
    '  return Math.round((Date.now() - new Date(d).getTime()) / 86400000);',
  );
  assert.equal(
    out.includes('return Math.round((Date.now() - new Date(d).getTime()) / 86400000);'),
    true,
    'the edited body lands',
  );
  assert.deepEqual(
    parseHelpers(out).exportedNames,
    ['isOverdue'],
    'the project chose not to export daysSince — that choice is not ours to reverse',
  );
  assert.equal(
    out.includes('module.exports = {\n  isOverdue\n};'),
    true,
    'the exports block is byte-untouched by a body edit elsewhere',
  );
});

// flip todo off when the fix lands (A7)
test('A7: a file exporting via property assignment must NOT get a module.exports = {} block invented', { todo: true }, () => {
  // Real configs also export one property at a time. HEAD's addExport
  // fallback appends `module.exports = { bmiBand };` to the END of the file
  // — which REASSIGNS the exports object and silently discards every
  // sibling export assigned above it. DERIVE says copy the project's shape;
  // inventing a block the file never had is the opposite.
  const fixture = `function calcBmi(weight, height) {
  return weight / (height * height);
}
function bmiBand(bmi) {
  return bmi < 18.5 ? 'under' : 'ok';
}
module.exports.calcBmi = calcBmi;
module.exports.bmiBand = bmiBand;
`;
  const out = patchHelper(
    parseHelpers(fixture),
    'bmiBand',
    'bmiBand',
    ['bmi'],
    "  return bmi < 18.5 ? 'underweight' : 'ok';",
  );
  assert.equal(out.includes("return bmi < 18.5 ? 'underweight' : 'ok';"), true, 'the edit lands');
  assert.equal(
    /module\.exports\s*=\s*\{/.test(out),
    false,
    'no invented `module.exports = { … }` block — the file never had one',
  );
  assert.equal(
    out.includes('module.exports.calcBmi = calcBmi;\nmodule.exports.bmiBand = bmiBand;'),
    true,
    'the property-assignment exports survive verbatim',
  );
  const mod = evalAsCjs(out);
  assert.equal(typeof mod.calcBmi, 'function', 'calcBmi export survives loading');
  assert.equal(typeof mod.bmiBand, 'function', 'bmiBand export survives loading');
});

/* ============ green regression pins (pass on HEAD today) ============ */
/* These keep the A6/A7 fixes honest in the other direction: scoping the    */
/* replace and dropping the append branch must not break the paths that     */
/* already work.                                                            */

test('A6: parse survives brace traps (strings/comments/template literals); a body edit rewrites ONLY the edited helper', () => {
  // Green pin (HEAD passes). Single-newline separation between decls — the
  // layout that dodges HEAD's declStart bug — plus every brace trap
  // matchBracket claims to handle. The edit must leave the trap helpers,
  // the arrow helper (not a recognized shape — preserved verbatim), and the
  // exports block byte-identical.
  const fixture = `// Shared helpers. NOTE: '}' braces in strings/comments below are traps.
const MS_IN_DAY = 86400000;
function labelFor(c) {
  // closing brace in a comment: }
  return c.name + ' {' + c.type + '}';
}
function noteFor(c) {
  return \`note: \${c.name} }\`;
}
const isDead = (c) => Boolean(c.date_of_death);
function isSenior(c) {
  return !isDead(c) && c.age >= 60;
}
module.exports = {
  labelFor,
  noteFor,
  isSenior
};
`;
  const parsed = parseHelpers(fixture);
  assert.deepEqual(
    parsed.helpers.map((h) => h.name),
    ['labelFor', 'noteFor', 'isSenior'],
    'function-form helpers parsed; arrow form is not a recognized helper',
  );
  assert.equal(
    parsed.helpers.find((h) => h.name === 'labelFor')!.body,
    "\n  // closing brace in a comment: }\n  return c.name + ' {' + c.type + '}';\n",
    'braces inside comments/strings do not truncate the body',
  );
  assert.deepEqual(parsed.exportedNames, ['labelFor', 'noteFor', 'isSenior']);

  const out = patchHelper(parsed, 'isSenior', 'isSenior', ['c'], '  return !isDead(c) && c.age >= 70;');
  assert.equal(
    out.includes('function isSenior(c) {\n  return !isDead(c) && c.age >= 70;\n}'),
    true,
    'the edited helper is rebuilt with the new body',
  );
  assert.equal(
    out.includes(
      "function labelFor(c) {\n  // closing brace in a comment: }\n  return c.name + ' {' + c.type + '}';\n}",
    ),
    true,
    'trap helper #1 byte-identical',
  );
  assert.equal(out.includes('function noteFor(c) {\n  return `note: ${c.name} }`;\n}'), true, 'trap helper #2 byte-identical');
  assert.equal(out.includes('const isDead = (c) => Boolean(c.date_of_death);'), true, 'arrow helper byte-identical');
  assert.equal(out.includes('module.exports = {\n  labelFor,\n  noteFor,\n  isSenior\n};'), true, 'exports block byte-identical');

  // Semantic check: the rebuilt file loads and the edit is live.
  const mod = evalAsCjs(out);
  const isSenior = mod.isSenior as (c: { age: number }) => boolean;
  assert.equal(isSenior({ age: 75 }), true);
  assert.equal(isSenior({ age: 65 }), false, 'the threshold edit (60 → 70) took effect');
});

test('A6: removeHelper where the name occurs nowhere before the exports block — decl and entry removed, semantics intact', () => {
  // Green pin (HEAD passes). Deliberately asserted at the semantic level,
  // NOT on the exports-block bytes: HEAD's replace emits the valid-but-ugly
  // `{\n  isPatient,};` here, and the A6 fix will emit something cleaner —
  // both satisfy these assertions, so the pin survives the fix.
  const fixture = `function isPatient(c) {
  return c.type === 'person';
}

function isStaff(c) {
  return c.type === 'chw' || c.type === 'supervisor';
}

module.exports = {
  isPatient,
  isStaff
};
`;
  const out = removeHelper(parseHelpers(fixture), 'isStaff');
  assert.equal(/function isStaff\(/.test(out), false, 'the declaration is removed');
  assert.equal(
    out.includes("function isPatient(c) {\n  return c.type === 'person';\n}"),
    true,
    'the untouched helper is byte-identical',
  );
  assert.deepEqual(parseHelpers(out).exportedNames, ['isPatient']);
  const mod = evalAsCjs(out);
  assert.equal(typeof mod.isStaff, 'undefined', 'removed helper is no longer exported');
  const isPatient = mod.isPatient as (c: { type: string }) => boolean;
  assert.equal(isPatient({ type: 'person' }), true, 'surviving export still works');
});
