/**
 * Visual rule builder for a form's properties.json `context.expression`.
 *
 * Lets non-developers say "person, male, age 18-65, summary.X is true,
 * not muted, not deceased" via dropdowns. Raw text fallback for
 * expressions outside the supported grammar.
 */
import { useEffect, useState } from 'react';
import {
  parseContextExpression,
  serializeContextExpression,
  type ContextRule,
  type ParsedContextExpression,
} from '@cht-ui/shared';
import {
  FieldPicker,
  isNumericOp,
  isValidNumberLiteral,
  type ContactFormFields,
} from './FieldPicker.js';

/**
 * A contact type as known to the project's hierarchy. Threaded down from
 * FormEditor → PropertiesEditor → ContextExpressionBuilder so the
 * "Contact type is" dropdown reflects the project's actual types instead
 * of the legacy hardcoded four. `displayName` is the friendly
 * place-types-display label when available; falls back to the id.
 */
export interface ContextContactType {
  id: string;
  person?: boolean;
  displayName?: string;
}

interface Props {
  value: string;
  onChange: (next: string) => void;
  /** Known summary flag names (from contact-summary.templated.js) for the picker. */
  summaryFlags?: string[];
  /** Optional contact forms whose fields populate the `contact_field` picker. */
  contactForms?: ContactFormFields[];
  /** Project's parsed `contact_types` from base_settings.json. When provided,
   *  the "Contact type is" dropdown lists the real types and any new rule
   *  emits `contact.contact_type === '<id>'` (the configurable-hierarchy form).
   *  When omitted/empty the builder falls back to the legacy `contact.type`
   *  shape so older configs still work. See
   *  `docs/handoff-form-context-types-2026-06-28.md`. */
  contactTypes?: ContextContactType[];
  /** Whether "Available on people" is currently checked in the parent
   *  PropertiesEditor — narrows the type dropdown to person types only. */
  contextPerson?: boolean;
  /** Whether "Available on places" is currently checked — narrows the
   *  dropdown to place types only when set without `contextPerson`. */
  contextPlace?: boolean;
  disabled?: boolean;
}

/** The CHT's hardcoded contact types: documents of these types carry `type`, not `contact_type`. */
const LEGACY_TYPE_IDS = new Set(['district_hospital', 'health_center', 'clinic', 'person']);

export function ContextExpressionBuilder({
  value,
  onChange,
  summaryFlags = [],
  contactForms = [],
  contactTypes = [],
  contextPerson,
  contextPlace,
  disabled,
}: Props) {
  const [parsed, setParsed] = useState<ParsedContextExpression>(() => parseContextExpression(value));
  const [showRaw, setShowRaw] = useState<boolean>(false);
  const [rawText, setRawText] = useState<string>(value);

  useEffect(() => {
    setParsed(parseContextExpression(value));
    setRawText(value);
  }, [value]);

  function patch(next: ParsedContextExpression) {
    setParsed(next);
    onChange(serializeContextExpression(next));
  }

  function updateRule(idx: number, r: ContextRule) {
    patch({ ...parsed, rules: parsed.rules.map((rule, i) => (i === idx ? r : rule)) });
  }
  function removeRule(idx: number) {
    patch({ ...parsed, rules: parsed.rules.filter((_, i) => i !== idx) });
  }
  function addRule(kind: ContextRule['kind']) {
    let r: ContextRule;
    switch (kind) {
      case 'contact_type': {
        // When the project ships parsed contact_types, emit the
        // configurable form (contact.contact_type === '<id>') by default —
        // that's the correct shape for every project the editor was
        // built for. Fall back to the legacy `person` literal only when
        // no types are known (open-without-hierarchy state).
        if (contactTypes.length > 0) {
          const filtered = filterContactTypesByContext(
            contactTypes,
            contextPerson,
            contextPlace,
          );
          const first = filtered[0] ?? contactTypes[0]!;
          // The CHT stores the four classic ids under `type` even when
          // contact_types declares them; only custom ids live under
          // `contact_type`. Emitting the wrong field makes the CHT refuse
          // the form ("not authorized") for every contact of that type.
          r = LEGACY_TYPE_IDS.has(first.id)
            ? { kind: 'contact_type', value: first.id }
            : { kind: 'contact_contact_type', value: first.id };
        } else {
          r = { kind: 'contact_type', value: 'person' };
        }
        break;
      }
      case 'contact_contact_type': {
        const filtered = filterContactTypesByContext(
          contactTypes,
          contextPerson,
          contextPlace,
        );
        const first = filtered[0] ?? contactTypes[0];
        r = { kind: 'contact_contact_type', value: first?.id ?? '' };
        break;
      }
      case 'contact_sex':
        r = { kind: 'contact_sex', value: 'male' };
        break;
      case 'contact_field':
        r = { kind: 'contact_field', field: 'role', op: '===', value: 'patient' };
        break;
      case 'age_years':
        r = { kind: 'age_years', op: '>=', value: '18' };
        break;
      case 'summary_flag':
        r = { kind: 'summary_flag', flag: summaryFlags[0] ?? 'show_form', negated: false };
        break;
      case 'not_muted':
        r = { kind: 'not_muted' };
        break;
      case 'not_deceased':
        r = { kind: 'not_deceased' };
        break;
      case 'raw':
        r = { kind: 'raw', text: '' };
        break;
      default:
        return;
    }
    // A bare `true` is the "always show" placeholder; the first real rule
    // replaces it rather than producing `true && …`.
    const base = parsed.rules.filter((x) => x.kind !== 'is_true');
    patch({ ...parsed, rules: [...base, r] });
  }

  if (disabled) {
    return <div className="muted">Task-only form: expression locked to <code>false</code>.</div>;
  }

  return (
    <div className="context-builder">
      <div className="row gap">
        <button className={!showRaw ? 'active' : 'link'} onClick={() => setShowRaw(false)}>
          Visual
        </button>
        <button className={showRaw ? 'active' : 'link'} onClick={() => setShowRaw(true)}>
          Raw JS
        </button>
        {parsed.hasRawFallback && !showRaw && (
          <span className="badge warn">
            Some clauses aren&apos;t recognized — they appear as &quot;raw&quot; rows.
          </span>
        )}
      </div>

      {!showRaw && (
        <>
          <p className="muted">
            Form shows when ALL conditions are met (AND-combined).
          </p>
          <div className="rule-list">
            {parsed.rules.map((rule, idx) => (
              <ContextRuleRow
                key={idx}
                rule={rule}
                summaryFlags={summaryFlags}
                contactForms={contactForms}
                contactTypes={contactTypes}
                contextPerson={contextPerson}
                contextPlace={contextPlace}
                onChange={(r) => updateRule(idx, r)}
                onRemove={() => removeRule(idx)}
              />
            ))}
            <div className="row gap toolbar">
              <button className="link" onClick={() => addRule('contact_type')}>+ contact type</button>
              <button className="link" onClick={() => addRule('contact_sex')}>+ sex</button>
              <button className="link" onClick={() => addRule('age_years')}>+ age</button>
              <button className="link" onClick={() => addRule('summary_flag')}>+ summary flag</button>
              <button className="link" onClick={() => addRule('contact_field')}>+ other contact field</button>
              <button className="link" onClick={() => addRule('not_muted')}>+ not muted</button>
              <button className="link" onClick={() => addRule('not_deceased')}>+ not deceased</button>
              <button className="link" onClick={() => addRule('raw')}>+ raw JS</button>
            </div>
          </div>
          <div className="preview">
            <code>{serializeContextExpression(parsed) || '(empty)'}</code>
          </div>
        </>
      )}

      {showRaw && (
        <textarea
          className="code-editor short"
          value={rawText}
          onChange={(e) => {
            setRawText(e.target.value);
            onChange(e.target.value);
          }}
          spellCheck={false}
        />
      )}
    </div>
  );
}

/** Hierarchy types the user can scope to, filtered by which gate they've
 *  ticked (Available on people / places). When neither / both are ticked,
 *  we list everything — the parent gates already cover the broad case. */
function filterContactTypesByContext(
  types: ContextContactType[],
  person?: boolean,
  place?: boolean,
): ContextContactType[] {
  if (person && !place) return types.filter((t) => t.person === true);
  if (place && !person) return types.filter((t) => t.person !== true);
  return types;
}

function ContextRuleRow(props: {
  rule: ContextRule;
  summaryFlags: string[];
  contactForms: ContactFormFields[];
  contactTypes: ContextContactType[];
  contextPerson?: boolean;
  contextPlace?: boolean;
  onChange: (r: ContextRule) => void;
  onRemove: () => void;
}) {
  const r = props.rule;
  const remove = <button className="link danger" onClick={props.onRemove}>×</button>;
  switch (r.kind) {
    case 'is_true':
      return <div className="row gap rule-row"><code>true</code> <span className="muted">(always show)</span> {remove}</div>;
    case 'is_false':
      return <div className="row gap rule-row"><code>false</code> <span className="muted">(never show)</span> {remove}</div>;

    case 'contact_type':
    case 'contact_contact_type': {
      // Both kinds share UI; the kind decides which JS shape we emit on
      // save. We use the `contact_contact_type` variant by default for
      // any new rule when project types are available (set by addRule).
      // Loaded existing rules keep their parsed kind so legacy configs
      // re-serialize byte-stable.
      const filtered = filterContactTypesByContext(
        props.contactTypes,
        props.contextPerson,
        props.contextPlace,
      );
      const persons = filtered.filter((t) => t.person === true);
      const places = filtered.filter((t) => t.person !== true);
      const knownIds = new Set(props.contactTypes.map((t) => t.id));
      const isLegacyShape = r.kind === 'contact_type';
      const isKnown = knownIds.has(r.value);
      return (
        <div className="row gap rule-row">
          <span>Contact type is</span>
          {props.contactTypes.length > 0 ? (
            <select
              value={isKnown ? r.value : '__custom__'}
              onChange={(e) => {
                if (e.target.value === '__custom__') return;
                // Picking a real project type promotes the rule to
                // `contact_contact_type` (correct for configurable
                // hierarchies). The legacy form is only kept verbatim
                // when an existing rule was parsed as such AND its
                // value was not changed via the dropdown.
                props.onChange({ kind: 'contact_contact_type', value: e.target.value });
              }}
            >
              {persons.length > 0 && (
                <optgroup label="Persons">
                  {persons.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.displayName ? `${t.displayName} (${t.id})` : t.id}
                    </option>
                  ))}
                </optgroup>
              )}
              {places.length > 0 && (
                <optgroup label="Places">
                  {places.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.displayName ? `${t.displayName} (${t.id})` : t.id}
                    </option>
                  ))}
                </optgroup>
              )}
              <option value="__custom__">— custom id —</option>
            </select>
          ) : (
            // No project types known — preserve the legacy hardcoded
            // dropdown so the editor still works against bare cht-default
            // imports that have no contact_types defined.
            <select value={r.value} onChange={(e) => props.onChange({ ...r, value: e.target.value })}>
              <option value="person">person</option>
              <option value="clinic">clinic / area</option>
              <option value="health_center">health center</option>
              <option value="district_hospital">district hospital</option>
            </select>
          )}
          {(!isKnown || props.contactTypes.length === 0) && (
            <input
              value={r.value}
              onChange={(e) => props.onChange({ ...r, value: e.target.value })}
              placeholder="contact type id"
            />
          )}
          {isLegacyShape && props.contactTypes.length > 0 && (
            <span
              className="muted small"
              title="Legacy contact.type === '...' form. Pick a project type from the dropdown to migrate to contact.contact_type ==="
            >
              <code>contact.type</code> (legacy)
            </span>
          )}
          {remove}
        </div>
      );
    }

    case 'contact_sex':
      return (
        <div className="row gap rule-row">
          <span>Sex is</span>
          <select value={r.value} onChange={(e) => props.onChange({ ...r, value: e.target.value })}>
            <option value="male">male</option>
            <option value="female">female</option>
            <option value="other">other</option>
          </select>
          {remove}
        </div>
      );

    case 'age_years': {
      // Mirror the contact_field pattern: hold the raw string, validate
      // separately. The prior `Number(e.target.value)` on keystroke coerced
      // `''` → `0`, so backspacing to clear the input snapped back to `0`
      // — every age condition was silently `age >= 0` until the user
      // noticed. Kept as `type="number"` for the on-screen numeric keypad
      // + spin controls; the browser will accept empty freely.
      const valueInvalid = r.value !== '' && !isValidNumberLiteral(r.value);
      const valueEmpty = r.value.trim() === '';
      return (
        <div className="rule-row-block">
          <div className="row gap rule-row">
            <span>Age in years</span>
            <select
              value={r.op}
              onChange={(e) =>
                props.onChange({
                  ...r,
                  op: e.target.value as '===' | '!==' | '>' | '<' | '>=' | '<=',
                })
              }
            >
              <option value=">=">≥</option>
              <option value="<=">≤</option>
              <option value=">">&gt;</option>
              <option value="<">&lt;</option>
              <option value="===">=</option>
              <option value="!==">≠</option>
            </select>
            <input
              type="number"
              value={r.value}
              onChange={(e) => props.onChange({ ...r, value: e.target.value })}
              onFocus={(e) => e.currentTarget.select()}
              placeholder="number"
              style={{ width: 80 }}
              className={valueInvalid ? 'invalid' : ''}
            />
            {remove}
          </div>
          {valueInvalid && (
            <div className="rule-row-warning">
              <strong>Not a number.</strong> Enter an age (e.g. <code>60</code>) —
              non-numeric values won&apos;t round-trip.
            </div>
          )}
          {valueEmpty && !valueInvalid && (
            <div className="rule-row-warning muted">
              Enter an age for the <code>{r.op}</code> comparison.
            </div>
          )}
        </div>
      );
    }

    case 'summary_flag': {
      const inList = props.summaryFlags.includes(r.flag);
      return (
        <div className="row gap rule-row">
          <label className="row gap">
            <input
              type="checkbox"
              checked={r.negated}
              onChange={(e) => props.onChange({ ...r, negated: e.target.checked })}
            />
            NOT
          </label>
          <code>summary.</code>
          {props.summaryFlags.length > 0 ? (
            <select
              value={inList ? r.flag : '__custom__'}
              onChange={(e) => {
                if (e.target.value === '__custom__') return;
                props.onChange({ ...r, flag: e.target.value });
              }}
            >
              {props.summaryFlags.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
              <option value="__custom__">— custom —</option>
            </select>
          ) : null}
          {(!inList || props.summaryFlags.length === 0) && (
            <input
              value={r.flag}
              onChange={(e) => props.onChange({ ...r, flag: e.target.value })}
              placeholder="flag_name"
            />
          )}
          {remove}
        </div>
      );
    }

    case 'contact_field': {
      const valueInvalid = isNumericOp(r.op) && r.value !== '' && !isValidNumberLiteral(r.value);
      const valueEmpty = isNumericOp(r.op) && r.value.trim() === '';
      return (
        <div className="rule-row-block">
          <div className="row gap rule-row">
            <code>contact.</code>
            <FieldPicker
              value={r.field}
              contactForms={props.contactForms}
              onChange={(field) => props.onChange({ ...r, field })}
            />
            <select
              value={r.op}
              onChange={(e) =>
                props.onChange({
                  ...r,
                  op: e.target.value as '===' | '!==' | '>' | '<' | '>=' | '<=',
                })
              }
            >
              <option value="===">=</option>
              <option value="!==">≠</option>
              <option value=">">&gt;</option>
              <option value="<">&lt;</option>
              <option value=">=">≥</option>
              <option value="<=">≤</option>
            </select>
            <input
              value={r.value}
              onChange={(e) => props.onChange({ ...r, value: e.target.value })}
              placeholder={isNumericOp(r.op) ? 'number' : 'value'}
              className={valueInvalid ? 'invalid' : ''}
            />
            {remove}
          </div>
          {valueInvalid && (
            <div className="rule-row-warning">
              <strong>Not a number.</strong> Comparison <code>{r.op}</code> needs a numeric value
              (e.g. <code>20</code>, <code>5.5</code>, <code>-1</code>) — otherwise the rule
              won&apos;t round-trip and the row will be lost on save.
            </div>
          )}
          {valueEmpty && !valueInvalid && (
            <div className="rule-row-warning muted">
              Enter a number for the <code>{r.op}</code> comparison.
            </div>
          )}
        </div>
      );
    }

    case 'not_muted':
      return <div className="row gap rule-row"><code>Contact is not muted</code> {remove}</div>;
    case 'not_deceased':
      return <div className="row gap rule-row"><code>Contact is not deceased</code> {remove}</div>;

    case 'raw':
      return (
        <div className="row gap rule-row">
          <input
            value={r.text}
            onChange={(e) => props.onChange({ ...r, text: e.target.value })}
            placeholder="raw expression"
            className="raw-rule-input"
          />
          {remove}
        </div>
      );
  }
}
