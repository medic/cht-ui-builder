/**
 * One field picker for every place a rule picks a field — T9c (#16),
 * docs/plans/9_complex_logic_calculation_relevant_constraint.
 *
 * What it fixes: the "show this question when" dropdown listed about 230
 * rows of a real pregnancy form by name in sheet order, every `*_note`,
 * `r_*` summary row, `__*` hidden output and plumbing calculate included,
 * with no search, no labels and no grouping (UX review finding 2, P0).
 *
 * Shape:
 *   [search ▭] [select ▾] [☐ show technical rows]
 *
 * - The `<select>` stays native and keeps the `ref-chip-select` class, so
 *   keyboard behaviour, form semantics and every existing e2e `selectOption`
 *   keep working. Its options read "Label (name)", grouped by section.
 * - Typing in the search box narrows the options by label OR name and turns
 *   the select into a visible list (`size`), so matches appear on the first
 *   keystroke and one click picks. Picking clears the search.
 * - Technical rows (notes, `r_*`, `__*`, hidden, plumbing calculates) are
 *   withheld until "show technical rows" is ticked. The current value is
 *   always offered, whatever it is, so a saved selection is never stranded.
 * - `options` is the list of NAMES the caller allows, in its order. The
 *   caller already enforces dependency-aware ordering (`earlierFields`), so
 *   this component never adds a field the caller did not offer.
 *
 * Metadata (label, section, technical) comes from `FieldMetaContext`,
 * provided once per form by `FormEditor`; a call site outside a provider
 * degrades to a plain name list.
 */
import {
  createContext,
  useCallback,
  useContext,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  buildFieldMeta,
  fieldMatchesQuery,
  type FieldMeta,
  type XLSForm,
} from '@cht-ui/shared';
import './SurveyFieldPicker.css';

export const FieldMetaContext = createContext<ReadonlyMap<string, FieldMeta>>(new Map());

/** Provide picker metadata for a whole form. Cheap: one pass per form change. */
export function FieldMetaProvider(props: { form: XLSForm; children: ReactNode }) {
  const map = useMemo(() => {
    const m = new Map<string, FieldMeta>();
    for (const meta of buildFieldMeta(props.form.survey, props.form.surveyHeaders.labelLocales)) {
      // First occurrence wins; duplicate names are withheld upstream anyway.
      if (!m.has(meta.name)) m.set(meta.name, meta);
    }
    return m;
  }, [props.form.survey, props.form.surveyHeaders.labelLocales]);
  return <FieldMetaContext.Provider value={map}>{props.children}</FieldMetaContext.Provider>;
}

export function useFieldMeta(): ReadonlyMap<string, FieldMeta> {
  return useContext(FieldMetaContext);
}

const LABEL_MAX = 48;

/** "Label (name)" for an option row; name alone when there is no label. */
export function fieldOptionText(name: string, meta: FieldMeta | undefined): string {
  const label = meta?.label ?? '';
  if (!label) return name;
  const short = label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 1)}…` : label;
  return `${short} (${name})`;
}

export interface SurveyFieldPickerProps {
  value: string;
  onChange: (name: string) => void;
  /** Field names the caller allows, in dependency order. */
  options: readonly string[];
  /** Ordering hint: fields typical for the current check come first within a section. */
  typicalFor?: (name: string) => boolean;
  disabled?: boolean;
  /** Text of the empty option. Omit it to render no empty option. */
  placeholder?: string;
  title?: string;
  ariaLabel?: string;
  /** Extra class on the wrapping span. */
  className?: string;
}

interface Section {
  label: string;
  names: string[];
}

export function SurveyFieldPicker(props: SurveyFieldPickerProps) {
  const metaMap = useFieldMeta();
  const [query, setQuery] = useState('');
  const [showTechnical, setShowTechnical] = useState(false);
  const searchId = useId();

  const anyTechnical = useMemo(
    () => props.options.some((n) => metaMap.get(n)?.technical),
    [props.options, metaMap],
  );

  const matches = useCallback(
    (n: string): boolean => {
      const meta = metaMap.get(n);
      if (meta?.technical && !showTechnical) return false;
      return fieldMatchesQuery(meta ?? { name: n, label: '' }, query);
    },
    [metaMap, showTechnical, query],
  );
  // Matches of the query itself; the current value is kept in the list
  // regardless, but it does not count as a hit for "no field matches".
  const queryHits = useMemo(() => props.options.filter(matches).length, [props.options, matches]);

  const sections = useMemo<Section[]>(() => {
    const visible = props.options.filter((n) => n === props.value || matches(n));
    // Stable partition by section, preserving the caller's (dependency) order
    // inside each section; typical-for-this-check fields first within it.
    const order: string[] = [];
    const bySection = new Map<string, string[]>();
    for (const n of visible) {
      const sec = metaMap.get(n)?.section ?? '';
      if (!bySection.has(sec)) {
        bySection.set(sec, []);
        order.push(sec);
      }
      bySection.get(sec)!.push(n);
    }
    return order.map((sec) => {
      let names = bySection.get(sec)!;
      if (props.typicalFor) {
        const typical = names.filter((n) => props.typicalFor!(n) || n === props.value);
        const other = names.filter((n) => !typical.includes(n));
        names = [...typical, ...other];
      }
      return { label: sec, names };
    });
  }, [props.options, props.value, props.typicalFor, metaMap, matches]);

  const matchCount = sections.reduce((n, s) => n + s.names.length, 0);
  const listMode = query.trim() !== '';
  // One row per option plus one per optgroup header, capped so the list
  // never swallows the page; a single empty row when nothing matches.
  const listSize = listMode ? Math.max(2, Math.min(8, matchCount + sections.length + 1)) : undefined;

  function pick(name: string): void {
    props.onChange(name);
    if (listMode) setQuery('');
  }

  const grouped = sections.length > 1 || (sections.length === 1 && sections[0]!.label !== '');

  return (
    <span className={`field-picker${props.className ? ` ${props.className}` : ''}`}>
      <input
        id={searchId}
        type="search"
        className="field-picker-search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setQuery('');
          if (e.key === 'Enter' && listMode && queryHits === 1) {
            e.preventDefault();
            const sole = props.options.find(matches);
            if (sole) pick(sole);
          }
        }}
        placeholder="search fields…"
        aria-label="Search fields"
        title="Type part of a label or a name to narrow the list"
        disabled={props.disabled}
      />
      <select
        className="ref-chip-select field-picker-select"
        value={props.value}
        onChange={(e) => pick(e.target.value)}
        title={props.title ?? 'Pick a field'}
        aria-label={props.ariaLabel}
        disabled={props.disabled}
        size={listSize}
      >
        {props.placeholder !== undefined && <option value="">{props.placeholder}</option>}
        {listMode && queryHits === 0 && (
          <option value="" disabled>
            no field matches “{query}”
          </option>
        )}
        {grouped
          ? sections.map((s) => (
              <optgroup key={s.label || '\u0000top'} label={s.label || 'Top level'}>
                {s.names.map((n) => (
                  <option key={n} value={n}>
                    {fieldOptionText(n, metaMap.get(n))}
                  </option>
                ))}
              </optgroup>
            ))
          : sections.flatMap((s) =>
              s.names.map((n) => (
                <option key={n} value={n}>
                  {fieldOptionText(n, metaMap.get(n))}
                </option>
              )),
            )}
      </select>
      {anyTechnical && (
        <label
          className="muted field-picker-technical"
          title="Notes, r_* summary rows, __* hidden outputs and plumbing calculates are hidden until you tick this"
        >
          <input
            type="checkbox"
            checked={showTechnical}
            onChange={(e) => setShowTechnical(e.target.checked)}
            disabled={props.disabled}
          />
          show technical rows
        </label>
      )}
    </span>
  );
}
