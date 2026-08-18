/**
 * Rule: every reference in an XLSForm resolves to something that will exist.
 *
 * Two channels:
 *
 *  1. **`${…}` tokens** in `relevant`, `calculation`, `constraint`, `label::*`
 *     and the other referencing columns. Valid if the inner content matches
 *     a survey row `name` in the same form. Empty braces are their own
 *     defect and reported separately.
 *
 *  2. **Bare `../inputs/…` XPaths** in the same columns — validated against
 *     the form's real `inputs` block.
 *
 * Ordering violations (ref exists but comes later in the survey) are
 * intentionally *not* flagged here — the FormEditor's `validateOrdering`
 * already surfaces those with a richer UI. Deferring to it avoids
 * double-reporting the same defect class.
 *
 * ## Why channel 2 exists (P1-DEPLOY)
 *
 * This rule used to inspect ONLY `${…}` tokens, and to accept any path
 * starting `../inputs/` **by assumption** — its docstring said "which the
 * runtime injects at evaluation." Both halves let the deploy blocker
 * through:
 *
 *  - The cell that actually broke is `calculation = ../inputs/contact/name`.
 *    A bare XPath, no braces. The rule never looked at it at all.
 *  - And the prefix whitelist meant that even the `${../inputs/…}` spelling
 *    was waved through without checking anything.
 *
 * `validate-app-forms` fails the ENTIRE run on one bad XPath, so a single
 * unresolvable reference blocked every form and the app settings. Satisfying
 * the invariant in the scaffold is not enough — without enforcing it here,
 * the next feature that writes a reference reintroduces the same class.
 *
 * ## The exception, which is measured rather than assumed
 *
 * `inputs/meta/*` really IS injected, and nothing else is. Evidence: across
 * every form in the four real configs, the four shipped templates and three
 * generated projects — 200-plus forms — the ONLY `../inputs/…` paths that
 * are referenced without being declared are `inputs/meta/location/lat` and
 * `inputs/meta/location/long`. They appear in cht-core's own canonical
 * `PLACE_TYPE-create.xlsx`, which deploys, so requiring a declaration for
 * them would flag 31 working forms including our own templates.
 *
 * Every other reference — all of `contact/*`, `user/*`, `source`,
 * `source_id` — is declared in every real form that uses it. That is the
 * invariant this rule now enforces: the one the configs already hold and
 * the tool was alone in breaking.
 */
import { isStructural, structuralKind, type SurveyRow } from '../../xlsform/types.js';
import type { PreflightCheck, PreflightContext, PreflightResult } from '../types.js';

export const DANGLING_REFS_CHECK: PreflightCheck = {
  id: 'dangling-refs',
  label: 'Dangling references',
};

/** Columns scanned for `${…}` references. */
const REF_COLUMNS = [
  'relevant',
  'calculation',
  'constraint',
  'choice_filter',
  'repeat_count',
  'default',
] as const;

/** Capture the raw inner content of a `${...}` token, including path syntax. */
const REF_RE = /\$\{([^}]*)\}/g;

/**
 * Any `../…/inputs/<path>` reference, however many `..` steps deep. The
 * step count depends only on where the cell sits in the survey tree — it
 * does not change WHICH node inside `inputs` is meant — so the path after
 * `inputs/` is the whole meaning and the prefix is discarded.
 *
 * Deliberately not anchored: these appear inside larger expressions, e.g.
 * cht-core's own `concat(../../inputs/meta/location/lat, …)`.
 */
const INPUT_XPATH_RE = /(?:\.\.\/)+inputs\/([A-Za-z0-9_/-]+)/g;

/**
 * The one subtree CHT genuinely injects, so a reference into it needs no
 * declaration. See the module doc for the measurement behind this being the
 * only entry.
 */
const RUNTIME_INJECTED_INPUT_PREFIXES = ['meta/'];

function isRuntimeInjectedInput(path: string): boolean {
  return RUNTIME_INJECTED_INPUT_PREFIXES.some((p) => path.startsWith(p));
}

function buildNameSet(survey: SurveyRow[]): Set<string> {
  const names = new Set<string>();
  for (const row of survey) {
    if (isStructural(row)) continue;
    if (row.name) names.add(row.name);
  }
  return names;
}

/**
 * Every path the form actually declares inside its outermost `inputs`
 * group, as `contact/name`, `user/contact_id`, `source`, …
 *
 * Group nesting is what makes this answerable, which is why it cannot reuse
 * `buildNameSet` — that flattens names and throws the path away, so it
 * could not tell a top-level question called `name` from the
 * `inputs/contact/name` node. Those are different nodes and only one of
 * them makes `../inputs/contact/name` resolve.
 */
function declaredInputPaths(survey: SurveyRow[]): Set<string> {
  const paths = new Set<string>();
  const stack: string[] = [];
  for (const row of survey) {
    // structuralKind tolerates `begin_group` / `end_group`, which 29 real
    // forms use. Matching only the space spelling meant the stack never
    // popped on those forms, so top-level rows after the inputs block were
    // registered as declared input paths — garbage in both directions:
    // references that should fail passed, and vice versa.
    const k = structuralKind(row);
    if (k?.edge === 'begin') {
      stack.push(row.name);
      continue;
    }
    if (k?.edge === 'end') {
      stack.pop();
      continue;
    }
    if (stack[0] === 'inputs') {
      paths.add([...stack.slice(1), row.name].join('/'));
    }
  }
  return paths;
}

/** Iterate every ref-bearing cell of a row and yield {column, expr}. */
function* refBearingCells(row: SurveyRow): Iterable<{ column: string; expr: string }> {
  for (const col of REF_COLUMNS) {
    const v = row.extras[col];
    if (v) yield { column: col, expr: v };
  }
  // label::<locale> and hint::<locale> can carry ${output} refs. Iterate
  // the parsed label map and every extras key that starts with `hint::`.
  for (const locale of Object.keys(row.labels)) {
    const v = row.labels[locale];
    if (v) yield { column: `label::${locale}`, expr: v };
  }
  for (const key of Object.keys(row.extras)) {
    if (!key.startsWith('hint::')) continue;
    const v = row.extras[key];
    if (v) yield { column: key, expr: v };
  }
}

export function runDanglingRefsRule(ctx: PreflightContext): PreflightResult[] {
  const results: PreflightResult[] = [];
  for (const { formId, xlsform } of ctx.forms) {
    const names = buildNameSet(xlsform.survey);
    const declaredInputs = declaredInputPaths(xlsform.survey);
    for (const row of xlsform.survey) {
      if (isStructural(row)) continue;
      for (const { column, expr } of refBearingCells(row)) {
        // Channel 2 — bare `../inputs/…` XPaths. Runs before the `${…}`
        // scan because it is the channel that catches the deploy blocker,
        // and it applies to the same cell text either way.
        const xre = new RegExp(INPUT_XPATH_RE.source, 'g');
        let xm: RegExpExecArray | null;
        while ((xm = xre.exec(expr)) !== null) {
          const inputPath = xm[1] ?? '';
          if (!inputPath || isRuntimeInjectedInput(inputPath)) continue;
          if (declaredInputs.has(inputPath)) continue;
          results.push({
            ruleId: 'dangling-refs',
            severity: 'error',
            message:
              `"${xm[0]}" in ${column} points at inputs/${inputPath}, which this ` +
              `form does not declare. Declare it inside the inputs block — ` +
              `cht-conf's validate-app-forms rejects the whole project over one ` +
              `unresolvable XPath.`,
            affectedItemId: formId,
            rowId: row.rowId,
            column,
          });
        }

        // Reset regex state per expression (global flag carries index).
        const re = new RegExp(REF_RE.source, 'g');
        let m: RegExpExecArray | null;
        while ((m = re.exec(expr)) !== null) {
          const inner = m[1] ?? '';
          const trimmed = inner.trim();
          if (!trimmed) {
            // `${}` or `${ }` — empty braces are their own defect.
            results.push({
              ruleId: 'dangling-refs',
              severity: 'error',
              message: `Empty ${'${}'} reference in ${column}`,
              affectedItemId: formId,
              rowId: row.rowId,
              column,
            });
            continue;
          }
          // A `${../inputs/…}` token has already been judged by channel 2
          // above, which scans the raw cell text and therefore sees inside
          // the braces. Skipping here avoids reporting the same cell twice.
          if (/(?:\.\.\/)+inputs\//.test(trimmed)) continue;
          // Path-shaped refs like `${/data/group/age}` → last segment.
          const lastSegment = trimmed.split('/').filter((s) => s.length > 0).pop() ?? '';
          if (names.has(trimmed) || names.has(lastSegment)) continue;
          results.push({
            ruleId: 'dangling-refs',
            severity: 'error',
            message: `Unknown reference "${'${'}${trimmed}}" in ${column}`,
            affectedItemId: formId,
            rowId: row.rowId,
            column,
          });
        }
      }
    }
  }
  return results;
}
