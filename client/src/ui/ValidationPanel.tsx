/**
 * The Validation panel — T9e (#18), docs/plans/9_complex_logic_calculation_relevant_constraint.
 *
 * One place for "accept the answer only if…": a list of presets per
 * question kind (Between 0 and 20, At most 100 characters, Not in the
 * future, "[None] must be chosen alone", …), each a sentence with inputs,
 * plus the error message per visible language and, in the row editor, the
 * required checkbox with its own message. It replaces both the inline
 * strip and the "✎ build" modal for the `constraint` column, and fills the
 * configure step's Validation slot in the add-question picker (9d).
 *
 * Opening an existing rule: each rule the parser understands shows as a
 * preset; anything else shows as a plain-text item. Nothing is ever
 * rewritten by just opening it — see `shared/src/validation/presets.ts`
 * (`source` wins on save while the preset is unchanged). An item the
 * author edits is written in the canonical spelling; the others keep theirs.
 *
 * State: the panel re-parses `value` whenever it changes from outside and
 * keeps its own copy only so an item that is not yet complete (a Between
 * with one box empty) can exist on screen without writing a broken
 * expression to the cell. Only complete items reach `onChange`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  parseValidation,
  presetComplete,
  presetsFor,
  questionKindOf,
  serializeValidation,
  suggestMessage,
  type Operator,
  type Preset,
  type QuestionKind,
  type ReportFieldChoice,
  type Script,
  type ValidationItem,
} from '@cht-ui/shared';
import './ValidationPanel.css';

export interface ValidationPanelProps {
  /** Raw XLSForm `type` cell of the question (`integer`, `select_multiple x`, …). */
  questionType: string;
  /** The `constraint` cell. */
  value: string;
  onChange: (next: string) => void;
  /** Visible languages, in sheet order. */
  locales: string[];
  /** `constraint_message::<loc>` values. */
  messages: Record<string, string>;
  onMessageChange: (locale: string, value: string) => void;
  /**
   * Write several cells in ONE update: `{ constraint, 'constraint_message::en' }`
   * when a preset edit also suggests a message. Two separate updates in the
   * same tick would each start from the same stale row and the second would
   * overwrite the first. Optional; without it the two callbacks are used.
   */
  onBatch?: (changes: Record<string, string>) => void;
  /** Row editor only: the required checkbox and `required_message::<loc>`. */
  required?: boolean;
  onRequiredChange?: (next: boolean) => void;
  requiredMessages?: Record<string, string>;
  onRequiredMessageChange?: (locale: string, value: string) => void;
  /** Fields a preset may compare against, dependency-ordered. */
  fieldOptions: string[];
  /** Display label for a field name (defaults to the name). */
  fieldLabel?: (name: string) => string;
  /** The question's own choices, for "[choice] must be chosen alone". */
  choices?: ReportFieldChoice[];
  /** Compact layout for the picker's configure step. */
  compact?: boolean;
}

const OP_LABEL: Record<Operator, string> = {
  '=': 'exactly',
  '!=': 'not',
  '<': 'less than',
  '<=': 'at most',
  '>': 'more than',
  '>=': 'at least',
};

/** The menu label for a catalogue entry (an empty preset of that shape). */
function menuLabel(p: Preset, kind: QuestionKind): string {
  switch (p.kind) {
    case 'between':
      return 'Between two values';
    case 'compare-value':
      if (p.op === '=') return kind === 'text' || kind === 'select_one' ? 'Equals a fixed text' : 'Equals a fixed value';
      return p.op === '<' ? 'Less than a value' : p.op === '>' ? 'Greater than a value' : `${OP_LABEL[p.op]} a value`;
    case 'compare-field':
      if (kind === 'date' || kind === 'datetime') return 'On or after another date';
      return p.op === '<=' ? 'At most another answer' : 'At least another answer';
    case 'compare-today':
      return p.op === '<=' ? 'Not in the future' : 'Not in the past';
    case 'days-from-today':
      return p.direction === 'ago' ? 'Within the last N days' : 'Within the next N days';
    case 'months-from-today':
      return 'Months from today';
    case 'after-all-of':
      return 'After all of several dates';
    case 'text-length':
      return p.op === '<=' ? 'At most N characters' : p.op === '>=' ? 'At least N characters' : 'Exactly N characters';
    case 'allowed-chars':
      return p.mode === 'letters' ? 'Letters only' : p.mode === 'digits' ? 'Digits only' : 'No digits';
    case 'pattern':
      return 'Matches a pattern';
    case 'int-value':
      return 'As a number, compared to a value';
    case 'bs-year':
      return p.bound === 'max-this-year' ? 'Year (B.S.) not after this year' : 'Year (B.S.) at most N years ago';
    case 'choice-alone':
      return 'A choice must be chosen alone';
    case 'count-selected':
      return p.op === '<=' ? 'Choose at most N' : 'Choose at least N';
    case 'always-true':
      return 'Always passes';
    case 'code':
      return 'Plain expression';
  }
}

function scriptsForLocales(locales: string[]): Script[] {
  const out: Script[] = ['latin'];
  if (locales.some((l) => /^(ne|hi|mr|sa)\b/i.test(l))) out.push('devanagari');
  return out;
}

export function ValidationPanel(props: ValidationPanelProps) {
  const kind = questionKindOf(props.questionType);
  const fieldLabel = props.fieldLabel ?? ((n: string) => n);

  // Local items so an incomplete preset can sit on screen; `lastEmitted`
  // tells an external change (undo, raw edit) apart from our own echo.
  const [items, setItems] = useState<ValidationItem[]>(() => parseValidation(props.value).items);
  const [separators, setSeparators] = useState<string[] | undefined>(
    () => parseValidation(props.value).separators,
  );
  const lastEmitted = useRef<string>(props.value.trim());
  useEffect(() => {
    if (props.value.trim() === lastEmitted.current) return;
    const parsed = parseValidation(props.value);
    setItems(parsed.items);
    setSeparators(parsed.separators);
    lastEmitted.current = props.value.trim();
  }, [props.value]);

  const [showCode, setShowCode] = useState(false);
  const [lastSuggestion, setLastSuggestion] = useState<string>('');

  function commit(next: ValidationItem[], nextSeparators: string[] | undefined): void {
    setItems(next);
    setSeparators(nextSeparators);
    const complete = next.filter((i) => presetComplete(i.preset));
    const text = serializeValidation(
      complete,
      complete.length === next.length ? nextSeparators : undefined,
    );
    lastEmitted.current = text.trim();
    // Suggest a message from the first preset while the author has not
    // written their own (empty, or still the previous suggestion).
    const first = complete[0]?.preset;
    const primary = props.locales[0];
    let suggested: string | null = null;
    if (first && primary !== undefined) {
      const suggestion = suggestMessage(first, fieldLabel);
      const current = props.messages[primary] ?? '';
      if (suggestion && (current === '' || current === lastSuggestion)) {
        suggested = suggestion;
        setLastSuggestion(suggestion);
      }
    }
    if (suggested !== null && primary !== undefined && props.onBatch) {
      props.onBatch({ constraint: text, [`constraint_message::${primary}`]: suggested });
      return;
    }
    props.onChange(text);
    if (suggested !== null && primary !== undefined) props.onMessageChange(primary, suggested);
  }

  function updateItem(idx: number, preset: Preset): void {
    // An edited item drops its `source`: it is re-emitted canonically.
    commit(
      items.map((it, i) => (i === idx ? { preset } : it)),
      separators,
    );
  }

  function removeItem(idx: number): void {
    const next = items.filter((_, i) => i !== idx);
    commit(next, undefined);
  }

  function addPreset(p: Preset): void {
    const seeded: Preset =
      p.kind === 'allowed-chars' && p.mode === 'letters'
        ? { ...p, scripts: scriptsForLocales(props.locales) }
        : p.kind === 'compare-field' && props.fieldOptions.length > 0
          ? { ...p, field: { name: props.fieldOptions[props.fieldOptions.length - 1]!, spelling: 'braces' } }
          : p.kind === 'choice-alone' && props.choices && props.choices.length > 0
            ? { ...p, choice: props.choices[0]!.name }
            : p;
    commit([...items, { preset: seeded }], undefined);
  }

  const catalogue = useMemo(() => presetsFor(kind), [kind]);
  const code = serializeValidation(
    items.filter((i) => presetComplete(i.preset)),
    items.every((i) => presetComplete(i.preset)) ? separators : undefined,
  );
  const hasRule = items.length > 0;
  const onlyPlaceholder = items.length === 1 && items[0]!.preset.kind === 'always-true';

  return (
    <div className={`validation-panel${props.compact ? ' compact' : ''}`} data-testid="validation-panel">
      <div className="row gap validation-head">
        <strong>Validation</strong>
        <span className="muted small">— accept the answer only if…</span>
        <code className="raw-col-tag" title="Raw XLSForm column">constraint</code>
        {hasRule && (
          <button
            type="button"
            className="link small"
            onClick={() => setShowCode((v) => !v)}
            style={{ marginLeft: 'auto' }}
          >
            {showCode ? 'hide code' : 'code'}
          </button>
        )}
      </div>

      {onlyPlaceholder && (
        <p className="muted small validation-note" role="note">
          This rule always passes: no validation. Remove it to add a real rule.
        </p>
      )}

      <ol className="validation-items">
        {items.map((item, idx) => (
          <li key={idx} className="validation-item">
            <PresetRow
              preset={item.preset}
              kind={kind}
              locales={props.locales}
              fieldOptions={props.fieldOptions}
              fieldLabel={fieldLabel}
              choices={props.choices ?? []}
              onChange={(p) => updateItem(idx, p)}
            />
            {!presetComplete(item.preset) && (
              <span className="muted small validation-incomplete">fill in to apply</span>
            )}
            <button
              type="button"
              className="link danger"
              onClick={() => removeItem(idx)}
              aria-label="Remove rule"
              title="Remove this rule"
            >
              ×
            </button>
          </li>
        ))}
      </ol>

      <div className="row gap" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <label className="row gap" style={{ alignItems: 'center' }}>
          <span className="muted small">{hasRule ? '+ and also' : '+ Add rule'}</span>
          <select
            className="ref-chip-select"
            value=""
            aria-label="Add a validation rule"
            onChange={(e) => {
              const i = Number(e.target.value);
              if (Number.isNaN(i)) return;
              if (catalogue[i]) addPreset(catalogue[i]!);
              else if (i === catalogue.length) addPreset({ kind: 'code', text: '' });
              e.target.value = '';
            }}
          >
            <option value="">— pick a rule —</option>
            {catalogue.map((p, i) => (
              <option key={i} value={i}>
                {menuLabel(p, kind)}
              </option>
            ))}
            <option value={catalogue.length}>Plain expression (XPath)</option>
          </select>
        </label>
        {showCode && hasRule && (
          <code className="cond-preview" aria-label="Constraint expression">
            {code || '(incomplete)'}
          </code>
        )}
      </div>

      {hasRule && !onlyPlaceholder && (
        <div className="validation-messages">
          {props.locales.map((loc) => (
            <label key={loc} className="qtype-locale-label">
              <span className="locale-tag">constraint_message::{loc}</span>
              <input
                value={props.messages[loc] ?? ''}
                onChange={(e) => props.onMessageChange(loc, e.target.value)}
                placeholder={
                  loc === props.locales[0]
                    ? 'Message shown when the answer is rejected'
                    : `Message in ${loc}`
                }
                autoComplete="off"
              />
            </label>
          ))}
        </div>
      )}

      {props.onRequiredChange && (
        <div className="validation-required">
          <label className="row gap" style={{ alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={Boolean(props.required)}
              onChange={(e) => props.onRequiredChange?.(e.target.checked)}
            />
            Required — the form cannot be submitted without an answer
          </label>
          {props.required &&
            props.locales.map((loc) => (
              <label key={loc} className="qtype-locale-label">
                <span className="locale-tag">required_message::{loc}</span>
                <input
                  value={props.requiredMessages?.[loc] ?? ''}
                  onChange={(e) => props.onRequiredMessageChange?.(loc, e.target.value)}
                  placeholder={
                    loc === props.locales[0]
                      ? 'Message shown when the answer is missing (optional)'
                      : `Message in ${loc}`
                  }
                  autoComplete="off"
                />
              </label>
            ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/*                              One preset row                               */
/* ------------------------------------------------------------------------ */

function PresetRow(props: {
  preset: Preset;
  kind: QuestionKind;
  locales: string[];
  fieldOptions: string[];
  fieldLabel: (name: string) => string;
  choices: ReportFieldChoice[];
  onChange: (p: Preset) => void;
}) {
  const p = props.preset;
  const numeric = props.kind === 'integer' || props.kind === 'decimal';
  const step = props.kind === 'integer' ? 1 : 'any';
  const isDate = props.kind === 'date' || props.kind === 'datetime';

  const num = (value: string, onChange: (v: string) => void, label: string) => (
    <input
      type={numeric ? 'number' : 'text'}
      step={numeric ? step : undefined}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
      className="validation-value"
    />
  );

  const fieldSelect = (name: string, onChange: (n: string) => void, label: string) => (
    <select
      className="ref-chip-select"
      value={props.fieldOptions.includes(name) ? name : ''}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
    >
      <option value="">— question —</option>
      {props.fieldOptions.map((n) => (
        <option key={n} value={n}>
          {props.fieldLabel(n) === n ? n : `${props.fieldLabel(n)} (${n})`}
        </option>
      ))}
    </select>
  );

  switch (p.kind) {
    case 'between':
      return (
        <span className="validation-sentence">
          Between {num(p.min.value, (v) => props.onChange({ ...p, min: { ...p.min, value: v } }), 'Minimum')}
          <select
            className="ref-chip-select"
            value={p.min.inclusive ? 'incl' : 'excl'}
            onChange={(e) => props.onChange({ ...p, min: { ...p.min, inclusive: e.target.value === 'incl' } })}
            aria-label="Minimum included"
          >
            <option value="incl">included</option>
            <option value="excl">excluded</option>
          </select>
          and {num(p.max.value, (v) => props.onChange({ ...p, max: { ...p.max, value: v } }), 'Maximum')}
          <select
            className="ref-chip-select"
            value={p.max.inclusive ? 'incl' : 'excl'}
            onChange={(e) => props.onChange({ ...p, max: { ...p.max, inclusive: e.target.value === 'incl' } })}
            aria-label="Maximum included"
          >
            <option value="incl">included</option>
            <option value="excl">excluded</option>
          </select>
        </span>
      );
    case 'compare-value':
      return (
        <span className="validation-sentence">
          Is
          <select
            className="ref-chip-select"
            value={p.op}
            onChange={(e) => props.onChange({ ...p, op: e.target.value as Operator })}
            aria-label="Comparison"
          >
            {(['=', '!=', '<', '<=', '>', '>='] as Operator[]).map((op) => (
              <option key={op} value={op}>
                {OP_LABEL[op]}
              </option>
            ))}
          </select>
          {p.isString ? (
            <input
              value={p.value}
              onChange={(e) => props.onChange({ ...p, value: e.target.value })}
              aria-label="Text value"
              className="validation-value"
            />
          ) : (
            num(p.value, (v) => props.onChange({ ...p, value: v }), 'Value')
          )}
        </span>
      );
    case 'compare-field':
      return (
        <span className="validation-sentence">
          Is
          <select
            className="ref-chip-select"
            value={p.op}
            onChange={(e) => props.onChange({ ...p, op: e.target.value as Operator })}
            aria-label="Comparison"
          >
            {isDate ? (
              <>
                <option value=">=">on or after</option>
                <option value=">">after</option>
                <option value="<=">on or before</option>
                <option value="<">before</option>
                <option value="=">the same as</option>
              </>
            ) : (
              (['<=', '<', '>=', '>', '=', '!='] as Operator[]).map((op) => (
                <option key={op} value={op}>
                  {OP_LABEL[op]}
                </option>
              ))
            )}
          </select>
          {fieldSelect(p.field.name, (n) => props.onChange({ ...p, field: { ...p.field, name: n } }), 'Other question')}
        </span>
      );
    case 'compare-today':
      return (
        <span className="validation-sentence">
          <select
            className="ref-chip-select"
            value={p.op}
            onChange={(e) => props.onChange({ ...p, op: e.target.value as Operator })}
            aria-label="Relative to today"
          >
            <option value="<=">Not in the future</option>
            <option value=">=">Not in the past</option>
            <option value="<">Before today</option>
            <option value=">">After today</option>
          </select>
          <span className="muted small">({p.clock}())</span>
        </span>
      );
    case 'days-from-today':
      return (
        <span className="validation-sentence">
          <select
            className="ref-chip-select"
            value={`${p.op}|${p.direction}`}
            onChange={(e) => {
              const [op, direction] = e.target.value.split('|') as [Operator, 'ago' | 'ahead'];
              props.onChange({ ...p, op, direction });
            }}
            aria-label="Window"
          >
            <option value=">=|ago">Within the last</option>
            <option value="<=|ahead">Within the next</option>
            <option value="<=|ago">At least … ago</option>
            <option value=">=|ahead">At least … ahead</option>
          </select>
          {num(p.days, (v) => props.onChange({ ...p, days: v }), 'Days')} days
        </span>
      );
    case 'months-from-today':
      return (
        <span className="validation-sentence">
          Months from today
          <select
            className="ref-chip-select"
            value={p.op}
            onChange={(e) => props.onChange({ ...p, op: e.target.value as Operator })}
            aria-label="Comparison"
          >
            {(['<', '<=', '>', '>=', '='] as Operator[]).map((op) => (
              <option key={op} value={op}>
                {OP_LABEL[op]}
              </option>
            ))}
          </select>
          {num(p.months, (v) => props.onChange({ ...p, months: v }), 'Months')}
        </span>
      );
    case 'after-all-of':
      return (
        <span className="validation-sentence">
          <select
            className="ref-chip-select"
            value={p.op}
            onChange={(e) => props.onChange({ ...p, op: e.target.value as Operator })}
            aria-label="Comparison"
          >
            <option value=">">After all of</option>
            <option value=">=">On or after all of</option>
          </select>
          {p.fields.map((f, i) => (
            <span key={i} className="row gap" style={{ alignItems: 'center' }}>
              {fieldSelect(
                f.name,
                (n) => props.onChange({ ...p, fields: p.fields.map((g, j) => (j === i ? { ...g, name: n } : g)) }),
                `Date ${i + 1}`,
              )}
              <button
                type="button"
                className="link danger small"
                onClick={() => props.onChange({ ...p, fields: p.fields.filter((_, j) => j !== i) })}
                aria-label={`Remove date ${i + 1}`}
              >
                ×
              </button>
            </span>
          ))}
          <button
            type="button"
            className="link small"
            onClick={() => props.onChange({ ...p, fields: [...p.fields, { name: '', spelling: 'braces' }] })}
          >
            + date
          </button>
        </span>
      );
    case 'text-length':
      return (
        <span className="validation-sentence">
          <select
            className="ref-chip-select"
            value={p.op}
            onChange={(e) => props.onChange({ ...p, op: e.target.value as Operator })}
            aria-label="Length comparison"
          >
            <option value="<=">At most</option>
            <option value=">=">At least</option>
            <option value="=">Exactly</option>
            <option value="<">Fewer than</option>
            <option value=">">More than</option>
          </select>
          <input
            type="number"
            step={1}
            min={0}
            value={p.n}
            onChange={(e) => props.onChange({ ...p, n: e.target.value })}
            aria-label="Characters"
            className="validation-value"
          />{' '}
          characters
        </span>
      );
    case 'allowed-chars':
      return (
        <span className="validation-sentence">
          Allowed characters:
          <select
            className="ref-chip-select"
            value={p.mode}
            onChange={(e) => {
              const mode = e.target.value as typeof p.mode;
              props.onChange({ ...p, mode, scripts: mode === 'letters' ? (p.scripts.length ? p.scripts : scriptsForLocales(props.locales)) : [] });
            }}
            aria-label="Allowed characters"
          >
            <option value="letters">letters only</option>
            <option value="digits">digits only</option>
            <option value="no-digits">no digits</option>
          </select>
          {p.mode === 'letters' &&
            (['latin', 'devanagari'] as Script[]).map((s) => (
              <label key={s} className="row gap small" style={{ alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={p.scripts.includes(s)}
                  onChange={(e) =>
                    props.onChange({
                      ...p,
                      scripts: e.target.checked
                        ? [...p.scripts.filter((x) => x !== s), s].sort()
                        : p.scripts.filter((x) => x !== s),
                    })
                  }
                />
                {s === 'latin' ? 'English (a–z)' : 'Nepali (Devanagari)'}
              </label>
            ))}
        </span>
      );
    case 'pattern':
      return <PatternRow pattern={p.pattern} onChange={(pattern) => props.onChange({ ...p, pattern })} />;
    case 'int-value':
      return (
        <span className="validation-sentence">
          As a number, is
          <select
            className="ref-chip-select"
            value={p.op}
            onChange={(e) => props.onChange({ ...p, op: e.target.value as Operator })}
            aria-label="Comparison"
          >
            {(['>=', '>', '<=', '<', '=', '!='] as Operator[]).map((op) => (
              <option key={op} value={op}>
                {OP_LABEL[op]}
              </option>
            ))}
          </select>
          <input
            type="number"
            value={p.value}
            onChange={(e) => props.onChange({ ...p, value: e.target.value })}
            aria-label="Value"
            className="validation-value"
          />
        </span>
      );
    case 'bs-year':
      return (
        <span className="validation-sentence">
          Year (B.S.)
          <select
            className="ref-chip-select"
            value={p.bound}
            onChange={(e) => props.onChange({ ...p, bound: e.target.value as typeof p.bound })}
            aria-label="Year bound"
          >
            <option value="max-this-year">not after this year</option>
            <option value="min-years-ago">at most … years ago</option>
            <option value="max-years-ago">at least … years ago</option>
          </select>
          {p.bound !== 'max-this-year' && (
            <>
              <input
                type="number"
                min={0}
                value={p.years ?? ''}
                onChange={(e) => props.onChange({ ...p, years: e.target.value })}
                aria-label="Years"
                className="validation-value"
              />{' '}
              years
            </>
          )}
        </span>
      );
    case 'choice-alone':
      return (
        <span className="validation-sentence">
          <select
            className="ref-chip-select"
            value={props.choices.some((c) => c.name === p.choice) ? p.choice : '__custom__'}
            onChange={(e) => {
              if (e.target.value !== '__custom__') props.onChange({ ...p, choice: e.target.value });
            }}
            aria-label="Choice"
          >
            {props.choices.map((c) => (
              <option key={c.name} value={c.name}>
                {c.label === c.name ? c.name : `${c.label} (${c.name})`}
              </option>
            ))}
            <option value="__custom__">— other —</option>
          </select>
          {!props.choices.some((c) => c.name === p.choice) && (
            <input
              value={p.choice}
              onChange={(e) => props.onChange({ ...p, choice: e.target.value })}
              aria-label="Choice name"
              className="validation-value"
              placeholder="choice name"
            />
          )}
          must be chosen alone
        </span>
      );
    case 'count-selected':
      return (
        <span className="validation-sentence">
          Choose
          <select
            className="ref-chip-select"
            value={p.op}
            onChange={(e) => props.onChange({ ...p, op: e.target.value as Operator })}
            aria-label="Count comparison"
          >
            <option value="<=">at most</option>
            <option value=">=">at least</option>
            <option value="=">exactly</option>
            <option value="<">fewer than</option>
            <option value=">">more than</option>
          </select>
          <input
            value={p.value}
            onChange={(e) => props.onChange({ ...p, value: e.target.value })}
            aria-label="Count"
            className="validation-value"
            placeholder="N or ${question}"
          />
        </span>
      );
    case 'always-true':
      return (
        <span className="validation-sentence muted">
          Always passes <code>{p.text}</code>
        </span>
      );
    case 'code':
      return (
        <span className="validation-sentence">
          <input
            value={p.text}
            onChange={(e) => props.onChange({ ...p, text: e.target.value })}
            aria-label="Expression"
            className="raw-rule-input"
            spellCheck={false}
            placeholder="XPath expression, e.g. . >= 0"
          />
        </span>
      );
  }
}

function PatternRow(props: { pattern: string; onChange: (pattern: string) => void }) {
  const [sample, setSample] = useState('');
  let verdict: 'match' | 'no-match' | 'invalid' | null = null;
  if (props.pattern && sample !== '') {
    try {
      verdict = new RegExp(props.pattern).test(sample) ? 'match' : 'no-match';
    } catch {
      verdict = 'invalid';
    }
  }
  return (
    <span className="validation-sentence">
      Matches the pattern
      <input
        value={props.pattern}
        onChange={(e) => props.onChange(e.target.value)}
        aria-label="Pattern"
        className="validation-value"
        spellCheck={false}
        placeholder="^9[78][0-9]{8}$"
      />
      <input
        value={sample}
        onChange={(e) => setSample(e.target.value)}
        aria-label="Try a value"
        className="validation-value"
        placeholder="try a value…"
      />
      {verdict && (
        <span className={`small ${verdict === 'match' ? 'ok' : 'muted'}`}>
          {verdict === 'match' ? '✓ accepted' : verdict === 'no-match' ? '✗ rejected' : 'invalid pattern'}
        </span>
      )}
    </span>
  );
}
