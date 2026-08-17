/**
 * Visual rule builder for XLSForm `relevant` (and constraint / choice_filter).
 *
 * Parses the expression with the grammar from
 * @cht-ui/shared/xlsform/relevantParser, lets the user edit rules with
 * dropdowns, serializes back when they save. If the expression is outside
 * the supported grammar, falls back to a raw text editor so nothing is lost.
 */
import { useEffect, useState } from 'react';
import {
  parseRelevant,
  serializeRelevant,
  type ContextWrapper,
  type DateOffsetComparator,
  type DateOffsetDirection,
  type DateUnit,
  type Operator,
  type ParsedExpression,
  type ReportFieldChoice,
  type Rule,
} from '@cht-ui/shared';
import { ChoiceValueInput } from './ChoiceValueInput.js';
import {
  useContactSummaryBridgeKeys,
  type ContextBridgeKey,
} from './useContactSummaryContextKeys.js';
import { useReportFormFieldInfos } from './useReportFormFields.js';

interface Props {
  /** Names of the fields above this question (available for reference). */
  fieldOptions: string[];
  /** Geriatric §1 — per-field choice options ({name, label}) for this
   *  form's select_one/select_multiple fields, so comparison / selected()
   *  values are picked from a dropdown instead of hand-typed slugs.
   *  Absent/empty → the free-text inputs the builder always had. */
  fieldChoiceOptions?: Record<string, ReportFieldChoice[]>;
  /** The current expression text. */
  value: string;
  /** Phase 1a — contact-form field names. Empty/absent → the contact-input
   *  comparison branch falls back to a free-text picker; the toolbar
   *  button stays visible regardless (matches CalculationBuilder's
   *  `?? []` pattern at lines 334-335). */
  inputContactFields?: string[];
  /** Phase 1a — contact-summary context flag keys. Same semantics as
   *  `inputContactFields`: empty/absent doesn't hide the affordance —
   *  the author may know a key that the project scan didn't surface. */
  contextKeys?: string[];
  /** Called when the user clicks save in the modal. */
  onSave: (next: string) => void;
  /** Called when the user dismisses the modal. */
  onCancel: () => void;
  /** Label of the column being edited (e.g. "relevant"). */
  column: string;
}

/** CHT-canonical bare contact-input field names — the safety net when
 *  the project scan returns nothing (e.g. forms with hidden/collapsed
 *  contact-input blocks). Mirrors CalculationBuilder.tsx's
 *  FALLBACK_CONTACT_FIELDS so both builders offer the same baseline. */
const FALLBACK_CONTACT_FIELDS = [
  '_id',
  'patient_id',
  'name',
  'sex',
  'date_of_birth',
  'phone',
];

const CONTEXT_WRAPPER_LABELS: Record<ContextWrapper, string> = {
  none: 'bare',
  'read-once': 'once(…) (read once)',
  'fallback-to-current': 'if(…, …, .) (fallback to current)',
  'guarded-fallback': "if(… != '', …, .) (fallback, explicit)",
  coalesce: 'coalesce(…, .) (first with a value)',
};

const CONTEXT_WRAPPER_HELP: Record<ContextWrapper, string> = {
  none: 'Read the context-summary flag directly.',
  'read-once':
    'Wrap in once(...) so the value is read on form-load only — useful for snapshotting LMP / EDD / measurements that should not flicker as the user edits.',
  'fallback-to-current':
    'Read the context value if present, else keep the current form answer (XForms `if(ref, ref, .)`).',
  'guarded-fallback':
    "Same intent as the fallback above, written with an explicit emptiness test — `if(ref != '', ref, .)`. The most common spelling in real configs, and the only one some use.",
  coalesce:
    'Read the context value if it has one, else keep the current answer, written as a single XPath function — `coalesce(ref, .)`.',
};

const OPERATORS: Operator[] = ['=', '!=', '>', '<', '>=', '<='];

export function RelevantRuleBuilder(props: Props) {
  const [parsed, setParsed] = useState<ParsedExpression>(() => parseRelevant(props.value));
  const [showRaw, setShowRaw] = useState<boolean>(() => parseRelevant(props.value).isRawFallback);
  const [rawText, setRawText] = useState<string>(props.value);

  useEffect(() => {
    setParsed(parseRelevant(props.value));
    setRawText(props.value);
  }, [props.value]);

  function updateRule(idx: number, next: Rule) {
    const rules = parsed.rules.map((r, i) => (i === idx ? next : r));
    setParsed({ ...parsed, rules });
  }
  function removeRule(idx: number) {
    setParsed({ ...parsed, rules: parsed.rules.filter((_, i) => i !== idx) });
  }
  function addRule(kind: Rule['kind']) {
    const f0 = props.fieldOptions[0] ?? '';
    const ci0 = props.inputContactFields?.[0] ?? FALLBACK_CONTACT_FIELDS[0] ?? '_id';
    const ck0 = props.contextKeys?.[0] ?? '';
    let newRule: Rule;
    switch (kind) {
      case 'comparison':
        newRule = { kind: 'comparison', field: f0, op: '=', value: '', valueIsString: true };
        break;
      case 'selected':
        newRule = { kind: 'selected', field: f0, value: '', negated: false };
        break;
      case 'answered':
        newRule = { kind: 'answered', field: f0, negated: false };
        break;
      case 'date_offset':
        newRule = {
          kind: 'date_offset',
          field: f0,
          comparator: 'more_than',
          amount: '20',
          unit: 'years',
          direction: 'ago',
        };
        break;
      case 'age':
        newRule = { kind: 'age', field: f0, op: '>', value: '20' };
        break;
      case 'contact-input-comparison':
        newRule = {
          kind: 'contact-input-comparison',
          field: ci0,
          op: '=',
          value: '',
          valueIsString: true,
        };
        break;
      case 'contact-summary-comparison':
        newRule = {
          kind: 'contact-summary-comparison',
          contextKey: ck0,
          wrapper: 'none',
          op: '=',
          value: '',
          valueIsString: true,
        };
        break;
      default:
        newRule = { kind: 'raw', text: '' };
    }
    setParsed({ ...parsed, rules: [...parsed.rules, newRule] });
  }

  function save() {
    if (showRaw) {
      props.onSave(rawText);
      return;
    }
    props.onSave(serializeRelevant(parsed));
  }

  return (
    <div className="rule-builder-modal" role="dialog">
      <div className="rule-builder-card">
        <header className="row">
          <h3>
            Rule builder — <code>{props.column}</code>
          </h3>
          <button className="link" onClick={props.onCancel}>
            cancel
          </button>
        </header>

        <div className="row gap">
          <button className={!showRaw ? 'active' : 'link'} onClick={() => setShowRaw(false)}>
            Visual
          </button>
          <button className={showRaw ? 'active' : 'link'} onClick={() => setShowRaw(true)}>
            Raw
          </button>
          {parsed.isRawFallback && !showRaw && (
            <span className="badge warn">
              Expression couldn&apos;t be parsed into rules; switch to Raw to keep editing.
            </span>
          )}
        </div>

        {!showRaw && (
          <div className="rule-list">
            <div className="row gap">
              <label>
                <input
                  type="radio"
                  name="combinator"
                  checked={parsed.combinator === 'and'}
                  onChange={() => setParsed({ ...parsed, combinator: 'and' })}
                />
                and also (all rules must match)
              </label>
              <label>
                <input
                  type="radio"
                  name="combinator"
                  checked={parsed.combinator === 'or'}
                  onChange={() => setParsed({ ...parsed, combinator: 'or' })}
                />
                or instead (any rule may match)
              </label>
            </div>

            {parsed.rules.map((rule, idx) => (
              <RuleRow
                key={idx}
                rule={rule}
                fieldOptions={props.fieldOptions}
                fieldChoiceOptions={props.fieldChoiceOptions ?? {}}
                inputContactFields={props.inputContactFields ?? []}
                contextKeys={props.contextKeys ?? []}
                onChange={(r) => updateRule(idx, r)}
                onRemove={() => removeRule(idx)}
              />
            ))}

            <div className="row gap">
              <button className="link" onClick={() => addRule('comparison')}>
                + comparison
              </button>
              <button className="link" onClick={() => addRule('selected')}>
                + selected()
              </button>
              <button className="link" onClick={() => addRule('answered')}>
                + answered check
              </button>
              <button className="link" onClick={() => addRule('age')}>
                + age
              </button>
              <button className="link" onClick={() => addRule('date_offset')}>
                + date check
              </button>
              <button
                className="link"
                onClick={() => addRule('contact-input-comparison')}
                title="Compare against a value the contact carries (../inputs/contact/...) — Phase 1a"
              >
                + contact input
              </button>
              {/* §Trap1 fix — contact-summary requires at least one
                  known context key to be useful. Without keys the
                  initial rule would emit an invalid path
                  (`instance('contact-summary')/context/`) on save.
                  Hide the button when the project has no
                  contact-summary keys; the author can switch to the
                  raw editor for an exotic case. */}
              {(props.contextKeys?.length ?? 0) > 0 && (
                <button
                  className="link"
                  onClick={() => addRule('contact-summary-comparison')}
                  title="Compare against a contact-summary context flag (instance('contact-summary')/context/...) — Phase 1a"
                >
                  + contact-summary
                </button>
              )}
              <button className="link" onClick={() => addRule('raw')}>
                + raw expression
              </button>
            </div>
            <div className="preview">
              <code>{serializeRelevant(parsed) || '(empty)'}</code>
            </div>
          </div>
        )}

        {showRaw && (
          <textarea
            className="code-editor short"
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            spellCheck={false}
          />
        )}

        <footer className="row gap end">
          <button onClick={save}>Save</button>
          <button className="link" onClick={props.onCancel}>
            cancel
          </button>
        </footer>
      </div>
    </div>
  );
}

function RuleRow(props: {
  rule: Rule;
  fieldOptions: string[];
  /** Geriatric §1 — this form's select fields' choices for the value
   *  dropdowns (label shown, name stored). */
  fieldChoiceOptions: Record<string, ReportFieldChoice[]>;
  /** Phase 1a — passed through from parent. Empty array is fine; the
   *  datalist degrades to a free-text input. */
  inputContactFields: string[];
  contextKeys: string[];
  onChange: (r: Rule) => void;
  onRemove: () => void;
}) {
  const { rule } = props;
  // Geriatric §1 — hooks run unconditionally (React rule); the args are
  // no-ops for rule kinds that don't use them. For a contact-summary
  // comparison whose context key is a cross-form BRIDGE, the bridge
  // metadata (source form + field) resolves the value dropdown's choices
  // via the same extended fields fetch the appliesIf side uses.
  const bridges = useContactSummaryBridgeKeys();
  const bridge =
    rule.kind === 'contact-summary-comparison'
      ? bridges.find((b) => b.key === rule.contextKey)
      : undefined;
  const { infos: bridgeInfos } = useReportFormFieldInfos(bridge?.sourceForm || null);
  const bridgeChoices = bridge
    ? bridgeInfos.find((i) => i.path === bridge.sourceField)?.choices
    : undefined;

  if (rule.kind === 'comparison') {
    const choices = rule.valueIsString ? props.fieldChoiceOptions[rule.field] : undefined;
    return (
      <div className="row gap rule-row">
        <FieldPicker
          value={rule.field}
          options={props.fieldOptions}
          onChange={(v) => props.onChange({ ...rule, field: v })}
        />
        <select
          value={rule.op}
          onChange={(e) => props.onChange({ ...rule, op: e.target.value as Operator })}
        >
          {OPERATORS.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
        <ChoiceValueInput
          value={rule.value}
          onChange={(v) => props.onChange({ ...rule, value: v })}
          choices={choices}
          placeholder={rule.valueIsString ? 'text value' : 'number / expression'}
        />
        <label className="row gap">
          <input
            type="checkbox"
            checked={rule.valueIsString}
            onChange={(e) => props.onChange({ ...rule, valueIsString: e.target.checked })}
          />
          string
        </label>
        <button className="link danger" onClick={props.onRemove}>×</button>
      </div>
    );
  }
  if (rule.kind === 'selected') {
    return (
      <div className="row gap rule-row">
        <label className="row gap">
          <input
            type="checkbox"
            checked={rule.negated}
            onChange={(e) => props.onChange({ ...rule, negated: e.target.checked })}
          />
          NOT
        </label>
        <span>selected(</span>
        <FieldPicker
          value={rule.field}
          options={props.fieldOptions}
          onChange={(v) => props.onChange({ ...rule, field: v })}
        />
        <span>,</span>
        <ChoiceValueInput
          value={rule.value}
          onChange={(v) => props.onChange({ ...rule, value: v })}
          choices={props.fieldChoiceOptions[rule.field]}
          placeholder="choice name"
        />
        <span>)</span>
        <button className="link danger" onClick={props.onRemove}>×</button>
      </div>
    );
  }
  if (rule.kind === 'age') {
    return (
      <div className="row gap rule-row">
        <span>age of</span>
        <FieldPicker
          value={rule.field}
          options={props.fieldOptions}
          onChange={(v) => props.onChange({ ...rule, field: v })}
        />
        <select
          value={rule.op}
          onChange={(e) => props.onChange({ ...rule, op: e.target.value as Operator })}
        >
          {OPERATORS.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
        <input
          type="number"
          value={rule.value}
          onChange={(e) => props.onChange({ ...rule, value: e.target.value })}
          style={{ width: 72 }}
        />
        <span>years</span>
        <button className="link danger" onClick={props.onRemove}>×</button>
      </div>
    );
  }
  if (rule.kind === 'date_offset') {
    return (
      <div className="row gap rule-row">
        <FieldPicker
          value={rule.field}
          options={props.fieldOptions}
          onChange={(v) => props.onChange({ ...rule, field: v })}
        />
        <span>is</span>
        <select
          value={rule.comparator}
          onChange={(e) =>
            props.onChange({ ...rule, comparator: e.target.value as DateOffsetComparator })
          }
        >
          <option value="more_than">more than</option>
          <option value="less_than">less than</option>
        </select>
        <input
          type="number"
          value={rule.amount}
          onChange={(e) => props.onChange({ ...rule, amount: e.target.value })}
          style={{ width: 72 }}
        />
        <select
          value={rule.unit}
          onChange={(e) => props.onChange({ ...rule, unit: e.target.value as DateUnit })}
        >
          <option value="days">days</option>
          <option value="weeks">weeks</option>
          <option value="months">months</option>
          <option value="years">years</option>
        </select>
        <select
          value={rule.direction}
          onChange={(e) =>
            props.onChange({ ...rule, direction: e.target.value as DateOffsetDirection })
          }
        >
          <option value="ago">ago</option>
          <option value="from_now">from now</option>
        </select>
        <button className="link danger" onClick={props.onRemove}>×</button>
      </div>
    );
  }
  if (rule.kind === 'answered') {
    return (
      <div className="row gap rule-row">
        <FieldPicker
          value={rule.field}
          options={props.fieldOptions}
          onChange={(v) => props.onChange({ ...rule, field: v })}
        />
        <select
          value={rule.negated ? 'not_answered' : 'answered'}
          onChange={(e) => props.onChange({ ...rule, negated: e.target.value === 'not_answered' })}
        >
          <option value="answered">is answered</option>
          <option value="not_answered">is not answered</option>
        </select>
        <button className="link danger" onClick={props.onRemove}>×</button>
      </div>
    );
  }
  if (rule.kind === 'contact-input-comparison') {
    // Mirrors the ComparisonRule shape but with a datalist on the LHS
    // backed by the project's contact-input field list ∪ the CHT-canonical
    // fallback set. Keeping it a plain <input list=…> instead of a native
    // <select> means an author can hand-type a field name that the project
    // scan missed (e.g. a custom contact-summary key) — the parser
    // round-trips whatever they type as long as it's a single identifier.
    const ciOptions = Array.from(
      new Set([...props.inputContactFields, ...FALLBACK_CONTACT_FIELDS]),
    );
    return (
      <div className="row gap rule-row">
        <span className="muted small">../inputs/contact/</span>
        <input
          list="rule-builder-contact-input-fields"
          value={rule.field}
          onChange={(e) => props.onChange({ ...rule, field: e.target.value })}
          placeholder="field name"
          style={{ minWidth: 140 }}
        />
        <datalist id="rule-builder-contact-input-fields">
          {ciOptions.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
        <select
          value={rule.op}
          onChange={(e) => props.onChange({ ...rule, op: e.target.value as Operator })}
        >
          {OPERATORS.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
        <input
          value={rule.value}
          onChange={(e) => props.onChange({ ...rule, value: e.target.value })}
          placeholder={rule.valueIsString ? 'text value' : 'number / expression'}
        />
        <label className="row gap">
          <input
            type="checkbox"
            checked={rule.valueIsString}
            onChange={(e) => props.onChange({ ...rule, valueIsString: e.target.checked })}
          />
          string
        </label>
        <button className="link danger" onClick={props.onRemove}>×</button>
      </div>
    );
  }
  if (rule.kind === 'contact-summary-comparison') {
    return (
      <div className="row gap rule-row">
        <select
          value={rule.wrapper}
          onChange={(e) =>
            props.onChange({ ...rule, wrapper: e.target.value as ContextWrapper })
          }
          title={CONTEXT_WRAPPER_HELP[rule.wrapper]}
          aria-label="Reference wrapper"
        >
          {(Object.keys(CONTEXT_WRAPPER_LABELS) as ContextWrapper[]).map((w) => (
            <option key={w} value={w}>
              {CONTEXT_WRAPPER_LABELS[w]}
            </option>
          ))}
        </select>
        <span className="muted small">contact-summary /context/</span>
        <ContextKeyPicker
          value={rule.contextKey}
          options={props.contextKeys}
          bridges={bridges}
          onChange={(v) => props.onChange({ ...rule, contextKey: v })}
        />
        <select
          value={rule.op}
          onChange={(e) => props.onChange({ ...rule, op: e.target.value as Operator })}
        >
          {OPERATORS.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
        <ChoiceValueInput
          value={rule.value}
          onChange={(v) => props.onChange({ ...rule, value: v })}
          choices={rule.valueIsString ? bridgeChoices : undefined}
          placeholder={rule.valueIsString ? 'text value' : 'number / expression'}
        />
        <label className="row gap">
          <input
            type="checkbox"
            checked={rule.valueIsString}
            onChange={(e) => props.onChange({ ...rule, valueIsString: e.target.checked })}
          />
          string
        </label>
        <button className="link danger" onClick={props.onRemove}>×</button>
      </div>
    );
  }
  // raw
  return (
    <div className="row gap rule-row">
      <input
        value={rule.text}
        onChange={(e) => props.onChange({ ...rule, text: e.target.value })}
        placeholder="raw expression fragment"
        className="raw-rule-input"
      />
      <button className="link danger" onClick={props.onRemove}>×</button>
    </div>
  );
}

/**
 * Picker for a contact-summary context key (docs/NEXT.md item 5). Replaces
 * a free-text datalist, which left the last hand-typed identifier in the
 * 8 referral-follow-up rows.
 *
 * Every piece here defends the raw-fallback invariant, because a `<select>`
 * whose value has no matching `<option>` renders blank AND can fire a
 * change event writing `''` back — which would silently rewrite a valid
 * hand-authored expression into `instance('contact-summary')/context/ = …`:
 *   - an ORPHAN option always exists for an off-list value, so a match is
 *     guaranteed and nothing is ever cleared implicitly;
 *   - the `__custom__` sentinel is a no-op on select (re-emits the current
 *     value) rather than an empty write;
 *   - the free-text input stays mounted whenever the value is off-list, so
 *     the author can still edit it;
 *   - there is deliberately NO empty `— pick —` option: `serializeRule`
 *     does not validate, and an empty key emits the invalid path the
 *     §Trap1 comment above exists to prevent.
 *
 * Stateless by design: `contextKeys` is `[]` on first paint and can change
 * mid-session via `invalidateContactSummaryContextKeys()`. Deriving
 * `inList` on every render means a key that arrives late self-corrects;
 * seeding a `useState` from the first render would stick in the wrong mode
 * (the bug ReportFieldPicker needed `customExplicit` to escape).
 */
function ContextKeyPicker(props: {
  value: string;
  options: string[];
  bridges: ContextBridgeKey[];
  onChange: (v: string) => void;
}) {
  const inList = props.options.includes(props.value);
  const bridgeFor = (k: string) => props.bridges.find((b) => b.key === k);
  return (
    <>
      <select
        className="context-key-select"
        value={inList ? props.value : '__custom__'}
        onChange={(e) => {
          // The sentinel means "keep editing by hand" — re-emitting the
          // current value keeps this a no-op instead of a destructive ''.
          if (e.target.value === '__custom__') props.onChange(props.value);
          else props.onChange(e.target.value);
        }}
        title="Pick a value defined in Contact Summary → Context values"
        aria-label="Contact-summary context key"
      >
        {!inList && props.value !== '' && (
          <option value={props.value}>{props.value} — not defined</option>
        )}
        {props.options.map((k) => {
          const b = bridgeFor(k);
          return (
            <option key={k} value={k}>
              {b ? `${k} — from ${b.sourceForm}.${b.sourceField}` : k}
            </option>
          );
        })}
        <option value="__custom__">— type a key —</option>
      </select>
      {!inList && (
        <input
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          placeholder="context key"
          style={{ minWidth: 140 }}
        />
      )}
      {!inList && props.value !== '' && (
        <span
          className="badge warn"
          title={`No context value named "${props.value}" is defined in contact-summary.templated.js. Define it under Contact Summary → Context values, or fix the name.`}
        >
          not defined
        </span>
      )}
    </>
  );
}

function FieldPicker(props: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  const inList = props.options.includes(props.value);
  return (
    <div className="row gap">
      <span>$&#123;</span>
      <select value={inList ? props.value : '__custom__'} onChange={(e) => props.onChange(e.target.value === '__custom__' ? props.value : e.target.value)}>
        {props.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
        <option value="__custom__">— custom —</option>
      </select>
      {!inList && (
        <input
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          placeholder="field name"
        />
      )}
      <span>&#125;</span>
    </div>
  );
}
