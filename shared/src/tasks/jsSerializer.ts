/**
 * Serializer for `tasks.js`-shaped files — the write half of
 * {@link parseTaskFile}.
 *
 * Lives in `shared` (it used to be three private functions inside
 * `client/src/ui/TasksEditor.tsx`) so the round-trip invariant can be pinned
 * by a unit test against the real shipped templates. Per CLAUDE.md the bar
 * for anything in here is: parse → serialize → parse is byte-stable for
 * everything the editor did not explicitly change.
 *
 * ## The bug this file exists to fix
 *
 * The previous `rebuildTasksFile` regenerated EVERY entry from its parsed
 * fields on every save:
 *
 *     const bodies = parsed.entries.map(entryToSource).join(',\n  ');
 *
 * Text outside the exported array was spliced byte-for-byte, so the
 * "imports and helpers stay untouched" half of the contract held — but every
 * entry INSIDE the array was reprinted from the model. On the cht-default
 * template that silently dropped standalone comments and, worse, truncated a
 * hand-written computed expression:
 *
 *     events: [...Array(21).keys()].map(i => generateEventForHomeVisit(...))
 *     →  events: [...Array(21).keys()]
 *
 * Valid JavaScript, so `compile-app-settings` passed, and the rules engine
 * received a semantically broken task. Editing ONE task corrupted the other
 * five the author never touched. (Found by QA's full-arc demo, which had to
 * carry an off-camera "repair tasks.js after every save" fixup.)
 *
 * ## The fix
 *
 * `TaskEntry` already carries `source` — "the full source text between
 * bounds" — so the parser had preserved each entry's original bytes all
 * along; the writer just never used them. Now an entry that the editor did
 * not touch is re-emitted VERBATIM, and only edited entries are reprinted.
 *
 * "Untouched" is decided WITHOUT any baseline plumbing: `entry.fields` was
 * produced by parsing `entry.source`, so the two agree by construction until
 * something is edited. Re-parsing `source` and comparing is therefore an
 * exact edited/not-edited test — and it fails safe, because any mismatch
 * (including a shape the parser round-trips imperfectly) falls through to
 * the regenerating path, i.e. the old behaviour.
 */
import { parseObjectFields, parseTaskFile, jsSingleQuoteString } from './jsParser.js';
import type { FieldValue, ParsedTaskFile, TaskEntry } from './jsParser.js';

/** Render one `FieldValue` back to source text. */
export function fieldValueToSource(v: FieldValue): string {
  switch (v.kind) {
    case 'string':
      return jsSingleQuoteString(v.value);
    case 'number':
      return String(v.value);
    case 'boolean':
      return String(v.value);
    case 'identifier':
      return v.value;
    case 'array':
    case 'object':
    case 'function':
    case 'unknown':
      // Verbatim: these carry the author's own text (an events array, an
      // appliesIf body, a computed expression). Never reformat them.
      return v.raw;
  }
}

/** Regenerate one entry's object literal from its parsed fields. */
export function entryToSource(entry: TaskEntry): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(entry.fields)) {
    // Single-quote non-identifier keys to match CHT's eslint config
    // (quotes: ['error', 'single']); JSON.stringify would use double quotes.
    const keyOut = /^[a-zA-Z_$][\w$]*$/.test(k) ? k : jsSingleQuoteString(k);
    lines.push(`    ${keyOut}: ${fieldValueToSource(v)}`);
  }
  return `{\n${lines.join(',\n')}\n  }`;
}

/**
 * True when `entry` still matches the source it was parsed from — i.e. the
 * editor has not changed any of its fields, so its original bytes can be
 * re-emitted as-is.
 *
 * Returns `false` for an entry with no usable `source` (one the UI created
 * from scratch: `addEntry` seeds `source: '{}'`), and for anything whose
 * re-parse disagrees for any reason. Both cases fall through to
 * regeneration, so a wrong answer here can only ever lose formatting — never
 * change meaning.
 */
export function isEntryPristine(entry: TaskEntry): boolean {
  const src = entry.source?.trim();
  if (!src || src === '{}') return false;
  let reparsed: Record<string, FieldValue>;
  try {
    reparsed = parseObjectFields(src);
  } catch {
    return false;
  }
  const a = Object.keys(entry.fields);
  const b = Object.keys(reparsed);
  if (a.length !== b.length) return false;
  // Key ORDER matters: the emitters iterate Object.entries, so a reordering
  // would change the output and must count as a change.
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  for (const k of a) {
    const x = entry.fields[k]!;
    const y = reparsed[k];
    if (!y || x.kind !== y.kind) return false;
    const xv = 'value' in x ? String(x.value) : x.raw;
    const yv = 'value' in y ? String(y.value) : y.raw;
    if (xv !== yv) return false;
  }
  return true;
}

/** The file's own line ending, so we never convert CRLF to LF on save. */
function detectEol(src: string): string {
  return src.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Last-resort path: reprint the whole array body. Only used when the entry
 * LIST itself changed shape (an entry removed or reordered), where there is
 * no unambiguous way to preserve the text between entries.
 */
function regenerateWholeArray(parsed: ParsedTaskFile, eol: string): string {
  const { source, arrayBounds } = parsed;
  if (!arrayBounds) return source;
  const before = source.slice(0, arrayBounds.start + 1);
  const after = source.slice(arrayBounds.end);
  const bodies = parsed.entries
    .map((e) => (isEntryPristine(e) ? e.source.trim() : entryToSource(e)))
    .join(`,${eol}  `);
  return `${before}${eol}  ${bodies}${eol}${after}`;
}

/**
 * Rebuild a `tasks.js` source string from its parsed form.
 *
 * This is a BYTE-RANGE SPLICE, not a reprint. Only the ranges belonging to
 * entries the editor actually changed are replaced; every other byte of the
 * file — imports, helpers, the array's own punctuation, the line endings, the
 * trailing comma, and the comments BETWEEN entries — is carried through
 * untouched. A save with no edits therefore returns the input verbatim.
 *
 * That last property is the one worth protecting: reprinting the array (even
 * with each entry's own source re-emitted) still lost the inter-entry
 * comments and rewrote CRLF, which is how a no-op save used to dirty all of
 * cht-default's five shipped tasks.
 *
 * Removing or reordering entries falls back to {@link regenerateWholeArray},
 * because the text between two entries has no well-defined owner once the
 * entries move. That is no worse than the previous behaviour, and the common
 * flows — no-op save, edit one task, append a task — all take the splice path.
 */
export function rebuildTaskFile(parsed: ParsedTaskFile): string {
  const { source: src, arrayBounds } = parsed;
  if (!arrayBounds) return src;
  const eol = detectEol(src);

  // Entries carrying real bounds came from the file; bounds-less ones were
  // created in the UI (`addEntry` seeds bounds {0,0}).
  const fromFile = parsed.entries.filter((e) => e.bounds.end > e.bounds.start);
  const created = parsed.entries.filter((e) => e.bounds.end <= e.bounds.start);

  // The file's own entries, as they currently sit on disk — the authority on
  // whether anything was removed or reordered.
  const onDisk = parseTaskFile(src).entries;
  const sameSkeleton =
    fromFile.length === onDisk.length &&
    fromFile.every(
      (e, i) =>
        e.bounds.start === onDisk[i]!.bounds.start && e.bounds.end === onDisk[i]!.bounds.end,
    );
  if (!sameSkeleton) return regenerateWholeArray(parsed, eol);

  // Splice operations in ORIGINAL coordinates, applied right-to-left so
  // earlier offsets stay valid.
  const ops: Array<{ start: number; end: number; text: string }> = [];

  for (let i = 0; i < fromFile.length; i++) {
    const e = fromFile[i]!;
    const isLast = i === fromFile.length - 1;
    const needsRewrite = !isEntryPristine(e);
    // New entries are appended by extending the LAST existing entry's range;
    // that keeps the array's existing trailing punctuation untouched and
    // avoids guessing where a comma belongs.
    const appendHere = isLast && created.length > 0;
    if (!needsRewrite && !appendHere) continue;

    let text = needsRewrite ? entryToSource(e) : e.source;
    if (appendHere) {
      for (const c of created) text += `,${eol}  ${entryToSource(c)}`;
    }
    ops.push({ start: e.bounds.start, end: e.bounds.end + 1, text });
  }

  // First entry into a previously EMPTY array: no last entry to extend, so
  // write the whole body between the brackets.
  if (fromFile.length === 0 && created.length > 0) {
    ops.push({
      start: arrayBounds.start + 1,
      end: arrayBounds.end,
      text: `${eol}  ${created.map(entryToSource).join(`,${eol}  `)}${eol}`,
    });
  }

  let out = src;
  for (const op of ops.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, op.start) + op.text + out.slice(op.end);
  }
  return out;
}
