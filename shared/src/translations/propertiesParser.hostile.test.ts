/**
 * Hostile-fixture pins for duplicate translation keys (handoff item A9,
 * docs/handoff-nssd-safety-batch-2026-08-11.md).
 *
 * Run: `pnpm --filter @cht-ui/shared build && pnpm --filter @cht-ui/shared test`
 *
 * Background: duplicate keys exist in ALL FOUR real configs (up to 127 in one
 * file). cht-conf 6.0.2 (npm `properties`, Java semantics) loads the LAST
 * occurrence, so the last line is the value CHT actually shows. HEAD's
 * `updateProperty` targets the FIRST occurrence instead — the edit is
 * invisible to CHT *and* destroys the shadowed line. The tests below pin the
 * CORRECT (last-wins) behavior; the ones HEAD fails are `{ todo: true }` and
 * flip to normal tests when the A9 fix lands.
 *
 * NOTE for the dev landing A9: `propertiesParser.roundtrip.test.ts` has a
 * test ("duplicate key: first occurrence wins updateProperty, ...") that pins
 * the current WRONG first-wins behavior — update it in the same change.
 *
 * Shape 5 of the A9 brief (locale-agnostic parsing) is deliberately absent:
 * this parser is per-file and has no locale-specific code path (the only
 * mention of locales in the module is a doc comment), so there is nothing to
 * pin at this layer.
 *
 * Fixtures are deliberately NON-CANONICAL — `key=value` with no spaces, `:`
 * and bare-tab separators, CRLF, Devanagari values — so every assertion
 * exercises the serializer's raw-preservation path, not just idempotence on
 * already-canonical text.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  parseProperties,
  serializeProperties,
  updateProperty,
  type PropertiesFile,
} from './propertiesParser.js';

type Entry = { kind: 'entry'; key: string; value: string; raw: string };

/** All entry lines for `key`, in document order (duplicates included). */
function entriesFor(file: PropertiesFile, key: string): Entry[] {
  const out: Entry[] = [];
  for (const line of file) {
    if (line.kind === 'entry' && line.key === key) out.push(line);
  }
  return out;
}

test('A9 §1: read last-wins — parse exposes every occurrence and a document-order fold yields the value cht-conf loads', () => {
  const src = 'dup=a\r\n# shadowing note between the two\r\ndup=b\r\n';
  const parsed = parseProperties(src);
  // Both physical occurrences must survive parsing as separate entries — a
  // map-shaped parse that swallowed one could never round-trip the file.
  const dups = entriesFor(parsed, 'dup');
  assert.equal(dups.length, 2);
  assert.equal(dups[0]?.value, 'a');
  assert.equal(dups[1]?.value, 'b');
  // Effective-value surface: folding entries in document order must land on
  // the LAST occurrence, matching cht-conf 6.0.2 / Java load semantics.
  const effective = new Map<string, string>();
  for (const line of parsed) {
    if (line.kind === 'entry') effective.set(line.key, line.value);
  }
  assert.equal(effective.get('dup'), 'b');
  // And the hostile (no-space separators) source must still round-trip.
  assert.equal(serializeProperties(parsed), src);
});

// A9: HEAD's updateProperty edits the FIRST occurrence, so this pin fails
// today — cht-conf reads the last line, so the edit below must land there.
// Flip todo off when the fix lands.
test('A9 §2: write last-wins — updateProperty rewrites the LAST occurrence; the shadowed first line stays byte-untouched', { todo: true }, () => {
  // Last occurrence deliberately uses a `:` separator — the rewrite must
  // preserve the separator style of the line it actually edits.
  const src = 'dup=first\r\nother=keep\r\ndup : second\r\n';
  const out = serializeProperties(updateProperty(parseProperties(src), 'dup', 'edited'));
  assert.equal(out, 'dup=first\r\nother=keep\r\ndup : edited\r\n');
});

// A9: same defect with three occurrences — only the FINAL line (the one CHT
// loads) may change; every earlier occurrence is preserved verbatim.
// Flip todo off when the fix lands.
test('A9 §2b: triple occurrence — only the FINAL occurrence is rewritten', { todo: true }, () => {
  // Final occurrence uses a bare-tab separator (legal Java properties, seen
  // in hand-maintained catalogs) — the rewrite must keep it.
  const src = 'tri=one\n# mid-file comment\ntri=two\ntri\tthree\n';
  const out = serializeProperties(updateProperty(parseProperties(src), 'tri', 'edited'));
  assert.equal(out, 'tri=one\n# mid-file comment\ntri=two\ntri\tedited\n');
});

test('A9 §3: no-op save of a duplicate-bearing file is byte-identical, including comments/blanks between the duplicates', () => {
  const src =
    '# header\r\n' +
    'dup=पहिलो\r\n' +
    '\r\n' +
    '! note explaining why the shadowed line is still here\r\n' +
    'dup : दोस्रो\r\n' +
    'tail=x\r\n';
  assert.equal(serializeProperties(parseProperties(src)), src);
});

// A9: the nastiest variant — a "save without changes" from the editor writes
// back the CHT-effective value (the LAST occurrence's). HEAD applies it to
// the FIRST occurrence, silently overwriting the shadowed value even though
// nothing visible changed (idempotent-looking corruption: the output even
// round-trips stably afterwards). Correct behavior: byte-identical output.
// Flip todo off when the fix lands.
test('A9 §3b: re-saving the CHT-effective (last) value is a no-op — the shadowed first line must not be rewritten', { todo: true }, () => {
  const src = 'dup=first\r\nother=keep\r\ndup=second\r\n';
  const out = serializeProperties(updateProperty(parseProperties(src), 'dup', 'second'));
  assert.equal(out, src);
});

test('A9 §4: duplicated keys are enumerable from the parse result (surface for the editor’s duplicate warning)', () => {
  const src = 'a=1\r\ndup=x\r\ndup=y\r\ntri=1\r\ntri=2\r\ntri=3\r\n';
  const parsed = parseProperties(src);
  // The parse result is a line list, not a map — so a caller can group
  // entries by key and report every key that appears more than once, with
  // all occurrence values in document order.
  const occurrences = new Map<string, string[]>();
  for (const line of parsed) {
    if (line.kind !== 'entry') continue;
    const seen = occurrences.get(line.key) ?? [];
    seen.push(line.value);
    occurrences.set(line.key, seen);
  }
  const duplicated = [...occurrences.entries()].filter(([, values]) => values.length > 1);
  assert.deepEqual(
    duplicated,
    [
      ['dup', ['x', 'y']],
      ['tri', ['1', '2', '3']],
    ],
  );
  // Enumeration must not disturb the bytes.
  assert.equal(serializeProperties(parsed), src);
});
