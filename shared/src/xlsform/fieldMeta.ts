/**
 * Display metadata for every named survey row, for field pickers — T9c
 * (#16), docs/plans/9_complex_logic_calculation_relevant_constraint.
 *
 * A real pregnancy form has about 230 named rows: every `*_note`, every
 * `r_*` summary row, every `__*` hidden output and plumbing calculate. A
 * picker that lists them by name in sheet order is unusable. This module
 * computes, once per form, what a picker needs to show label + name,
 * search by either, group by section, and hide technical rows by default.
 *
 * Pure data over `SurveyRow[]`: nothing here touches XLSForm bytes, and the
 * value a picker writes stays the field NAME.
 */
import {
  isStructural,
  structuralKind,
  inferFieldKind,
  type FieldKind,
  type LocaleMap,
  type SurveyRow,
} from './types.js';

export type TechnicalReason =
  /** `note` rows: display text, never an answer. */
  | 'note'
  /** `r_*` rows: the summary-page convention in CHT forms. */
  | 'summary'
  /** `__*` rows: hidden outputs. */
  | 'hidden-output'
  /** `hidden` type or a `hidden` appearance. */
  | 'hidden';

export interface FieldMeta {
  name: string;
  rowId: string;
  /** Raw XLSForm type, e.g. `select_one yes_no`. */
  type: string;
  kind: FieldKind;
  /** Resolved label (first non-empty in locale order), `''` when none. */
  label: string;
  /** Innermost enclosing group's label or name; `''` at top level. */
  section: string;
  /** Names of the enclosing groups, outermost first. */
  sectionPath: string[];
  technical: boolean;
  technicalReason?: TechnicalReason;
}

/**
 * First non-empty label in `locales` order, then any non-empty label in
 * sheet-column order, else `''`. Whitespace is collapsed so a multi-line
 * label fits one option row.
 */
export function resolveLabel(labels: LocaleMap | undefined, locales: readonly string[]): string {
  if (!labels) return '';
  for (const loc of locales) {
    const v = labels[loc];
    if (v && v.trim()) return collapse(v);
  }
  for (const v of Object.values(labels)) {
    if (v && v.trim()) return collapse(v);
  }
  return '';
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Why a row is technical, or `null` when it is an ordinary question. */
export function technicalReasonFor(row: SurveyRow): TechnicalReason | null {
  const type = row.type.trim().toLowerCase();
  const name = row.name ?? '';
  if (type === 'note') return 'note';
  if (type === 'hidden') return 'hidden';
  if (name.startsWith('__')) return 'hidden-output';
  if (name.startsWith('r_')) return 'summary';
  const appearance = (row.extras?.['appearance'] ?? '').toLowerCase();
  if (/\bhidden\b/.test(appearance)) return 'hidden';
  // A calculate is NOT technical by default: the harvest calculate that
  // re-exports `../inputs/contact/sex` is the sanctioned way to reach a
  // contact value from a rule (condition-builder Slice 1), and the inputs
  // block itself is withheld upstream by `earlierFields`.
  return null;
}

/**
 * Metadata for every named, non-structural row, in sheet order. Rows with
 * no name are skipped; duplicate names are all listed (the caller decides
 * what is pickable — `earlierFields` in FormEditor already withholds
 * ambiguous names and the inputs block).
 */
export function buildFieldMeta(
  survey: readonly SurveyRow[],
  labelLocales: readonly string[],
): FieldMeta[] {
  const out: FieldMeta[] = [];
  const stack: Array<{ name: string; label: string }> = [];
  for (const row of survey) {
    const k = structuralKind(row);
    if (k?.edge === 'begin') {
      stack.push({ name: row.name ?? '', label: resolveLabel(row.labels, labelLocales) });
      continue;
    }
    if (k?.edge === 'end') {
      stack.pop();
      continue;
    }
    if (isStructural(row) || !row.name) continue;
    const reason = technicalReasonFor(row);
    const inner = stack[stack.length - 1];
    out.push({
      name: row.name,
      rowId: row.rowId,
      type: row.type,
      kind: inferFieldKind(row.type),
      label: resolveLabel(row.labels, labelLocales),
      section: inner ? inner.label || inner.name : '',
      sectionPath: stack.map((g) => g.name),
      technical: reason !== null,
      ...(reason !== null ? { technicalReason: reason } : {}),
    });
  }
  return out;
}

/**
 * Case-insensitive match of every whitespace-separated term in `query`
 * against the label or the name. An empty query matches everything.
 */
export function fieldMatchesQuery(meta: Pick<FieldMeta, 'name' | 'label'>, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const name = meta.name.toLowerCase();
  const label = meta.label.toLowerCase();
  return terms.every((t) => name.includes(t) || label.includes(t));
}
