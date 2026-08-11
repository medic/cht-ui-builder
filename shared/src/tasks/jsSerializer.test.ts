/**
 * THE PIN QA ASKED FOR: load each shipped template's tasks.js, "save" it with
 * no edits, assert the file comes back BYTE-IDENTICAL.
 *
 * This is the test that would have caught the P0 on day one. Before the
 * pristine-entry fix, a no-op save of `server/templates/cht-default/tasks.js`
 * dropped every standalone comment and truncated
 *
 *     events: [...Array(21).keys()].map(i => generateEventForHomeVisit(...))
 *
 * to `events: [...Array(21).keys()]` — an array of the numbers 0-20 instead
 * of event objects. Valid JS, so cht-conf compiled it happily and the rules
 * engine got a silently broken task. QA's full-arc demo had to carry an
 * off-camera "repair tasks.js after every save" step because of it.
 *
 * Reads the REAL templates rather than a hand-written fixture on purpose:
 * those files are copied from cht-core and contain the awkward shapes
 * (computed expressions, comments between entries, helper calls) that a
 * tidy fixture would not.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTaskFile, parseObjectFields } from './jsParser.js';
import { rebuildTaskFile, isEntryPristine, entryToSource } from './jsSerializer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** shared/src/tasks → repo root */
const REPO = path.resolve(here, '..', '..', '..');
const TEMPLATES = ['blank', 'empty', 'cht-default', 'malaria'];

function templateTasks(name: string): string | null {
  const p = path.join(REPO, 'server', 'templates', name, 'tasks.js');
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

/* ===================== the no-op-save byte-stability pin ===================== */

for (const name of TEMPLATES) {
  test(`no-op save of the ${name} template's tasks.js is BYTE-IDENTICAL`, () => {
    const src = templateTasks(name);
    if (src === null) {
      // A template without tasks.js is fine; don't fail the suite over it.
      return;
    }
    const out = rebuildTaskFile(parseTaskFile(src));
    assert.equal(
      out,
      src,
      `a save with no edits rewrote ${name}/tasks.js — the tool must not touch what the author did not edit`,
    );
  });
}

test('cht-default: the computed events expression survives a no-op save', () => {
  // The specific corruption QA hit. Assert on the expression itself so this
  // keeps its meaning even if the template is reformatted later.
  const src = templateTasks('cht-default');
  if (src === null) return;
  const NEEDLE = 'generateEventForHomeVisit';
  if (!src.includes(NEEDLE)) return; // template changed shape; nothing to pin
  const out = rebuildTaskFile(parseTaskFile(src));
  assert.ok(
    out.includes(NEEDLE),
    'the computed events .map(...) chain was truncated — this is the P0',
  );
  // And the truncated form must NOT appear as a whole events value.
  assert.equal(
    /events:\s*\[\.\.\.Array\(21\)\.keys\(\)\]\s*[,\n]/.test(out),
    false,
    'events was reduced to a bare [...Array(21).keys()] — the numbers, not the events',
  );
});

test('cht-default: standalone comments inside the array survive a no-op save', () => {
  const src = templateTasks('cht-default');
  if (src === null) return;
  const commentsIn = (s: string) => (s.match(/^\s*\/\//gm) ?? []).length;
  const out = rebuildTaskFile(parseTaskFile(src));
  assert.ok(
    commentsIn(out) >= commentsIn(src),
    `comment lines dropped: ${commentsIn(src)} → ${commentsIn(out)}`,
  );
});

/* ===================== the pristine/edited discrimination ===================== */

const TWO_TASKS = `module.exports = [
  {
    name: 'alpha',
    title: 'task.alpha.title',
    appliesTo: 'reports',
    appliesToType: [ 'form_a' ],
    // a standalone comment the tool must not eat
    events: [...Array(21).keys()].map(i => generateEventForHomeVisit((i + 1) * 2, 6, 7)),
    actions: [{ form: 'form_a' }]
  },
  {
    name: 'beta',
    title: 'task.beta.title',
    appliesTo: 'reports',
    appliesToType: [ 'form_b' ],
    events: [{ id: 'beta', days: 1, start: 0, end: 1 }],
    actions: [{ form: 'form_b' }]
  }
];
`;

test('editing ONE entry leaves the OTHER byte-identical (the whole point)', () => {
  const parsed = parseTaskFile(TWO_TASKS);
  assert.equal(parsed.entries.length, 2);
  const alphaSource = parsed.entries[0]!.source;

  // Edit only `beta`, exactly as TasksEditor.patchEntry does.
  const edited = {
    ...parsed,
    entries: parsed.entries.map((e, i) =>
      i === 1 ? { ...e, fields: { ...e.fields, title: { kind: 'string' as const, value: 'task.beta.renamed' } } } : e,
    ),
  };
  const out = rebuildTaskFile(edited);

  assert.ok(out.includes(alphaSource.trim()), 'alpha must be re-emitted verbatim');
  assert.ok(out.includes('generateEventForHomeVisit'), 'alpha keeps its computed events');
  assert.ok(out.includes('a standalone comment the tool must not eat'), 'alpha keeps its comment');
  assert.ok(out.includes("task.beta.renamed"), 'beta carries the edit');
  assert.equal(out.includes('task.beta.title'), false, 'beta no longer carries the old title');
});

test('isEntryPristine: true straight off the parser, false after any edit', () => {
  const parsed = parseTaskFile(TWO_TASKS);
  for (const e of parsed.entries) {
    assert.equal(isEntryPristine(e), true, `${JSON.stringify(e.fields['name'])} parses pristine`);
  }
  const touched = {
    ...parsed.entries[0]!,
    fields: { ...parsed.entries[0]!.fields, name: { kind: 'string' as const, value: 'changed' } },
  };
  assert.equal(isEntryPristine(touched), false);
});

test('isEntryPristine: a UI-created entry (source "{}") is never pristine', () => {
  // `addEntry` seeds bounds {0,0} and source '{}' with real fields; it must
  // regenerate, not emit '{}'.
  const fresh = {
    bounds: { start: 0, end: 0 },
    source: '{}',
    fields: { name: { kind: 'string' as const, value: 'new_task' } },
  };
  assert.equal(isEntryPristine(fresh), false);
  assert.ok(entryToSource(fresh).includes("name: 'new_task'"));
});

test('isEntryPristine: key REORDERING counts as a change', () => {
  // The emitters iterate Object.entries, so order is observable output.
  const parsed = parseTaskFile(TWO_TASKS);
  const e = parsed.entries[1]!;
  const reversed = Object.fromEntries(Object.entries(e.fields).reverse());
  assert.equal(isEntryPristine({ ...e, fields: reversed }), false);
});

test('a new entry appended to shipped entries: only the new one is generated', () => {
  const parsed = parseTaskFile(TWO_TASKS);
  const appended = {
    ...parsed,
    entries: [
      ...parsed.entries,
      {
        bounds: { start: 0, end: 0 },
        source: '{}',
        fields: {
          name: { kind: 'string' as const, value: 'gamma' },
          events: { kind: 'array' as const, raw: "[{ id: 'gamma', days: 0, start: 0, end: 0 }]" },
        },
      },
    ],
  };
  const out = rebuildTaskFile(appended);
  // Both originals verbatim…
  for (const e of parsed.entries) assert.ok(out.includes(e.source.trim()));
  // …plus ours, and it must be single-quoted (CHT eslint).
  assert.ok(out.includes("name: 'gamma'"));
  assert.equal(/"/.test(out.slice(out.indexOf("name: 'gamma'"))), false, 'no double quotes emitted');
  // Re-parsing sees three entries.
  assert.equal(parseTaskFile(out).entries.length, 3);
});

test('rebuild is a fixpoint: a second no-op save changes nothing further', () => {
  for (const name of TEMPLATES) {
    const src = templateTasks(name);
    if (src === null) continue;
    const once = rebuildTaskFile(parseTaskFile(src));
    const twice = rebuildTaskFile(parseTaskFile(once));
    assert.equal(twice, once, `${name} is not a rebuild fixpoint`);
  }
});

test('a file with no exported array is returned untouched', () => {
  const weird = '// just a comment\nconst x = 1;\n';
  assert.equal(rebuildTaskFile(parseTaskFile(weird)), weird);
});

test('parseObjectFields is the oracle isEntryPristine relies on (sanity)', () => {
  // If this ever stops round-tripping, isEntryPristine silently degrades to
  // "always regenerate" — safe, but the pin above would start failing, which
  // is the signal we want.
  const fields = parseObjectFields("{ name: 'a', events: [{ id: 'x' }] }");
  assert.equal(fields['name']?.kind, 'string');
  assert.equal(fields['events']?.kind, 'array');
});
