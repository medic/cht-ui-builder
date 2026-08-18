/**
 * Tier 1.5 of docs/plans/calc-reference-builder.md — "Reference a value"
 * helpers for the calculation builder.
 *
 * Three reference idioms surface in real CHT app forms (the motivating
 * config: `nssd/chis/forms/app/diabetes_referral.xlsx` — 8 of 10 calc
 * cells are mechanical references, never genuine logic):
 *
 *   1. **Contact input field** — `../inputs/contact/<field>`. The standard
 *      patient-link pattern; `inputs/contact/_id` / `name` / `patient_id`.
 *   2. **Contact-summary value** — `instance('contact-summary')/context/<key>`,
 *      optionally wrapped in one of two stock idioms:
 *      - `none`                   → bare reference.
 *      - `fallback-to-current`    → `if(<ref>, <ref>, .)`  (use the ctx value
 *                                    if present, else keep my own answer)
 *      - `read-once`              → `once(<ref>)`           (XForms `once()`)
 *   3. **Another field in this form** — `${field}` (already shipped as
 *      `field-ref` in Tier 1; covered here for the recognizer's completeness).
 *
 * This module is a pure string helper. NO `ParsedCalculation.shape` is
 * widened; NO parser is taught a new shape. The wrapped idioms are emitted
 * as fixed canonical strings and stored verbatim — the parent calc Tier-0
 * §3.1 self-check guarantees byte-stability on no-op open/save (either the
 * wrapped form survives as `decision_table`/`single` byte-identical, or it
 * demotes to `raw` and the bytes are preserved unchanged).
 *
 * Re-hydration is therefore a UI-level concern: the picker calls
 * {@link recognizeReference} on `props.value` to pre-select the right kind
 * and wrapper, independent of whatever `parseCalculation` decided about
 * the same string. This module IS that recognizer.
 */

/** The reference idioms the picker offers. `null` means "not a reference
 *  this module recognizes" — the caller falls through to the existing
 *  literal/number/expression kinds. */
export type ReferenceKind = 'contact-input' | 'contact-summary' | 'field-ref';

/**
 * The stock wrappers on a contact-summary context read.
 *
 * ## Measured, not assumed (docs/principle-config-agnostic.md)
 *
 * Every `instance('contact-summary')` cell across the four real configs —
 * nssd/chis, gandaki, lumbini, moh-nepal (both variants) — normalised by
 * replacing each reference with `REF` and collapsing whitespace. 132
 * occurrences, 12 distinct shapes, **every one of them in the
 * `calculation` column** and nowhere else:
 *
 *   47  if(REF, REF, .)                     fallback-to-current
 *   29  if(REF != '', REF, .)               guarded-fallback      ← was blind
 *   17  coalesce(REF,.)                     coalesce              ← was blind
 *   15  REF                                 none
 *    9  once(REF)                           read-once
 *    5  if(REF != '', REF,.)                guarded-fallback (spacing)
 *    4  if(REF != 0, REF, .)                guarded-fallback, sentinel 0
 *    2  if(REF != '', REF , .)              guarded-fallback (spacing)
 *    1  coalesce(REF, .)                    coalesce (spacing)
 *    1  if(REF != '', REF,'no')             genuinely bespoke → raw
 *    1  if(REF >0 , REF,0)                  genuinely bespoke → raw
 *    1  if(REF != '', REF, if(${x}...))     genuinely bespoke → raw
 *
 * The first three wrappers alone recognised 71 of 132 (54%). The two added
 * here take it to 129 of 132 (98%); the remaining three have different
 * semantics — their else-branch is a literal or a nested `if`, not `.` —
 * and correctly fall through to the raw/expression path where their bytes
 * are preserved untouched.
 *
 * The 46% blind spot was not evenly spread, which is the part that matters:
 * `guarded-fallback` is the ONLY idiom gandaki and moh-nepal use (6 of 6
 * cells each), and `coalesce` is lumbini's vaccination idiom (17 of its 35).
 * So the picker recognised **zero** of two configs' context reads and 37%
 * of a third's. "Works on NSSD" was hiding that.
 */
export type ContextWrapper =
  | 'none'
  | 'fallback-to-current'
  | 'guarded-fallback'
  | 'coalesce'
  | 'read-once';

/**
 * Result of recognizing a reference idiom. `argument` is the inner
 * payload: the bare field name (contact-input / field-ref) or the
 * context key (contact-summary), without any quoting or prefix.
 */
export interface RecognizedReference {
  kind: ReferenceKind;
  argument: string;
  /** Only meaningful when `kind === 'contact-summary'`. */
  wrapper: ContextWrapper;
  /**
   * For `guarded-fallback` only: the emptiness sentinel the author compared
   * against, verbatim — `"''"` in 36 of the 40 real cells, `"0"` in the
   * other 4. Carried through recognition so re-emission can hand back what
   * was written instead of normalising `!= 0` into `!= ''`, which would
   * silently change the test (posture 1: never emit a token you didn't
   * read). `null` for every other wrapper.
   */
  sentinel: string | null;
}

/** `../inputs/contact/<field>` — capture the bare field segment. The field
 *  segment is conservative: `\w+` (no slashes), since the nssd fixture and
 *  the standard CHT pattern never carry nested paths. A nested path falls
 *  through to the expression kind and survives via raw byte-identity. */
const CONTACT_INPUT_RE = /^\.\.\/inputs\/contact\/([\w-]+)$/;

/** Bare `instance('contact-summary')/context/<key>`. The key segment is
 *  `\w+` for the same conservative reason as above. Single quotes around
 *  `contact-summary` only; the nssd cells (and the CHT convention) use
 *  single quotes, never doubles. */
const CONTACT_SUMMARY_BARE_RE =
  /^instance\('contact-summary'\)\/context\/([\w-]+)$/;

/** `once(instance('contact-summary')/context/<key>)`. The `once()` wrapper
 *  is the canonical CHT read-once idiom. Internal whitespace inside the
 *  parens is tolerated (punch-list §H1) — `once( ref )`, `once(\n ref \n)`
 *  etc. all re-hydrate the same. The bare reference itself is canonical
 *  (no spaces around `instance` or the slashes). */
const CONTACT_SUMMARY_ONCE_RE =
  /^once\(\s*instance\('contact-summary'\)\/context\/([\w-]+)\s*\)$/;

/**
 * `if(<ref>, <ref>, .)` with MATCHING refs. The wrapper's whole purpose is
 * "use the ctx value if present, else fall back to the current answer", so
 * the condition and the value MUST be the same expression — otherwise the
 * semantics are different (see nssd's `avg_result_ctx` cell, where the
 * condition checks `avg_result` but the value reads `avg_result_ctx` —
 * intentionally different, not a wrapper). Non-matching variants fall
 * through to the expression kind and survive via raw byte-identity.
 *
 * Spacing tolerated: optional whitespace around commas, around the dot,
 * and between `if(` and the first ref. Matches the spelling the parent
 * `serializeCalculation` would canonicalize an if-chain to.
 */
const CONTACT_SUMMARY_FALLBACK_RE =
  /^if\(\s*(instance\('contact-summary'\)\/context\/[\w-]+)\s*,\s*(instance\('contact-summary'\)\/context\/[\w-]+)\s*,\s*\.\s*\)$/;

/**
 * `if(<ref> != <sentinel>, <ref>, .)` with MATCHING refs — the *guarded*
 * fallback. Semantically the same intent as the bare fallback above ("use
 * the context value if it has one, else keep my own answer") but stated as
 * an explicit emptiness test rather than relying on XPath truthiness.
 *
 * This is the single most common idiom after the bare fallback (40 of 132
 * real cells) and the ONLY one gandaki and moh-nepal use. Two sentinels
 * occur in the wild — `''` (36) and `0` (4) — and they are NOT
 * interchangeable, so the sentinel is captured and re-emitted verbatim
 * rather than canonicalised.
 *
 * The sentinel is restricted to the two spellings that actually occur —
 * empty-string and `0` — rather than any quoted literal. `if(REF != 'no',
 * REF, .)` means "use the context value unless it equals no", which is a
 * VALUE comparison, not an emptiness test; labelling it "use my current
 * answer if not set" would misdescribe it, so it belongs on the raw path
 * where its bytes survive untouched.
 *
 * Only `!=` is matched, and only with `.` as the else-branch. The three
 * bespoke real cells (`if(REF != '', REF,'no')`, `if(REF >0 , REF,0)`,
 * `if(REF != '', REF, if(${taskLmpDate} != '', …))`) deliberately fail
 * this: their else-branch is a literal or a nested `if`, which is
 * different behaviour, and they belong in the raw path where their bytes
 * survive untouched.
 *
 * Spacing is tolerated generously (`REF,.` / `REF , .` both occur) because
 * recognition is READ-ONLY — it only pre-selects the picker's dropdown. A
 * cell is rewritten solely when the author actively picks something, so
 * tolerating spelling variants costs no byte-stability and buys correct
 * pre-selection on real files.
 */
const CONTACT_SUMMARY_GUARDED_RE =
  /^if\(\s*(instance\('contact-summary'\)\/context\/[\w-]+)\s*!=\s*(''|""|0)\s*,\s*(instance\('contact-summary'\)\/context\/[\w-]+)\s*,\s*\.\s*\)$/;

/**
 * `coalesce(<ref>, .)` — lumbini's idiom for its whole vaccination series
 * (17 of its 35 context cells). XPath `coalesce` returns the first
 * non-empty argument, so this is the same "context value, else my own
 * answer" intent expressed with one function instead of a conditional.
 */
const CONTACT_SUMMARY_COALESCE_RE =
  /^coalesce\(\s*instance\('contact-summary'\)\/context\/([\w-]+)\s*,\s*\.\s*\)$/;

/** Bare `${field}` reference. Matches the existing `field-ref` kind in
 *  CalculationBuilder.tsx; included here so the recognizer is complete. */
const FIELD_REF_RE = /^\$\{([^}]+)\}$/;

/** Strip the `instance('contact-summary')/context/` prefix and return the
 *  bare context key, or `null` if `s` isn't a bare ctx ref. */
function extractContextKey(s: string): string | null {
  const m = s.trim().match(CONTACT_SUMMARY_BARE_RE);
  return m ? m[1]! : null;
}

/**
 * Try to recognize a reference idiom in `raw`. Returns `null` when `raw`
 * doesn't match any of the four idioms (caller routes to literal / number
 * / expression). Trims surrounding whitespace before matching; never
 * mutates `raw`.
 */
export function recognizeReference(raw: string): RecognizedReference | null {
  const v = raw.trim();
  if (v === '') return null;

  // 1. Contact input field.
  const ci = v.match(CONTACT_INPUT_RE);
  if (ci)
    return { kind: 'contact-input', argument: ci[1]!, wrapper: 'none', sentinel: null };

  // 2a. Contact-summary read-once.
  const csOnce = v.match(CONTACT_SUMMARY_ONCE_RE);
  if (csOnce)
    return {
      kind: 'contact-summary',
      argument: csOnce[1]!,
      wrapper: 'read-once',
      sentinel: null,
    };

  // 2b. Contact-summary fallback-to-current — only when the two refs match.
  const csFallback = v.match(CONTACT_SUMMARY_FALLBACK_RE);
  if (csFallback) {
    const refA = csFallback[1]!;
    const refB = csFallback[2]!;
    if (refA === refB) {
      const key = extractContextKey(refA);
      if (key !== null) {
        return {
          kind: 'contact-summary',
          argument: key,
          wrapper: 'fallback-to-current',
          sentinel: null,
        };
      }
    }
    // Different refs — intentional non-wrapper semantics (e.g. nssd's
    // `avg_result_ctx`). Fall through to expression kind.
  }

  // 2c. Contact-summary GUARDED fallback — `if(ref != '', ref, .)`. Same
  // matching-refs requirement as 2b, for the same reason: a guard on one
  // key that yields a different key is bespoke logic, not a wrapper.
  const csGuarded = v.match(CONTACT_SUMMARY_GUARDED_RE);
  if (csGuarded) {
    const refA = csGuarded[1]!;
    const sentinel = csGuarded[2]!;
    const refB = csGuarded[3]!;
    if (refA === refB) {
      const key = extractContextKey(refA);
      if (key !== null) {
        return {
          kind: 'contact-summary',
          argument: key,
          wrapper: 'guarded-fallback',
          sentinel,
        };
      }
    }
  }

  // 2d. Contact-summary coalesce — `coalesce(ref, .)`.
  const csCoalesce = v.match(CONTACT_SUMMARY_COALESCE_RE);
  if (csCoalesce)
    return {
      kind: 'contact-summary',
      argument: csCoalesce[1]!,
      wrapper: 'coalesce',
      sentinel: null,
    };

  // 2e. Contact-summary bare reference.
  const csBare = v.match(CONTACT_SUMMARY_BARE_RE);
  if (csBare)
    return {
      kind: 'contact-summary',
      argument: csBare[1]!,
      wrapper: 'none',
      sentinel: null,
    };

  // 3. Bare `${field}` reference — the existing field-ref kind.
  const fr = v.match(FIELD_REF_RE);
  if (fr) return { kind: 'field-ref', argument: fr[1]!, wrapper: 'none', sentinel: null };

  return null;
}

/* ============================== emitters ================================ */

/** Build a contact-input reference: `../inputs/contact/<field>`. */
export function emitContactInput(field: string): string {
  return `../inputs/contact/${field}`;
}

/** The sentinel `guarded-fallback` uses when the caller has no authored one
 *  to preserve. `''` is what 36 of the 40 real guarded cells compare
 *  against; the other 4 use `0` and reach here only via a recognised
 *  reference that carries its own sentinel. */
export const DEFAULT_GUARD_SENTINEL = "''";

/**
 * Build a contact-summary reference, optionally wrapped. Returns the bare
 * reference for `wrapper === 'none'`.
 *
 * `sentinel` applies to `guarded-fallback` only and should be passed
 * straight through from {@link RecognizedReference.sentinel} when
 * re-emitting an existing cell, so `!= 0` stays `!= 0`.
 */
export function emitContactSummary(
  key: string,
  wrapper: ContextWrapper,
  sentinel: string | null = null,
): string {
  const bare = `instance('contact-summary')/context/${key}`;
  switch (wrapper) {
    case 'none':
      return bare;
    case 'fallback-to-current':
      return `if(${bare}, ${bare}, .)`;
    case 'guarded-fallback':
      return `if(${bare} != ${sentinel ?? DEFAULT_GUARD_SENTINEL}, ${bare}, .)`;
    case 'coalesce':
      return `coalesce(${bare}, .)`;
    case 'read-once':
      return `once(${bare})`;
  }
}

/**
 * The wrapper idiom a project already uses, inferred from its own form
 * cells — docs/principle-config-agnostic.md posture 2 (Derive).
 *
 * Why this exists: the plan for this feature stated that NSSD's house
 * idiom is `once(instance(…))`. Measured, it is not — NSSD's own cells are
 * `if(REF, REF, .)` 46, guarded 40, `once()` 9, bare 2. Defaulting to
 * `once()` would have matched 9 of 97. And the answer differs per project:
 * nssd → fallback-to-current, gandaki and moh-nepal → guarded-fallback,
 * lumbini → coalesce. So there is no single right constant to hardcode,
 * which is the whole argument for deriving it.
 *
 * Pass every calculation cell in the project (cells that are not
 * contact-summary reads are ignored, so callers can hand over all of them).
 * Returns `null` when the project has no context reads at all — the caller
 * then picks its own starting point rather than being handed a fabricated
 * "house style" inferred from nothing.
 */
export function inferContextWrapper(cells: readonly string[]): ContextWrapper | null {
  const counts = new Map<ContextWrapper, number>();
  for (const cell of cells) {
    const rec = recognizeReference(cell);
    if (!rec || rec.kind !== 'contact-summary') continue;
    counts.set(rec.wrapper, (counts.get(rec.wrapper) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  // Ties broken by this order, which is the global frequency across the four
  // real configs — so a 1-vs-1 tie lands on the more common idiom overall
  // rather than on whichever happened to be enumerated first.
  const tieBreak: ContextWrapper[] = [
    'fallback-to-current',
    'guarded-fallback',
    'coalesce',
    'none',
    'read-once',
  ];
  let best: ContextWrapper = tieBreak[0]!;
  let bestCount = -1;
  for (const w of tieBreak) {
    const c = counts.get(w) ?? 0;
    if (c > bestCount) {
      best = w;
      bestCount = c;
    }
  }
  return best;
}

/** Build a same-form field reference: `${field}`. */
export function emitFieldRef(field: string): string {
  return `\${${field}}`;
}
