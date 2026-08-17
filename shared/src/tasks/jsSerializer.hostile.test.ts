/**
 * RESIDUAL HOSTILE SHAPES — the ones the adversarial review of the b0278b3
 * splice confirmed by execution on 2026-08-11, after the pin suite in
 * `jsSerializer.test.ts` went green.
 *
 * Per `docs/principle-config-agnostic.md`, every fixture here is hostile BY
 * CONSTRUCTION: quoted keys, escaped quotes/newlines inside strings, exotic
 * numeric literals, CRLF files, a file-authored `{}` entry — shapes a real
 * config can legally contain and our canonical fixtures never did. Every one
 * of the b0278b3-era defects survived because the fixture was already in the
 * shape the code assumed.
 *
 * Two kinds of test:
 *   - GREEN pins: HEAD already does the right thing; these keep it that way.
 *   - `{ todo: true }` pins: HEAD FAILS these today. They assert the CORRECT
 *     config-agnostic behaviour, so the runner reports them as failing todos
 *     without failing the suite. When the fix lands, flip todo off.
 *
 * House rules this file obeys (learned the hard way — see
 * `feedback_roundtrip_tests_must_call_serializer`):
 *   - every test calls BOTH parseTaskFile and rebuildTaskFile on
 *     non-canonical input;
 *   - assertions are on emitted bytes AND, where corruption is idempotent,
 *     on the value the rules engine would actually evaluate — string
 *     stability alone has passed on corrupted output before.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTaskFile } from './jsParser.js';
import { rebuildTaskFile } from './jsSerializer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** shared/src/tasks → repo root (same depth from dist/tasks at run time) */
const REPO = path.resolve(here, '..', '..', '..');
const TEMPLATES = ['blank', 'empty', 'cht-default', 'malaria'];

/**
 * Evaluate a rebuilt file the way cht-conf loads it, and hand back the
 * exported array. Only for SELF-CONTAINED fixtures — a fixture referencing a
 * helper that doesn't exist here would throw at run time, not parse time.
 */
function evalTasks(src: string): Array<Record<string, unknown>> {
  const mod: { exports?: unknown } = {};
  new Function('module', src)(mod);
  assert.ok(Array.isArray(mod.exports), 'fixture must evaluate to an array');
  return mod.exports as Array<Record<string, unknown>>;
}

/**
 * Syntax-only validity: construct the function WITHOUT calling it. Fixtures
 * with computed expressions reference helpers (mkEvent) that only exist in
 * the real config, so executing them would throw ReferenceError even when
 * the emitted bytes are perfectly good JS.
 */
function assertValidJs(src: string, msg: string): void {
  assert.doesNotThrow(() => new Function(src), msg);
}

/* ================ the guard that keeps every other pin honest ================ */

test('GUARD: all four shipped templates have a tasks.js the pins can chew on', () => {
  // The b0278b3 suite skips a template whose tasks.js is missing — on a
  // machine without them it silently passes 14/14 while pinning NOTHING.
  // This guard fails LOUDLY instead, and re-runs the no-op pin end-to-end so
  // it is never vacuous.
  for (const name of TEMPLATES) {
    const p = path.join(REPO, 'server', 'templates', name, 'tasks.js');
    assert.ok(
      existsSync(p),
      `${p} is missing — the byte-stability pins in jsSerializer.test.ts skip absent templates, so the suite is passing vacuously`,
    );
    const src = readFileSync(p, 'utf8');
    const parsed = parseTaskFile(src);
    assert.notEqual(parsed.arrayBounds, null, `${name}/tasks.js no longer parses as module.exports = [...]`);
    assert.equal(rebuildTaskFile(parsed), src, `${name}/tasks.js no-op rebuild drifted`);
  }
});

/* ============================ shape 1: quoted keys ============================ */

// gandaki-style hyphenated keys must be quoted in JS; parseObjectFields'
// quoted-key branch is dead code (skipNonCodeAt eats the string before the
// key parser runs), so `fields` silently lacks the key.
const QUOTED_KEY = `module.exports = [
  {
    name: 'alpha',
    'quoted-key': 'v',
    title: 'task.alpha.title'
  },
  {
    name: 'beta',
    title: 'task.beta.title'
  }
];
`;

test('GREEN shape 1: an UNTOUCHED quoted-key entry survives verbatim', () => {
  const parsed = parseTaskFile(QUOTED_KEY);
  assert.equal(parsed.entries.length, 2);
  // No-op save: byte-identical despite the parser being blind to the key.
  assert.equal(rebuildTaskFile(parsed), QUOTED_KEY, 'no-op save rewrote a quoted-key file');
  // Editing the OTHER entry: the quoted-key entry is re-emitted verbatim.
  const edited = {
    ...parsed,
    entries: parsed.entries.map((e, i) =>
      i === 1 ? { ...e, fields: { ...e.fields, title: { kind: 'string' as const, value: 'task.beta.renamed' } } } : e,
    ),
  };
  const out = rebuildTaskFile(edited);
  assert.ok(out.includes(parsed.entries[0]!.source), 'alpha must be re-emitted byte-identically');
  assert.ok(out.includes("'quoted-key': 'v'"), 'the quoted-key field vanished from an untouched entry');
  assert.ok(out.includes('task.beta.renamed'), 'the edit to beta must land');
});

// b0278b3 residual shape 1 (P1). HEAD deletes the quoted-key field whenever
// ANY sibling field of the same entry is edited: the entry stops being
// pristine, entryToSource regenerates it from `fields`, and `fields` never
// had the key. Flip todo off when the fix lands.
test('P1 shape 1: a quoted-key field survives an edit to a SIBLING field', { todo: true }, () => {
  const parsed = parseTaskFile(QUOTED_KEY);
  const edited = {
    ...parsed,
    entries: parsed.entries.map((e, i) =>
      i === 0 ? { ...e, fields: { ...e.fields, title: { kind: 'string' as const, value: 'task.alpha.renamed' } } } : e,
    ),
  };
  const out = rebuildTaskFile(edited);
  const tasks = evalTasks(out);
  assert.equal(tasks[0]!['quoted-key'], 'v', 'editing title deleted the sibling quoted-key field');
  assert.ok(out.includes("'quoted-key'"), 'the quoted-key bytes must still be in the file');
  assert.equal(tasks[0]!['title'], 'task.alpha.renamed', 'the edit itself must land');
});

/* ============================ shape 2: escape decay ============================ */

// b0278b3 residual shape 2 (P2). The parser stores the RAW escaped slice
// (backslash included) as the string's value; jsSingleQuoteString then
// re-escapes it on reprint, so backslashes DOUBLE per edit-save cycle and the
// runtime value of a field nobody touched changes. Flip todo off when the
// fix lands.
test('P2 shape 2: escapes in an untouched string keep their runtime value across sibling edits', { todo: true }, () => {
  const src =
    'module.exports = [\n' +
    '  {\n' +
    "    name: 'alpha',\n" +
    "    title: 'mother\\'s\\nvisit',\n" +
    "    icon: 'icon-person'\n" +
    '  }\n' +
    '];\n';
  const before = evalTasks(src)[0]!['title'];
  assert.equal(before, "mother's\nvisit", 'fixture sanity: the source evaluates as intended');

  // Cycle 1: edit a DIFFERENT field of the same entry, as the UI does.
  const p1 = parseTaskFile(src);
  const out1 = rebuildTaskFile({
    ...p1,
    entries: [{ ...p1.entries[0]!, fields: { ...p1.entries[0]!.fields, icon: { kind: 'string' as const, value: 'icon-mother' } } }],
  });
  assert.equal(evalTasks(out1)[0]!['title'], before, 'one sibling edit changed an untouched string value');

  // Cycle 2: the decay compounds — each save doubles the backslashes.
  const p2 = parseTaskFile(out1);
  const out2 = rebuildTaskFile({
    ...p2,
    entries: [{ ...p2.entries[0]!, fields: { ...p2.entries[0]!.fields, icon: { kind: 'string' as const, value: 'icon-x' } } }],
  });
  assert.equal(evalTasks(out2)[0]!['title'], before, 'a second edit-save cycle decayed the string again');
});

/* ========================== shape 3: numeric literals ========================== */

// b0278b3 residual shape 3 (P3). The number regex is /^-?\d+(?:\.\d+)?/, so
// 1e5 parses as 1, 0x10 as 0, 1_000 as 1 — and a sibling edit reprints the
// truncated value. No-op saves are byte-identical (the entry stays pristine),
// which is exactly why idempotence testing never caught it. Flip todo off
// when the fix lands.
test('P3 shape 3: exotic numeric literals (1e5, 0x10, 1_000) survive a sibling edit', { todo: true }, () => {
  const cases = [
    ['1e5', 1e5],
    ['0x10', 0x10],
    ['1_000', 1000],
  ] as const;
  for (const [lit, expected] of cases) {
    const src = `module.exports = [
  {
    name: 'alpha',
    days: ${lit},
    title: 'task.alpha.title'
  }
];
`;
    assert.equal(evalTasks(src)[0]!['days'], expected, `fixture sanity for ${lit}`);
    const parsed = parseTaskFile(src);
    assert.equal(rebuildTaskFile(parsed), src, `no-op save must stay byte-identical for ${lit}`);
    const out = rebuildTaskFile({
      ...parsed,
      entries: [{ ...parsed.entries[0]!, fields: { ...parsed.entries[0]!.fields, title: { kind: 'string' as const, value: 'renamed' } } }],
    });
    assert.equal(
      evalTasks(out)[0]!['days'],
      expected,
      `editing a sibling rewrote days: ${lit} — the untouched value must survive (got source:\n${out})`,
    );
  }
});

/* ============================= shape 4: mixed EOL ============================= */

// b0278b3 residual shape 4 (P3). detectEol feeds the BETWEEN-entry separators
// correctly, but entryToSource hardcodes '\n' inside a reprinted entry, so an
// edit or append in a CRLF file (the shipped templates are CRLF) emits a
// mixed-EOL file. Flip todo off when the fix lands.
test('P3 shape 4: a CRLF file gets CRLF inside reprinted entries, not bare \\n', { todo: true }, () => {
  const src =
    'module.exports = [\r\n' +
    '  {\r\n' +
    "    name: 'alpha',\r\n" +
    "    title: 'task.alpha.title'\r\n" +
    '  },\r\n' +
    '  {\r\n' +
    "    name: 'beta',\r\n" +
    "    title: 'task.beta.title'\r\n" +
    '  }\r\n' +
    '];\r\n';
  const parsed = parseTaskFile(src);
  assert.equal(rebuildTaskFile(parsed), src, 'no-op CRLF save must be byte-identical');

  // Edit entry 0 AND append a created entry — both take the reprint path.
  const edited = {
    ...parsed,
    entries: [
      { ...parsed.entries[0]!, fields: { ...parsed.entries[0]!.fields, title: { kind: 'string' as const, value: 'task.alpha.renamed' } } },
      parsed.entries[1]!,
      {
        bounds: { start: 0, end: 0 },
        source: '{}',
        fields: { name: { kind: 'string' as const, value: 'gamma' } },
      },
    ],
  };
  const out = rebuildTaskFile(edited);
  assert.ok(out.includes(parsed.entries[1]!.source), 'the untouched beta entry must stay byte-identical');
  assert.equal(parseTaskFile(out).entries.length, 3, 'output must re-parse to 3 entries');
  assertValidJs(out, 'CRLF output must stay valid JS');
  assert.equal(
    out.replace(/\r\n/g, '').includes('\n'),
    false,
    'reprinted entries carry bare \\n into a CRLF file — every newline must be \\r\\n',
  );
});

/* =========================== shape 5: literal {} entry =========================== */

// b0278b3 residual shape 5 (P3). isEntryPristine treats source '{}' as the
// UI-created sentinel, so a {} the AUTHOR wrote is reprinted as '{\n\n  }' on
// a save with zero edits. Flip todo off when the fix lands.
test('P3 shape 5: a file-authored {} entry survives a no-op rebuild byte-identically', { todo: true }, () => {
  const src = "module.exports = [\n  {},\n  {\n    name: 'beta',\n    title: 'task.beta.title'\n  }\n];\n";
  const parsed = parseTaskFile(src);
  assert.equal(parsed.entries.length, 2, 'the {} entry must be seen as an entry');
  const out = rebuildTaskFile(parsed);
  assert.equal(out, src, "a no-op save rewrote a file containing an author's literal {} entry");
});

/* ====================== shape 6: green pins on the write paths ====================== */

test('GREEN shape 6: append after a last entry with a TRAILING COMMA keeps prior bytes and valid JS', () => {
  // The shipped-template shape: last entry followed by `,` before `]`.
  const src =
    'module.exports = [\n' +
    '  {\n' +
    "    name: 'alpha',\n" +
    '    events: [...Array(3).keys()].map(i => mkEvent(i)),\n' +
    "    title: 'task.alpha.title'\n" +
    '  },\n' +
    '];\n';
  const parsed = parseTaskFile(src);
  assert.equal(parsed.entries.length, 1);
  const out = rebuildTaskFile({
    ...parsed,
    entries: [
      ...parsed.entries,
      {
        bounds: { start: 0, end: 0 },
        source: '{}',
        fields: {
          name: { kind: 'string' as const, value: 'gamma' },
          title: { kind: 'string' as const, value: 'task.gamma.title' },
        },
      },
    ],
  });
  assert.ok(out.includes(parsed.entries[0]!.source), 'the prior entry must stay byte-identical');
  assert.ok(out.includes('events: [...Array(3).keys()].map(i => mkEvent(i))'), 'the computed expression survives');
  assertValidJs(out, 'appending after a trailing comma must not produce a syntax error');
  assert.equal(parseTaskFile(out).entries.length, 2, 'output must re-parse to 2 entries');
  assert.ok(out.includes("name: 'gamma'"));
  assert.equal(/"/.test(out), false, 'no double quotes emitted (CHT eslint)');
});

test('GREEN shape 6: first entry into an empty CRLF array emits valid JS that re-parses to 1 entry', () => {
  // The blank/empty templates ship exactly `module.exports = [];` with CRLF.
  // (EOL purity INSIDE the new entry is shape 4's todo — not asserted here.)
  const src = 'module.exports = [];\r\n';
  const out = rebuildTaskFile({
    ...parseTaskFile(src),
    entries: [
      {
        bounds: { start: 0, end: 0 },
        source: '{}',
        fields: { name: { kind: 'string' as const, value: 'gamma' } },
      },
    ],
  });
  assertValidJs(out, 'first-entry output must be valid JS');
  assert.equal(parseTaskFile(out).entries.length, 1, 'output must re-parse to exactly 1 entry');
  assert.equal(evalTasks(out)[0]!['name'], 'gamma', 'the created entry must carry its fields');
});

test('GREEN shape 6: remove-one-entry fallback keeps count, validity, and a computed expression verbatim', () => {
  const src =
    'module.exports = [\n' +
    '  {\n' +
    "    name: 'alpha',\n" +
    '    events: [...Array(3).keys()].map(i => mkEvent(i)),\n' +
    "    title: 'task.alpha.title'\n" +
    '  },\n' +
    '  {\n' +
    "    name: 'beta',\n" +
    "    title: 'task.beta.title'\n" +
    '  },\n' +
    '  {\n' +
    "    name: 'gamma',\n" +
    "    title: 'task.gamma.title'\n" +
    '  }\n' +
    '];\n';
  const parsed = parseTaskFile(src);
  assert.equal(parsed.entries.length, 3);
  // Delete the middle entry — the disclosed regenerateWholeArray path.
  const out = rebuildTaskFile({ ...parsed, entries: [parsed.entries[0]!, parsed.entries[2]!] });
  assert.equal(parseTaskFile(out).entries.length, 2, 'output must re-parse to 2 entries');
  assertValidJs(out, 'fallback output must be valid JS');
  assert.ok(
    out.includes('events: [...Array(3).keys()].map(i => mkEvent(i))'),
    'a pristine entry going through the fallback must keep its computed expression verbatim — truncating it is the P0',
  );
  assert.equal(out.includes("name: 'beta'"), false, 'the removed entry must actually be gone');
});
