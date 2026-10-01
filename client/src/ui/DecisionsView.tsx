/**
 * "Decisions" — a read-only sign-off view for clinicians.
 *
 * Aggregates every decision-shaped artifact in the project:
 *   1. Predicate helpers in contact-summary.extras.js (eligibility checks)
 *   2. Context flags in contact-summary.templated.js
 *   3. Form context expressions in forms/app/*.properties.json
 *   4. XLSForm `calculation` fields (DMN-style decision tables)
 *   5. Task `appliesIf` (when does a task fire?)
 *   6. Task `resolvedIf` (when does a task close?)
 *
 * Each one is rendered as a DMN-style table with: human-readable
 * conditions, outputs, and a "this affects" cross-reference so a
 * reviewer can trace the impact.
 */
import { useEffect, useState } from 'react';
import {
  parseAppliesIf,
  parseCalculation,
  parseContactSummary,
  parseContextExpression,
  parseHelpers,
  parseTaskFile,
  parseXlsForm,
  type AppliesIfRule,
  type ContextRule,
  type ParsedCalculation,
  serializeRule,
} from '@cht-ui/shared';
import { api } from '../api.js';
import { useApp } from '../state/store.js';
import { OrphansSection } from './StandardCodesView.js';
import type { OrphanEntry } from '@cht-ui/shared';

interface Decision {
  id: string;
  category: 'eligibility' | 'context_flag' | 'form_context' | 'calculation' | 'task_fires' | 'task_resolves';
  title: string;
  /** Source location (file + name). */
  source: string;
  /** Cross-references (which forms/tasks this decision affects). */
  affects: string[];
  /** Rendered conditions (one row per AND clause; multi-row tables for if-chains). */
  rows: DecisionRow[];
  /** Optional "otherwise" output for if-chains. */
  otherwise?: string;
}

interface DecisionRow {
  conditions: string[];
  output: string;
}

export function DecisionsView() {
  const setError = useApp((s) => s.setError);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [loading, setLoading] = useState(true);
  // §H3 + MVP §7 MOH gate — orphaned FHIR mappings must be logged on
  // the sign-off view so the clinical reviewer can audit them. Loads
  // in parallel with the decisions feed; failure is non-blocking (we
  // still render the rest of the page rather than blanking out).
  const [orphans, setOrphans] = useState<OrphanEntry[]>([]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    loadAllDecisions()
      .then((d) => {
        if (alive) {
          setDecisions(d);
          setLoading(false);
        }
      })
      .catch((e: Error) => {
        if (alive) {
          setError(e.message);
          setLoading(false);
        }
      });
    void api
      .getFhirMapping()
      .then((res) => {
        if (alive) setOrphans(res.mapping.orphans ?? []);
      })
      .catch(() => {
        /* Sidecar missing on a fresh project — leave orphans=[]. */
      });
    return () => {
      alive = false;
    };
  }, [setError]);

  const byCategory = groupBy(decisions, (d) => d.category);

  return (
    <div className="decisions-view">
      <header className="page-header">
        <div>
          <h1>Decisions — clinical sign-off view</h1>
          <p className="muted">
            Every condition the app evaluates is collected here as a DMN-style table. Use this view
            to verify clinical correctness before deploying. Read-only.
          </p>
        </div>
      </header>

      {loading && <div className="loading">Loading decisions…</div>}
      {!loading && decisions.length === 0 && (
        <p className="muted">No decisions detected in this project.</p>
      )}

      <DecisionGroup
        title="Form eligibility (who sees the form)"
        decisions={byCategory['form_context'] ?? []}
        emptyHint="No forms with context expressions found."
      />
      <DecisionGroup
        title="Eligibility helpers (predicate functions)"
        decisions={byCategory['eligibility'] ?? []}
        emptyHint="No helper predicates found in contact-summary.extras.js."
      />
      <DecisionGroup
        title="Context flags (summary.X)"
        decisions={byCategory['context_flag'] ?? []}
        emptyHint="No context flags found in contact-summary.templated.js."
      />
      <DecisionGroup
        title="Calculated fields inside forms"
        decisions={byCategory['calculation'] ?? []}
        emptyHint="No multi-rule calculations found."
      />
      <DecisionGroup
        title="Task triggers (when does the task fire?)"
        decisions={byCategory['task_fires'] ?? []}
        emptyHint="No tasks with structured appliesIf found."
      />
      <DecisionGroup
        title="Task resolution (when does the task close?)"
        decisions={byCategory['task_resolves'] ?? []}
        emptyHint="No tasks with structured resolvedIf found."
      />

      {/* §H3 + MVP §7 MOH gate — orphaned FHIR mappings on the sign-off
          view. Always rendered (even when empty) so the gate is
          satisfied explicitly: an empty list says "audited, none
          drifted," not "we didn't look." */}
      <section className="decision-group">
        <h2>FHIR mapping — orphaned decisions</h2>
        <OrphansSection orphans={orphans} mode="decisions" />
      </section>
    </div>
  );
}

function DecisionGroup({
  title,
  decisions,
  emptyHint,
}: {
  title: string;
  decisions: Decision[];
  emptyHint: string;
}) {
  return (
    <section className="decision-group">
      <h2>{title}</h2>
      {decisions.length === 0 && <p className="muted">{emptyHint}</p>}
      {decisions.map((d) => (
        <DecisionCard key={d.id} decision={d} />
      ))}
    </section>
  );
}

function DecisionCard({ decision }: { decision: Decision }) {
  return (
    <div className="decision-card">
      <header>
        <div className="row gap">
          <strong>{decision.title}</strong>
          <code className="muted small">{decision.source}</code>
        </div>
        {decision.affects.length > 0 && (
          <div className="muted small">
            Affects: {decision.affects.join(', ')}
          </div>
        )}
      </header>
      <table className="decision-table">
        <thead>
          <tr>
            <th style={{ width: 24 }}>#</th>
            <th>Conditions</th>
            <th style={{ width: 200 }}>Output</th>
          </tr>
        </thead>
        <tbody>
          {decision.rows.map((row, idx) => (
            <tr key={idx}>
              <td>{idx + 1}</td>
              <td>
                <ul className="cond-list">
                  {row.conditions.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                  {row.conditions.length === 0 && <li className="muted">(always)</li>}
                </ul>
              </td>
              <td>
                <code>{row.output}</code>
              </td>
            </tr>
          ))}
          {decision.otherwise !== undefined && (
            <tr className="otherwise-row">
              <td colSpan={2} style={{ textAlign: 'right' }}>
                <strong>otherwise</strong>
              </td>
              <td>
                <code>{decision.otherwise}</code>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ----------------------- Data loading ----------------------- */

async function loadAllDecisions(): Promise<Decision[]> {
  const out: Decision[] = [];

  // Forms (XLSForm context expressions + calculations).
  const forms = await api.listForms();
  for (const f of forms.forms) {
    try {
      const res = await api.getForm(f.id);
      // Context expression.
      const props = res.properties as
        | { context?: { expression?: string; person?: boolean; place?: boolean }; title?: Array<{ locale: string; content: string }> }
        | null;
      const title =
        (props?.title?.find((t) => t.locale === 'en')?.content ?? props?.title?.[0]?.content) ?? f.filename;
      if (props?.context?.expression && f.category === 'app') {
        const expr = props.context.expression;
        const parsed = parseContextExpression(expr);
        out.push({
          id: `form-ctx:${f.id}`,
          category: 'form_context',
          title: `Show form: "${title}"`,
          source: `${f.filename.replace(/\.xlsx$/, '')}.properties.json`,
          affects: [f.filename],
          rows: [
            {
              conditions: parsed.rules.length > 0 ? parsed.rules.map(contextRuleHumanReadable) : [],
              output: expr === 'false' ? 'never' : 'show form',
            },
          ],
        });
      }
      // Per-row calculations.
      for (const row of res.form.survey) {
        const calc = row.extras['calculation'];
        if (!calc) continue;
        const parsed = parseCalculation(calc);
        if (parsed.shape === 'decision_table' && parsed.rules.length > 0) {
          out.push({
            id: `calc:${f.id}:${row.rowId}`,
            category: 'calculation',
            title: `Compute "${row.name}"`,
            source: `${f.filename} → row ${row.name}`,
            affects: [f.filename],
            rows: parsed.rules.map((r) => ({
              conditions: relevantToHumanLines(r.condition),
              output: r.output,
            })),
            otherwise: parsed.otherwise,
          });
        }
      }
    } catch {
      // skip broken forms — they show in the form editor's error banner instead
    }
  }

  // Contact summary helpers + flags.
  try {
    const cs = await api.getContactSummaryFiles();
    const extras = cs['contact-summary.extras.js'];
    if (extras) {
      const parsed = parseHelpers(extras);
      for (const h of parsed.helpers) {
        // Treat any helper that returns boolean as an eligibility predicate.
        const appliesParsed = parseAppliesIf(`function (${h.params.join(', ')}) {${h.body}}`);
        out.push({
          id: `helper:${h.name}`,
          category: 'eligibility',
          title: h.name,
          source: 'contact-summary.extras.js',
          affects: [],
          rows: [
            {
              conditions: appliesParsed.rules.map(appliesIfRuleHumanReadable),
              output: 'true (eligible)',
            },
          ],
          otherwise: 'false (not eligible)',
        });
      }
    }
    const templated = cs['contact-summary.templated.js'];
    if (templated) {
      const ctx = parseContactSummary(templated);
      for (const name of ctx.contextOrder) {
        out.push({
          id: `flag:${name}`,
          category: 'context_flag',
          title: `summary.${name}`,
          source: 'contact-summary.templated.js',
          affects: [],
          rows: [{ conditions: [`Computed by: ${ctx.contextFlags[name]?.slice(0, 80)}…`], output: 'boolean' }],
        });
      }
    }
  } catch {
    /* ignore */
  }

  // Tasks.
  try {
    const tasksFiles = await api.getTaskFiles();
    const src = tasksFiles['tasks.js'];
    if (src) {
      const parsed = parseTaskFile(src);
      for (const entry of parsed.entries) {
        const nameField = entry.fields['name'];
        const taskName =
          nameField && nameField.kind === 'string' ? nameField.value : '(unnamed task)';
        const titleField = entry.fields['title'];
        const titleStr =
          titleField && titleField.kind === 'string' ? titleField.value : taskName;
        const appliesIfRaw =
          entry.fields['appliesIf'] && entry.fields['appliesIf'].kind === 'function'
            ? entry.fields['appliesIf'].raw
            : null;
        if (appliesIfRaw) {
          const parsedAI = parseAppliesIf(appliesIfRaw);
          out.push({
            id: `task-fires:${taskName}`,
            category: 'task_fires',
            title: `Task fires: "${titleStr}"`,
            source: `tasks.js → ${taskName}`,
            affects: actionsToFormNames(entry.fields['actions']),
            rows: [
              {
                conditions: parsedAI.rules.map(appliesIfRuleHumanReadable),
                output: 'task is created',
              },
            ],
          });
        }
        const resolvedRaw =
          entry.fields['resolvedIf'] && entry.fields['resolvedIf'].kind === 'function'
            ? entry.fields['resolvedIf'].raw
            : null;
        if (resolvedRaw) {
          out.push({
            id: `task-resolves:${taskName}`,
            category: 'task_resolves',
            title: `Task resolves: "${titleStr}"`,
            source: `tasks.js → ${taskName}`,
            affects: [],
            rows: [
              {
                conditions: ['Follow-up form submitted within event window'],
                output: 'task closes',
              },
            ],
          });
        }
      }
    }
  } catch {
    /* ignore */
  }

  return out;
}

function actionsToFormNames(field: { kind: string; raw?: string; value?: unknown } | undefined): string[] {
  if (!field || field.kind !== 'array' || !field.raw) return [];
  const raw = field.raw;
  const out: string[] = [];
  const re = /form:\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) if (m[1]) out.push(m[1]);
  return out;
}

/* ---------------- human-readable rule formatting ---------------- */

function contextRuleHumanReadable(r: ContextRule): string {
  switch (r.kind) {
    case 'is_true':
      return 'Always';
    case 'is_false':
      return 'Never';
    case 'contact_type':
      return `Contact type is "${r.value}"`;
    case 'contact_contact_type':
      return `Contact type is "${r.value}"`;
    case 'contact_sex':
      return `Sex is "${r.value}"`;
    case 'contact_field':
      return `contact.${r.field} ${opSym(r.op)} ${isEqOp(r.op) ? `"${r.value}"` : r.value}`;
    case 'age_years':
      return `Age in years ${r.op} ${r.value}`;
    case 'summary_flag':
      return `${r.negated ? 'NOT ' : ''}summary.${r.flag}`;
    case 'not_muted':
      return 'Not muted';
    case 'not_deceased':
      return 'Not deceased';
    case 'raw':
      return r.text;
  }
}

function isEqOp(op: string): boolean {
  return op === '===' || op === '!==';
}
function opSym(op: string): string {
  switch (op) {
    case '===': return '=';
    case '!==': return '≠';
    case '>=': return '≥';
    case '<=': return '≤';
    default: return op;
  }
}

function appliesIfRuleHumanReadable(r: AppliesIfRule): string {
  switch (r.kind) {
    case 'is_task_user':
      return 'User is a task user';
    case 'is_alive':
      return r.negated ? 'Contact is NOT alive' : 'Contact is alive';
    case 'is_muted':
      return r.negated ? 'Contact is not muted' : 'Contact is muted';
    case 'has_error':
      return r.negated ? 'Report has no error' : 'Report has error';
    case 'helper':
      return `${r.negated ? 'NOT ' : ''}${r.name}(…)`;
    case 'contact_field':
      return `contact.contact.${r.field} ${opSym(r.op)} ${isEqOp(r.op) ? `"${r.value}"` : r.value}`;
    case 'report_field':
      return `Report field "${r.field}" ${opSym(r.op)} ${isEqOp(r.op) ? `"${r.value}"` : r.value}`;
    case 'report_field_includes':
      return `Report field "${r.field}" ${r.negated ? 'does not include' : 'includes'} "${r.value}"`;
    case 'field_presence': {
      const ref = r.source === 'report' ? `Report field "${r.field}"` : `Contact field "${r.field}"`;
      return `${ref} ${r.negated ? 'is NOT set' : 'is set'}`;
    }
    case 'field_age': {
      const ref = r.source === 'report' ? `Report field "${r.field}"` : `Contact field "${r.field}"`;
      return `${ref} age ${opSym(r.op)} ${r.value} ${r.unit}`;
    }
    case 'field_age_between': {
      const ref = r.source === 'report' ? `Report field "${r.field}"` : `Contact field "${r.field}"`;
      return `${ref} age between ${opSym(r.minOp)} ${r.min} and ${opSym(r.maxOp)} ${r.max} ${r.unit}`;
    }
    case 'raw':
      return r.text;
  }
}

function relevantToHumanLines(cond: import('@cht-ui/shared').ParsedExpression): string[] {
  if (cond.rules.length === 0) return [];
  return cond.rules.map((r) => {
    switch (r.kind) {
      case 'comparison': {
        const v = r.valueIsString ? `"${r.value}"` : r.value;
        return `${r.field} ${r.op === '=' ? '=' : r.op} ${v}`;
      }
      case 'selected':
        return `${r.negated ? 'NOT ' : ''}${r.field} includes "${r.value}"`;
      case 'answered':
        return r.negated ? `${r.field} is empty` : `${r.field} is answered`;
      case 'truthy':
        return r.negated ? `${r.field} is not selected` : `${r.field} has an answer`;
      case 'expr-comparison':
      case 'predicate':
      case 'not-group':
        // T9a — rules about the answer itself; shown as written until 9e
        // gives them presets.
        return serializeRule(r);
      case 'always-true':
        return 'always passes (no rule)';
      case 'age':
        return `age of ${r.field} ${r.op} ${r.value} years`;
      case 'date_offset':
        return `${r.field} is ${r.comparator === 'more_than' ? 'more than' : 'less than'} ${r.amount} ${r.unit} ${r.direction === 'ago' ? 'ago' : 'from now'}`;
      case 'contact-input-comparison': {
        // Phase 1b — make the cross-form source explicit in the audit
        // trail (MOH sign-off readers need to know the value came from
        // the contact, not from a form answer).
        const v = r.valueIsString ? `"${r.value}"` : r.value;
        return `contact.${r.field} ${r.op} ${v}`;
      }
      case 'contact-summary-comparison': {
        const v = r.valueIsString ? `"${r.value}"` : r.value;
        const lhs =
          r.wrapper === 'read-once'
            ? `once(summary.${r.contextKey})`
            : r.wrapper === 'fallback-to-current'
              ? `summary.${r.contextKey} (fallback to current)`
              : `summary.${r.contextKey}`;
        return `${lhs} ${r.op} ${v}`;
      }
      case 'raw':
        return r.text;
    }
  });
}

function groupBy<T>(arr: T[], key: (t: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of arr) {
    const k = key(item);
    if (!out[k]) out[k] = [];
    out[k]!.push(item);
  }
  return out;
}
