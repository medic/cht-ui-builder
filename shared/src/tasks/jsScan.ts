/**
 * The primitives every hand-rolled JS scanner in this repo needs: skip a
 * comment, string or regex literal; match a bracket pair; scan to the end of a
 * string literal; blank all non-code so a regex search sees only code.
 *
 * ## Why this file exists, and what it deliberately does NOT do
 *
 * The skip/match/scan trio is currently duplicated **seven** times as private
 * functions — `jsParser.ts`, `actionsParser.ts`, `eventsParser.ts`,
 * `helpersParser.ts`, `contactSummaryParser.ts`, `cardsParser.ts` and
 * `eventsParser`'s variant. Consolidating all seven is a mechanical refactor
 * across parsers that carry the round-trip invariant, so it is a separate
 * change with its own justification, not a side effect of a feature.
 *
 * What this file does do: give the NEXT scanner somewhere to import from, so
 * the count stops at seven. `contextKeyDiscovery.ts` is the first caller.
 *
 * The regex-literal handling and `blankNonCode` go BEYOND those seven copies,
 * because the copies get both wrong and the discovery scan needs them: a quote
 * inside a regex literal used to open a phantom string that swallowed the rest
 * of the file, and a commented-out `const context = …` used to win over the
 * live binding. Both were found by adversarial review, and both silently
 * produced a partial key list that reported itself complete.
 */

/**
 * If `src[i]` starts a comment, a string literal or a regex literal, return
 * the index just past it; otherwise `null`.
 *
 * Callers use this as the first move of every loop iteration so that brackets,
 * commas and identifiers inside non-code are never mistaken for code.
 */
export function skipNonCodeAt(src: string, i: number): number | null {
  const c = src[i];
  if (c === '/' && src[i + 1] === '/') {
    const nl = src.indexOf('\n', i);
    return nl < 0 ? src.length : nl + 1;
  }
  if (c === '/' && src[i + 1] === '*') {
    const end = src.indexOf('*/', i + 2);
    return end < 0 ? src.length : end + 2;
  }
  // A REGEX LITERAL is non-code too, and skipping it matters. A quote inside
  // one — `.replace(/'/g, '')`, which real contact-summaries contain — used to
  // open a phantom string that swallowed the rest of the file. Every later
  // `context.<key> =` was then invisible AND no indeterminate note was raised.
  if (c === '/' && isRegexStart(src, i)) return scanRegex(src, i);
  if (c === "'" || c === '"' || c === '`') return scanString(src, i, c);
  return null;
}

/** Characters after which a `/` must start a regex rather than divide. */
const REGEX_PRECEDERS = '(,=:[!&|?{};+-*%~^<>';

/** Keywords after which a `/` starts a regex (`return /re/`, `typeof /re/`). */
const REGEX_PRECEDING_WORDS = [
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'new',
  'delete',
  'void',
];

/**
 * Could the `/` at `i` begin a regex literal rather than a division?
 *
 * The classic JS ambiguity, decided by the previous significant character:
 * after a value (identifier, number, `)`, `]`) a `/` divides; after an
 * operator or an opening bracket it starts a regex. Guessing wrong on a
 * division is harmless here — {@link scanRegex} bails at a newline and the `/`
 * is treated as code again — whereas guessing wrong on a regex loses the rest
 * of the file, so the bias is deliberately toward "regex".
 */
function isRegexStart(src: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j] ?? '')) j--;
  if (j < 0) return true;
  const p = src[j] ?? '';
  if (REGEX_PRECEDERS.includes(p)) return true;
  const word = /[A-Za-z_$]+$/.exec(src.slice(Math.max(0, j - 11), j + 1));
  return word ? REGEX_PRECEDING_WORDS.includes(word[0]) : false;
}

/**
 * Index just past the regex literal opening at `start`, or `start + 1` when it
 * turns out not to be one (an unterminated literal on this line means the `/`
 * was division after all).
 *
 * Character classes are tracked so a `/` inside `[...]` does not end the
 * literal early, and trailing flags are consumed so they are not re-scanned as
 * identifiers.
 */
function scanRegex(src: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '\n') return start + 1;
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      let j = i + 1;
      while (j < src.length && /[a-z]/.test(src[j] ?? '')) j++;
      return j;
    }
    i++;
  }
  return src.length;
}

/**
 * Index just past the string literal opening at `start` with `quote`.
 *
 * Template literals recurse through their `${…}` interpolations via
 * {@link matchBracket} so that a brace or quote inside one cannot terminate
 * the scan early — the shape that matters for a template-literal key family.
 */
export function scanString(src: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    if (quote === '`' && c === '$' && src[i + 1] === '{') {
      const close = matchBracket(src, i + 1, '{', '}');
      if (close < 0) return src.length;
      i = close + 1;
      continue;
    }
    i++;
  }
  return src.length;
}

/**
 * Index of the `close` bracket matching the `open` bracket at `openIdx`, or
 * `-1` if unbalanced. Comments, strings and regex literals are skipped.
 */
export function matchBracket(
  src: string,
  openIdx: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const sk = skipNonCodeAt(src, i);
    if (sk !== null && sk > i) {
      i = sk;
      continue;
    }
    const c = src[i];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/**
 * A copy of `src` with every comment, string and regex literal replaced by
 * spaces of the same length — so a regex search finds only real CODE while
 * offsets still line up with the original.
 *
 * Exists because searching raw source for `const context =` let a
 * COMMENTED-OUT binding win over the live one, pointing a whole scan at a dead
 * helper and then presenting its keys as the config's. Newlines are preserved
 * so line numbers and newline-sensitive scanning still work.
 */
export function blankNonCode(src: string): string {
  const out = src.split('');
  let i = 0;
  while (i < src.length) {
    const sk = skipNonCodeAt(src, i);
    if (sk === null || sk <= i) {
      i++;
      continue;
    }
    for (let j = i; j < Math.min(sk, src.length); j++) {
      const ch = out[j];
      if (ch !== '\n' && ch !== '\r') out[j] = ' ';
    }
    i = sk;
  }
  return out.join('');
}
