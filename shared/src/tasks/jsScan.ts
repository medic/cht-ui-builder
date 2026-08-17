/**
 * The three primitives every hand-rolled JS scanner in this repo needs:
 * skip a comment or string literal, match a bracket pair, scan to the end
 * of a string literal.
 *
 * ## Why this file exists, and what it deliberately does NOT do
 *
 * This exact trio is currently duplicated **seven** times as private
 * functions — `jsParser.ts:97`, `actionsParser.ts:390`,
 * `eventsParser.ts:299`, `helpersParser.ts:179`,
 * `contactSummaryParser.ts:74`, `cardsParser.ts:317`, `eventsParser`'s
 * variant. Consolidating all seven is a mechanical refactor across parsers
 * that carry the round-trip invariant, so it is a separate change with its
 * own justification, not a side effect of a feature.
 *
 * What this file does do: give the NEXT scanner somewhere to import from,
 * so the count stops at seven. `contextKeyDiscovery.ts` is the first
 * caller.
 *
 * Semantics are the common denominator of the seven copies — they agree on
 * all three functions, which is why lifting them is safe when someone does
 * take the refactor.
 */

/**
 * If `src[i]` starts a comment or a string literal, return the index just
 * past it; otherwise `null`.
 *
 * Callers use this as the first move of every loop iteration so that
 * brackets, commas and identifiers inside comments and strings are never
 * mistaken for code.
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
  if (c === "'" || c === '"' || c === '`') return scanString(src, i, c);
  return null;
}

/**
 * Index just past the string literal opening at `start` with `quote`.
 *
 * Template literals recurse through `${…}` via {@link matchBracket} so that
 * a brace or quote inside an interpolation cannot terminate the scan early
 * — the shape that matters for `context[`baby_name_${i}_ctx`]`.
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
 * Index of the `close` bracket matching the `open` bracket at `openIdx`,
 * or `-1` if unbalanced. Comments and string literals are skipped.
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
    if (sk !== null) {
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
