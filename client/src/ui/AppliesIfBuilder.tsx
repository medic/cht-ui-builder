/**
 * Visual rule builder for task `appliesIf` (and contact-summary flag bodies).
 *
 * Parses the JS into AppliesIfRule list via the shared appliesIfParser, lets
 * the user toggle dropdowns and checkboxes, serializes back. Falls back to
 * a raw code editor for expressions the parser couldn't lift.
 */
import { Fragment, useEffect, useMemo, useState } from 'react';
import type React from 'react';
import {
  parseAppliesIf,
  serializeAppliesIf,
  type AppliesIfRule,
  type ParsedAppliesIf,
} from '@cht-ui/shared';
import { useApp } from '../state/store.js';
import { ChoiceValueInput } from './ChoiceValueInput.js';
import {
  FieldPicker,
  isNumericOp,
  isValidNumberLiteral,
  type ContactFormFields,
} from './FieldPicker.js';
import { ReportFieldPicker } from './ReportFieldPicker.js';
import { useReportFormFieldInfos } from './useReportFormFields.js';
import { useProjectHelpers, type ProjectHelper } from './useProjectHelpers.js';

export type { ContactFormFields };

interface Props {
  value: string;
  onSave: (next: string) => void;
  onCancel: () => void;
  title?: string;
  /** Optional: contact forms whose fields populate the `contact_field` picker. */
  contactForms?: ContactFormFields[];
  /** Optional: report-form basenames (from task.appliesToType) for the report_field picker. */
  appliesToType?: string[];
}

/** Singleton or-group ids are meaningless (a group of one is just AND);
 *  normalize them to undefined so serialization/pill display stay clean. */
function normalizeOrGroups(or: Array<number | undefined>): Array<number | undefined> {
  const counts = new Map<number, number>();
  for (const g of or) if (g !== undefined) counts.set(g, (counts.get(g) ?? 0) + 1);
  return or.map((g) => (g !== undefined && (counts.get(g) ?? 0) > 1 ? g : undefined));
}

export function AppliesIfBuilder(props: Props) {
  const [parsed, setParsed] = useState<ParsedAppliesIf>(() => parseAppliesIf(props.value));
  const [showRaw, setShowRaw] = useState<boolean>(false);
  const [rawText, setRawText] = useState<string>(props.value);

  useEffect(() => {
    setParsed(parseAppliesIf(props.value));
    setRawText(props.value);
  }, [props.value]);

  function updateRule(idx: number, next: AppliesIfRule) {
    setParsed({ ...parsed, rules: parsed.rules.map((r, i) => (i === idx ? next : r)) });
  }
  function removeRule(idx: number) {
    setParsed({
      ...parsed,
      rules: parsed.rules.filter((_, i) => i !== idx),
      guardGroups: parsed.guardGroups.filter((_, i) => i !== idx),
      orGroups: normalizeOrGroups(parsed.orGroups.filter((_, i) => i !== idx)),
    });
  }

  /**
   * Geriatric §3 — set the connector BETWEEN rules `idx-1` and `idx`.
   * Consecutive rules sharing an orGroup id are OR-combined; everything
   * else is AND (the default). Chains extend naturally: setting B–C to
   * "or" when A–B already is merges all three into one group.
   */
  function setConnector(idx: number, val: 'and' | 'or') {
    const or = [...parsed.orGroups];
    const gg = [...parsed.guardGroups];
    if (val === 'or') {
      const gid =
        or[idx - 1] ?? or[idx] ?? Math.max(-1, ...or.filter((g): g is number => g !== undefined)) + 1;
      // Joining an OR chain absorbs both rows (and transitively their
      // existing chains — ids are unified).
      const oldA = or[idx - 1];
      const oldB = or[idx];
      for (let i = 0; i < or.length; i++) {
        if (
          i === idx - 1 ||
          i === idx ||
          (oldA !== undefined && or[i] === oldA) ||
          (oldB !== undefined && or[i] === oldB)
        ) {
          or[i] = gid;
          // A rule can't be in a legacy ||-guard formatting group AND an
          // OR group; the OR group wins.
          gg[i] = undefined;
        }
      }
    } else {
      // Break the chain between idx-1 and idx: rows from idx onward that
      // shared the id get a fresh id; singleton leftovers normalize away.
      const gid = or[idx];
      if (gid !== undefined && or[idx - 1] === gid) {
        const newId = Math.max(-1, ...or.filter((g): g is number => g !== undefined)) + 1;
        for (let i = idx; i < or.length && or[i] === gid; i++) or[i] = newId;
      }
    }
    setParsed({ ...parsed, orGroups: normalizeOrGroups(or), guardGroups: gg });
  }
  function addRule(kind: AppliesIfRule['kind']) {
    let next: AppliesIfRule;
    switch (kind) {
      case 'is_task_user':
        next = { kind: 'is_task_user' };
        break;
      case 'is_alive':
        next = { kind: 'is_alive', negated: false };
        break;
      case 'is_muted':
        next = { kind: 'is_muted', negated: true };
        break;
      case 'has_error':
        next = { kind: 'has_error', negated: true };
        break;
      case 'helper':
        next = { kind: 'helper', name: 'isActivePregnancy', args: 'contact.contact, contact.reports, report', negated: false };
        break;
      case 'contact_field':
        next = { kind: 'contact_field', field: 'role', op: '===', value: 'patient' };
        break;
      case 'report_field':
        next = { kind: 'report_field', field: 'surveillance.has_chronic_symptoms', op: '===', value: 'yes' };
        break;
      case 'report_field_includes':
        next = { kind: 'report_field_includes', field: '', value: '', negated: false };
        break;
      case 'field_presence':
        next = { kind: 'field_presence', source: 'report', field: '', negated: false };
        break;
      case 'field_age':
        next = { kind: 'field_age', source: 'report', field: '', unit: 'weeks', op: '>=', value: 42 };
        break;
      case 'field_age_between':
        next = {
          kind: 'field_age_between',
          source: 'report',
          field: '',
          unit: 'days',
          min: 84,
          max: 90,
          minOp: '>=',
          maxOp: '<=',
        };
        break;
      case 'raw':
        next = { kind: 'raw', text: '' };
        break;
    }
    setParsed({
      ...parsed,
      rules: [...parsed.rules, next],
      guardGroups: [...parsed.guardGroups, undefined],
      orGroups: [...parsed.orGroups, undefined],
    });
  }

  // Find rule-level validity issues that would silently corrupt round-trip.
  const validationErrors = parsed.rules.flatMap((rule, idx) => {
    if (rule.kind === 'contact_field' || rule.kind === 'report_field') {
      if (isNumericOp(rule.op) && !isValidNumberLiteral(rule.value)) {
        const where = rule.kind === 'contact_field' ? 'contact field' : 'report field';
        return [`Row ${idx + 1}: ${where} needs a numeric value for "${rule.op}".`];
      }
    }
    if (rule.kind === 'report_field_includes') {
      // Validate rather than escape (the module escapes nothing anywhere,
      // and adding escaping here would break byte-stability against every
      // existing unescaped emission). docs/NEXT.md item 4.
      if (rule.field.trim() === '') {
        return [`Row ${idx + 1}: pick the multi-select field this option belongs to.`];
      }
      if (rule.value.trim() === '') {
        return [`Row ${idx + 1}: pick the option to check for.`];
      }
      if (rule.value.includes(' ')) {
        return [
          `Row ${idx + 1}: option "${rule.value}" contains a space — a multi-select answer is a space-separated list, so it could never match.`,
        ];
      }
      if (rule.value.includes("'")) {
        return [
          `Row ${idx + 1}: option "${rule.value}" contains an apostrophe, which would emit invalid JavaScript.`,
        ];
      }
    }
    if (rule.kind === 'raw' && rule.text.trim() === '') {
      return [`Row ${idx + 1}: empty "raw JS" row — delete it or fill it in.`];
    }
    return [];
  });
  const canSave = showRaw || validationErrors.length === 0;

  function save() {
    if (showRaw) {
      props.onSave(rawText);
      return;
    }
    if (validationErrors.length > 0) return;
    props.onSave(serializeAppliesIf(parsed));
  }

  return (
    <div className="rule-builder-modal" role="dialog">
      <div className="rule-builder-card">
        <header className="row gap">
          <h3>{props.title ?? 'Rule builder — appliesIf'}</h3>
          <button className="link" onClick={props.onCancel}>cancel</button>
        </header>

        <div className="row gap">
          <button
            className={!showRaw ? 'active' : 'link'}
            onClick={() => {
              if (!showRaw) return;
              // Switching Raw → Visual: re-parse rawText so changes carry over.
              const fromRaw = parseAppliesIf(rawText);
              if (rawText.trim() !== serializeAppliesIf(parsed).trim()) {
                const ok = window.confirm(
                  'Switch to Visual mode? Your raw edits will be re-parsed. ' +
                    'Anything the parser doesn\'t recognize will appear as a "raw" row — nothing is dropped.',
                );
                if (!ok) return;
              }
              setParsed(fromRaw);
              setShowRaw(false);
            }}
          >
            Visual
          </button>
          <button
            className={showRaw ? 'active' : 'link'}
            onClick={() => {
              if (showRaw) return;
              // Switching Visual → Raw: hand the current serialized form to the raw editor.
              setRawText(serializeAppliesIf(parsed));
              setShowRaw(true);
            }}
          >
            Raw JS
          </button>
          {parsed.hasRawFallback && !showRaw && (
            <span className="badge warn">
              Some clauses couldn&apos;t be lifted; they appear as &quot;raw&quot; rows below.
            </span>
          )}
        </div>

        {!showRaw && (
          <>
            <p className="muted">
              Conditions combine with <strong>and</strong> by default — switch a connector to{' '}
              <strong>or</strong> to accept either side (consecutive &quot;or&quot; rows form one
              group; groups combine with the rest via <strong>and</strong>). Parameters detected:{' '}
              <code>{parsed.params.join(', ') || '(none)'}</code>
            </p>
            <div className="rule-list">
              {parsed.rules.map((rule, idx) => (
                <Fragment key={idx}>
                  {idx > 0 && (
                    <div className="row gap connector-row">
                      <select
                        className="connector-pill"
                        value={
                          parsed.orGroups[idx - 1] !== undefined &&
                          parsed.orGroups[idx - 1] === parsed.orGroups[idx]
                            ? 'or'
                            : 'and'
                        }
                        onChange={(e) => setConnector(idx, e.target.value as 'and' | 'or')}
                        // A raw row can't join an OR group: the emitted
                        // ¬(A ∨ B) guard needs each side's INVERTED form,
                        // and raw JS has no invertible structure. Raw
                        // stays AND-combined; true mixed logic falls back
                        // to the Raw JS tab as before.
                        disabled={
                          parsed.rules[idx - 1]?.kind === 'raw' || parsed.rules[idx]?.kind === 'raw'
                        }
                        title={
                          parsed.rules[idx - 1]?.kind === 'raw' || parsed.rules[idx]?.kind === 'raw'
                            ? 'Raw JS rows can only combine with AND — use the Raw JS tab for mixed logic'
                            : 'How this condition combines with the one above'
                        }
                      >
                        <option value="and">and also</option>
                        <option value="or">or instead</option>
                      </select>
                    </div>
                  )}
                  <AppliesIfRuleRow
                    rule={rule}
                    contactForms={props.contactForms}
                    appliesToType={props.appliesToType}
                    onChange={(r) => updateRule(idx, r)}
                    onRemove={() => removeRule(idx)}
                  />
                </Fragment>
              ))}
              <div className="row gap toolbar">
                <button className="link" onClick={() => addRule('is_alive')}>+ alive check</button>
                <button className="link" onClick={() => addRule('is_muted')}>+ muted check</button>
                <button className="link" onClick={() => addRule('has_error')}>+ error check</button>
                <button className="link" onClick={() => addRule('is_task_user')}>+ task user</button>
                <button className="link" onClick={() => addRule('contact_field')}>+ contact field</button>
                <button className="link" onClick={() => addRule('report_field')}>+ report field</button>
                <button
                  className="link"
                  onClick={() => addRule('report_field_includes')}
                  title="For a multi-select answer: fires when the chosen option is among the ticked ones"
                >
                  + report field includes option
                </button>
                <button className="link" onClick={() => addRule('field_presence')}>+ field is set / not set</button>
                <button className="link" onClick={() => addRule('field_age')}>+ field age (days/weeks)</button>
                <button className="link" onClick={() => addRule('field_age_between')}>+ field age BETWEEN</button>
                <button className="link" onClick={() => addRule('helper')}>+ helper fn</button>
                <button className="link" onClick={() => addRule('raw')}>+ raw JS</button>
              </div>
            </div>
            <div className="preview">
              <pre>{serializeAppliesIf(parsed)}</pre>
            </div>
          </>
        )}

        {showRaw && (
          <textarea
            className="code-editor medium"
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            spellCheck={false}
          />
        )}

        {!showRaw && validationErrors.length > 0 && (
          <div className="rule-builder-errors">
            <strong>Fix these before saving:</strong>
            <ul>
              {validationErrors.map((msg, i) => (
                <li key={i}>{msg}</li>
              ))}
            </ul>
          </div>
        )}

        <footer className="row gap end">
          <button onClick={save} disabled={!canSave}>
            Save
          </button>
          <button className="link" onClick={props.onCancel}>cancel</button>
        </footer>
      </div>
    </div>
  );
}

function AppliesIfRuleRow(props: {
  rule: AppliesIfRule;
  contactForms?: ContactFormFields[];
  appliesToType?: string[];
  onChange: (r: AppliesIfRule) => void;
  onRemove: () => void;
}) {
  const r = props.rule;
  const remove = (
    <button className="link danger" onClick={props.onRemove}>×</button>
  );

  switch (r.kind) {
    case 'is_task_user':
      return (
        <div className="row gap rule-row">
          <code>User is a task user</code>
          {/* Show the argument the file actually carries, not a fixed
              `user` — the serializer now preserves it. */}
          <span className="muted">
            (<code>isTaskUser({r.args || 'user'})</code>)
          </span>
          {remove}
        </div>
      );

    case 'is_alive':
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
          <code>Contact is alive</code>
          {remove}
        </div>
      );

    case 'is_muted':
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
          <code>Contact is muted</code>
          <span className="muted">({r.negated ? 'i.e. not muted' : 'i.e. muted'})</span>
          {remove}
        </div>
      );

    case 'has_error':
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
          <code>Report has error</code>
          <span className="muted">({r.negated ? 'i.e. no error' : 'i.e. has error'})</span>
          {remove}
        </div>
      );

    case 'helper':
      return <HelperRow rule={r} onChange={props.onChange} remove={remove} />;

    case 'contact_field':
      return (
        <ContactFieldRow
          rule={r}
          contactForms={props.contactForms ?? []}
          onChange={props.onChange}
          remove={remove}
        />
      );

    case 'report_field':
    case 'report_field_includes':
      return (
        <ReportFieldRow
          rule={r}
          appliesToType={props.appliesToType ?? []}
          onChange={props.onChange}
          remove={remove}
        />
      );

    case 'field_presence':
      return (
        <FieldPresenceRow
          rule={r}
          contactForms={props.contactForms ?? []}
          appliesToType={props.appliesToType ?? []}
          onChange={props.onChange}
          remove={remove}
        />
      );

    case 'field_age':
      return (
        <FieldAgeRow
          rule={r}
          contactForms={props.contactForms ?? []}
          appliesToType={props.appliesToType ?? []}
          onChange={props.onChange}
          remove={remove}
        />
      );

    case 'field_age_between':
      return (
        <FieldAgeBetweenRow
          rule={r}
          contactForms={props.contactForms ?? []}
          appliesToType={props.appliesToType ?? []}
          onChange={props.onChange}
          remove={remove}
        />
      );

    case 'raw':
      return (
        <div className="row gap rule-row">
          <input
            value={r.text}
            onChange={(e) => props.onChange({ ...r, text: e.target.value })}
            placeholder="raw JS expression"
            className="raw-rule-input"
          />
          {remove}
        </div>
      );
  }
}

/**
 * `report_field` rule row (geriatric handoff §1). The value input is a
 * CHOICE DROPDOWN when the picked field is a select_one/select_multiple
 * — "if फेल selected for X" is buildable with zero typing (labels shown,
 * choice `name` stored; the emitted expression is byte-identical to the
 * typed path since the value is the same string). The picked FORM is
 * tracked here (controlled ReportFieldPicker) so the field's metadata can
 * be looked up; it's UI scaffolding only — the rule persists just the
 * field path + value.
 */
function ReportFieldRow(props: {
  rule: Extract<AppliesIfRule, { kind: 'report_field' | 'report_field_includes' }>;
  appliesToType: string[];
  onChange: (r: AppliesIfRule) => void;
  remove: React.ReactNode;
}) {
  const { rule: r, appliesToType, onChange, remove } = props;
  // Mirror ReportFieldPicker's default: appliesToType first, else every
  // app form in the project — so the first form is pre-picked exactly as
  // the uncontrolled picker always did.
  const forms = useApp((s) => s.forms);
  const allAppForms = useMemo(
    () =>
      forms.filter((f) => f.category === 'app').map((f) => f.filename.replace(/\.xlsx$/i, '')),
    [forms],
  );
  const formOptions = appliesToType.length > 0 ? appliesToType : allAppForms;
  const [pickedForm, setPickedForm] = useState<string>('');
  const effectiveForm = pickedForm || formOptions[0] || '';

  const { infos } = useReportFormFieldInfos(effectiveForm || null);
  const fieldInfo = infos.find((i) => i.path === r.field);
  const includesRow = r.kind === 'report_field_includes';
  const isEquality = !includesRow && (r.op === '===' || r.op === '!==');
  // docs/NEXT.md item 4 — gate on the FIELD'S TYPE, not just the operator.
  // A select_multiple answer is a space-separated string, so `=` against
  // one option is false the moment a second is ticked. That wrong shape
  // used to be one click away with no signal.
  const isMulti = /^select_multiple\b/i.test(fieldInfo?.type ?? '');
  const hasChoices = (fieldInfo?.choices?.length ?? 0) > 0;
  // The op dropdown's current selection: the includes kind carries no `op`,
  // so it is represented by two synthetic entries.
  const opValue = includesRow ? (r.negated ? 'not-includes' : 'includes') : r.op;

  /** Switching between the comparison kind and the includes kind rebuilds
   *  the rule, carrying field + value across so the user does not retype. */
  function changeOp(next: string) {
    if (next === 'includes' || next === 'not-includes') {
      onChange({
        kind: 'report_field_includes',
        field: r.field,
        value: r.value,
        negated: next === 'not-includes',
      });
      return;
    }
    onChange({
      kind: 'report_field',
      field: r.field,
      value: r.value,
      op: next as '===' | '!==' | '>' | '<' | '>=' | '<=',
    });
  }

  return (
    <div className="rule-row-block">
      <div className="row gap rule-row">
        <code>getField(report,</code>
        <ReportFieldPicker
          value={r.field}
          onChange={(v) => {
            const next = infos.find((i) => i.path === v);
            // Switching to a select field whose choices don't include the
            // current value (e.g. the row's seed default) would strand the
            // dropdown in custom mode — clear the stale value so the choice
            // dropdown appears immediately (zero-typing acceptance, §1).
            const keep =
              r.value === '' || !next?.choices || next.choices.some((c) => c.name === r.value);
            const value = keep ? r.value : '';
            // Picking a MULTI-select flips the row to the includes kind:
            // equality is the wrong question for it, and defaulting to the
            // right one is the whole point of item 4.
            if (/^select_multiple\b/i.test(next?.type ?? '') && r.kind === 'report_field') {
              onChange({ kind: 'report_field_includes', field: v, value, negated: false });
              return;
            }
            onChange({ ...r, field: v, value });
          }}
          availableForms={appliesToType}
          pickedForm={effectiveForm}
          onFormChange={setPickedForm}
        />
        <code>)</code>
        <select value={opValue} onChange={(e) => changeOp(e.target.value)}>
          {/* Comparison ops are meaningless against a multi-select answer,
              so they are withheld for one — leaving only the two that are
              actually correct. */}
          {!isMulti && (
            <>
              <option value="===">=</option>
              <option value="!==">!=</option>
              <option value=">">&gt;</option>
              <option value="<">&lt;</option>
              <option value=">=">&gt;=</option>
              <option value="<=">&lt;=</option>
            </>
          )}
          <option value="includes">includes option</option>
          <option value="not-includes">does not include option</option>
        </select>
        <ChoiceValueInput
          value={r.value}
          onChange={(v) => onChange({ ...r, value: v })}
          choices={hasChoices && (isEquality || includesRow) ? fieldInfo?.choices : undefined}
          placeholder={includesRow ? 'option' : isEquality ? 'value' : 'number'}
        />
        {remove}
      </div>
      {includesRow && r.value.includes(' ') && (
        <div className="rule-row-warning">
          <strong>Option can&apos;t contain a space.</strong> A multi-select answer is stored as a
          space-separated list, so an option with a space in it can never match.
        </div>
      )}
      {includesRow && r.value.includes("'") && (
        <div className="rule-row-warning">
          <strong>Option can&apos;t contain an apostrophe.</strong> It would produce invalid
          JavaScript in <code>tasks.js</code> and the rule would be lost on reopen.
        </div>
      )}
    </div>
  );
}

/**
 * "Field is set / is not set" — parses to `!!<ref>` (positive) or
 * `!<ref>` (negated). Source dropdown picks report vs contact; field
 * picker matches the existing ReportFieldPicker / FieldPicker used
 * elsewhere so the user only picks from real project fields.
 */
function FieldPresenceRow(props: {
  rule: Extract<AppliesIfRule, { kind: 'field_presence' }>;
  contactForms: ContactFormFields[];
  appliesToType: string[];
  onChange: (r: AppliesIfRule) => void;
  remove: React.ReactNode;
}) {
  const { rule: r, contactForms, appliesToType, onChange, remove } = props;
  return (
    <div className="row gap rule-row">
      <select
        value={r.source}
        onChange={(e) => onChange({ ...r, source: e.target.value as 'report' | 'contact' })}
        title="Field source"
      >
        <option value="report">report field</option>
        <option value="contact">contact field</option>
      </select>
      {r.source === 'report' ? (
        <ReportFieldPicker
          value={r.field}
          onChange={(v) => onChange({ ...r, field: v })}
          availableForms={appliesToType}
        />
      ) : (
        <FieldPicker
          value={r.field}
          contactForms={contactForms}
          onChange={(v) => onChange({ ...r, field: v })}
        />
      )}
      <select
        value={r.negated ? 'not_set' : 'is_set'}
        onChange={(e) => onChange({ ...r, negated: e.target.value === 'not_set' })}
      >
        <option value="is_set">is set</option>
        <option value="not_set">is not set</option>
      </select>
      {remove}
    </div>
  );
}

/**
 * "Field age" — parses to `(Date.now() - new Date(<ref>).getTime()) / <ms> <op> <n>`.
 * Unit is a dropdown (days/weeks/months); serializer maps to the matching ms constant.
 * Value is a positive number (LMP age 42 weeks, dob < 30 days, etc.).
 */
function FieldAgeRow(props: {
  rule: Extract<AppliesIfRule, { kind: 'field_age' }>;
  contactForms: ContactFormFields[];
  appliesToType: string[];
  onChange: (r: AppliesIfRule) => void;
  remove: React.ReactNode;
}) {
  const { rule: r, contactForms, appliesToType, onChange, remove } = props;
  const valueInvalid = !Number.isFinite(r.value);
  return (
    <div className="rule-row-block">
      <div className="row gap rule-row">
        <select
          value={r.source}
          onChange={(e) => onChange({ ...r, source: e.target.value as 'report' | 'contact' })}
          title="Field source"
        >
          <option value="report">report field</option>
          <option value="contact">contact field</option>
        </select>
        {r.source === 'report' ? (
          <ReportFieldPicker
            value={r.field}
            onChange={(v) => onChange({ ...r, field: v })}
            availableForms={appliesToType}
          />
        ) : (
          <FieldPicker
            value={r.field}
            contactForms={contactForms}
            onChange={(v) => onChange({ ...r, field: v })}
          />
        )}
        <span className="muted">was</span>
        <select
          value={r.op}
          onChange={(e) =>
            onChange({
              ...r,
              op: e.target.value as '===' | '!==' | '>' | '<' | '>=' | '<=',
            })
          }
        >
          <option value=">=">at least</option>
          <option value=">">more than</option>
          <option value="<=">at most</option>
          <option value="<">less than</option>
          <option value="===">exactly</option>
          <option value="!==">not exactly</option>
        </select>
        <input
          type="number"
          value={Number.isFinite(r.value) ? r.value : ''}
          onChange={(e) => onChange({ ...r, value: Number(e.target.value) })}
          className={valueInvalid ? 'invalid' : ''}
          style={{ width: 72 }}
        />
        <select
          value={r.unit}
          onChange={(e) => onChange({ ...r, unit: e.target.value as 'days' | 'weeks' | 'months' })}
        >
          <option value="days">days</option>
          <option value="weeks">weeks</option>
          <option value="months">months</option>
        </select>
        <span className="muted">ago (before today)</span>
        {remove}
      </div>
    </div>
  );
}

/**
 * "Field age BETWEEN" — parses/emits two guards ANDed together (min-side +
 * max-side) over the same source/field/unit. On parse, the shared
 * `fuseFieldAgeBetween` pass collapses the two field_age rows back into
 * this single row so open+save doesn't split the range.
 */
function FieldAgeBetweenRow(props: {
  rule: Extract<AppliesIfRule, { kind: 'field_age_between' }>;
  contactForms: ContactFormFields[];
  appliesToType: string[];
  onChange: (r: AppliesIfRule) => void;
  remove: React.ReactNode;
}) {
  const { rule: r, contactForms, appliesToType, onChange, remove } = props;
  const minInvalid = !Number.isFinite(r.min);
  const maxInvalid = !Number.isFinite(r.max);
  const rangeInvalid = Number.isFinite(r.min) && Number.isFinite(r.max) && r.min > r.max;
  return (
    <div className="rule-row-block">
      <div className="row gap rule-row">
        <select
          value={r.source}
          onChange={(e) => onChange({ ...r, source: e.target.value as 'report' | 'contact' })}
          title="Field source"
        >
          <option value="report">report field</option>
          <option value="contact">contact field</option>
        </select>
        {r.source === 'report' ? (
          <ReportFieldPicker
            value={r.field}
            onChange={(v) => onChange({ ...r, field: v })}
            availableForms={appliesToType}
          />
        ) : (
          <FieldPicker
            value={r.field}
            contactForms={contactForms}
            onChange={(v) => onChange({ ...r, field: v })}
          />
        )}
        <span className="muted">was between</span>
        <select
          value={r.minOp}
          onChange={(e) => onChange({ ...r, minOp: e.target.value as '>=' | '>' })}
          title="Lower-bound inclusivity"
        >
          <option value=">=">at least</option>
          <option value=">">more than</option>
        </select>
        <input
          type="number"
          value={Number.isFinite(r.min) ? r.min : ''}
          onChange={(e) => onChange({ ...r, min: Number(e.target.value) })}
          className={minInvalid ? 'invalid' : ''}
          style={{ width: 72 }}
        />
        <span className="muted">and</span>
        <select
          value={r.maxOp}
          onChange={(e) => onChange({ ...r, maxOp: e.target.value as '<=' | '<' })}
          title="Upper-bound inclusivity"
        >
          <option value="<=">at most</option>
          <option value="<">less than</option>
        </select>
        <input
          type="number"
          value={Number.isFinite(r.max) ? r.max : ''}
          onChange={(e) => onChange({ ...r, max: Number(e.target.value) })}
          className={maxInvalid ? 'invalid' : ''}
          style={{ width: 72 }}
        />
        <select
          value={r.unit}
          onChange={(e) => onChange({ ...r, unit: e.target.value as 'days' | 'weeks' | 'months' })}
        >
          <option value="days">days</option>
          <option value="weeks">weeks</option>
          <option value="months">months</option>
        </select>
        <span className="muted">ago (before today)</span>
        {remove}
      </div>
      {rangeInvalid && (
        <div className="rule-row-warning">
          <strong>Empty range.</strong> Min ({r.min}) is greater than max ({r.max}) — nothing will
          ever match. Swap the values or the rule can&apos;t fire.
        </div>
      )}
    </div>
  );
}

function ContactFieldRow(props: {
  rule: Extract<AppliesIfRule, { kind: 'contact_field' }>;
  contactForms: ContactFormFields[];
  onChange: (r: AppliesIfRule) => void;
  remove: React.ReactNode;
}) {
  const { rule: r, contactForms: forms, onChange, remove } = props;
  const valueInvalid = isNumericOp(r.op) && r.value !== '' && !isValidNumberLiteral(r.value);
  const valueEmpty = isNumericOp(r.op) && r.value.trim() === '';

  return (
    <div className="rule-row-block">
      <div className="row gap rule-row">
        <code>contact.contact.</code>
        <FieldPicker
          value={r.field}
          contactForms={forms}
          onChange={(field) => onChange({ ...r, field })}
        />
        <select
          value={r.op}
          onChange={(e) =>
            onChange({
              ...r,
              op: e.target.value as '===' | '!==' | '>' | '<' | '>=' | '<=',
            })
          }
        >
          <option value="===">=</option>
          <option value="!==">!=</option>
          <option value=">">&gt;</option>
          <option value="<">&lt;</option>
          <option value=">=">&gt;=</option>
          <option value="<=">&lt;=</option>
        </select>
        <input
          value={r.value}
          onChange={(e) => onChange({ ...r, value: e.target.value })}
          placeholder={isNumericOp(r.op) ? 'number' : 'value'}
          className={valueInvalid ? 'invalid' : ''}
        />
        {remove}
      </div>
      {valueInvalid && (
        <div className="rule-row-warning">
          <strong>Not a number.</strong> Comparison <code>{r.op}</code> needs a numeric value
          (e.g. <code>20</code>, <code>5.5</code>, <code>-1</code>) — otherwise the rule won&apos;t
          round-trip and the row will be lost on save.
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

/**
 * Helper-function rule row — picks a helper from the project's real
 * `tasks-extras.js` / `contact-summary-extras.js` (task-builder-parity
 * #8). Pre-fix the user typed both name + args as raw text; a typo or
 * wrong helper name silently broke the task at runtime (the JS
 * compiles, the call just throws). The picker now lists the real
 * exported helpers and pre-fills the call's args from the helper's
 * declared param count using the cht-default convention.
 *
 * "custom" toggle preserves the escape hatch for helpers in OTHER
 * source files (rare) or for renaming a helper without breaking the
 * existing call.
 */
function HelperRow(props: {
  rule: Extract<AppliesIfRule, { kind: 'helper' }>;
  onChange: (r: AppliesIfRule) => void;
  remove: React.ReactNode;
}) {
  const { rule: r, onChange, remove } = props;
  const helpers = useProjectHelpers();
  // The helper might exist outside what we surface (e.g. a private fn,
  // or a file the parser couldn't lift). When the rule's name doesn't
  // match any picker option, default to the custom-text input so we
  // never silently drop a non-trivial expression.
  const known = helpers.find((h) => h.name === r.name);
  const [useCustom, setUseCustom] = useState<boolean>(!known && helpers.length > 0);

  function pickHelper(h: ProjectHelper): void {
    // Convention from cht-default: helpers are called inside appliesIf
    // with (contact.contact, contact.reports, report) for the typical
    // 3-arg signature. Use the helper's declared param count to scale
    // the default call.
    const argDefaults = ['contact.contact', 'contact.reports', 'report'];
    const args = h.params.slice(0, Math.max(h.params.length, 1))
      .map((_, i) => argDefaults[i] ?? '/* arg */')
      .join(', ');
    onChange({ ...r, name: h.name, args });
  }

  return (
    <div className="row gap rule-row">
      <label className="row gap">
        <input
          type="checkbox"
          checked={r.negated}
          onChange={(e) => onChange({ ...r, negated: e.target.checked })}
        />
        NOT
      </label>
      {useCustom || helpers.length === 0 ? (
        <input
          value={r.name}
          onChange={(e) => onChange({ ...r, name: e.target.value })}
          placeholder="helper fn name"
        />
      ) : (
        <select
          value={r.name}
          onChange={(e) => {
            const next = helpers.find((h) => h.name === e.target.value);
            if (next) pickHelper(next);
          }}
          title="Pick a helper from tasks-extras.js / contact-summary-extras.js"
        >
          {!known && <option value={r.name}>{r.name} (unknown)</option>}
          <optgroup label="tasks-extras.js">
            {helpers
              .filter((h) => h.source === 'tasks-extras')
              .map((h) => (
                <option key={`t:${h.name}`} value={h.name}>
                  {h.name}({h.params.join(', ')})
                </option>
              ))}
          </optgroup>
          <optgroup label="contact-summary-extras.js">
            {helpers
              .filter((h) => h.source === 'contact-summary-extras')
              .map((h) => (
                <option key={`c:${h.name}`} value={h.name}>
                  {h.name}({h.params.join(', ')})
                </option>
              ))}
          </optgroup>
        </select>
      )}
      {helpers.length > 0 && (
        <button
          type="button"
          className="link small"
          onClick={() => setUseCustom((v) => !v)}
          title={
            useCustom
              ? 'Pick from project helpers'
              : 'Type a custom helper name (e.g. one from an extras file the parser didn\'t surface)'
          }
        >
          {useCustom ? 'pick' : 'custom'}
        </button>
      )}
      <span>(</span>
      <input
        value={r.args}
        onChange={(e) => onChange({ ...r, args: e.target.value })}
        placeholder="arguments"
        style={{ minWidth: 240 }}
      />
      <span>)</span>
      {remove}
    </div>
  );
}
