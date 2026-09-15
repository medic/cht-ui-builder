/**
 * Simplified form preview pane.
 *
 * Renders the survey rows as a stacked vertical layout so the user can
 * sanity-check what they're building. No real form logic (no `relevant`,
 * no `calculation`, no group nesting honored), but field types and labels
 * give a strong "what will the form look like" signal.
 *
 * `hidden` / `calculate` rows render nothing a respondent would ever see, so
 * on calculation-heavy forms they crowd out the actual questions. The header
 * offers a toggle to drop them — and with them any group left holding nothing
 * visible.
 */
import { useMemo, useState } from 'react';
import { isStructural, type SurveyRow, type XLSForm } from '@cht-ui/shared';

interface Props {
  form: XLSForm;
}

export function FormPreview({ form }: Props) {
  const [locale, setLocale] = useState<string>(form.locales[0] ?? 'en');
  const [hideHidden, setHideHidden] = useState(false);
  const layout = useMemo(() => previewLayout(form.survey), [form.survey]);
  const hiddenCount = useMemo(
    () => layout.filter((i) => i.kind === 'field' && isHiddenType(i.row.type)).length,
    [layout],
  );
  const visible = useMemo(
    () =>
      hideHidden
        ? pruneEmptyGroups(
            layout.filter((i) => i.kind !== 'field' || !isHiddenType(i.row.type)),
          )
        : layout,
    [layout, hideHidden],
  );

  if (form.locales.length === 0) {
    return <div className="form-preview muted">No locales found — add a label::xx column.</div>;
  }

  return (
    <div className="form-preview">
      <header className="row gap">
        <strong>Preview</strong>
        <span className="muted">— stacked, no logic</span>
        <span className="row gap">
          {form.locales.map((l) => (
            <button
              key={l}
              className={l === locale ? 'active' : 'link'}
              onClick={() => setLocale(l)}
            >
              {l}
            </button>
          ))}
        </span>
        {hiddenCount > 0 && (
          <label
            className="preview-toggle"
            title="hidden and calculate rows render nothing for the person filling the form in"
          >
            <input
              type="checkbox"
              checked={hideHidden}
              onChange={(e) => setHideHidden(e.target.checked)}
            />
            Hide {hiddenCount} hidden {hiddenCount === 1 ? 'field' : 'fields'}
          </label>
        )}
      </header>
      <div className="preview-body">
        {visible.map((item, idx) => {
          if (item.kind === 'group-header') {
            return (
              <div key={`g-${idx}`} className={`preview-group-header depth-${item.depth}`}>
                {item.row.labels[locale] ?? item.row.name}
              </div>
            );
          }
          if (item.kind === 'group-footer') return null;
          return <PreviewField key={item.row.rowId} row={item.row} locale={locale} />;
        })}
      </div>
    </div>
  );
}

type PreviewItem =
  | { kind: 'group-header'; row: SurveyRow; depth: number }
  | { kind: 'group-footer'; row: SurveyRow; depth: number }
  | { kind: 'field'; row: SurveyRow; depth: number };

/** Rows with no respondent-visible rendering at all. */
function isHiddenType(type: string): boolean {
  const t = type.trim().toLowerCase();
  return t === 'hidden' || t === 'calculate';
}

/**
 * Drop group headers whose body was filtered away. Headers and their footers
 * are pushed at the same depth by `previewLayout`, so a header sitting
 * immediately before its own footer is an empty group. One pass suffices:
 * footers come after their header, so a group emptied by removing a nested
 * group is collapsed by the time its own footer is reached.
 */
function pruneEmptyGroups(items: PreviewItem[]): PreviewItem[] {
  const out: PreviewItem[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (
      item.kind === 'group-footer' &&
      last &&
      last.kind === 'group-header' &&
      last.depth === item.depth
    ) {
      out.pop();
      continue;
    }
    out.push(item);
  }
  return out;
}

function previewLayout(rows: SurveyRow[]): PreviewItem[] {
  const out: PreviewItem[] = [];
  let depth = 0;
  for (const row of rows) {
    const t = row.type.trim().toLowerCase();
    if (t === 'begin group' || t === 'begin repeat') {
      out.push({ kind: 'group-header', row, depth });
      depth++;
    } else if (t === 'end group' || t === 'end repeat') {
      depth = Math.max(0, depth - 1);
      out.push({ kind: 'group-footer', row, depth });
    } else if (!isStructural(row)) {
      out.push({ kind: 'field', row, depth });
    }
  }
  return out;
}

function PreviewField({ row, locale }: { row: SurveyRow; locale: string }) {
  const label = row.labels[locale] ?? row.labels['_'] ?? row.name;
  const type = row.type.trim().toLowerCase();
  return (
    <label className="preview-field">
      <span className="preview-label">
        {label}
        {row.required === 'yes' && <span className="required-star"> *</span>}
        <em className="preview-type"> {type}</em>
      </span>
      <PreviewInput type={type} />
    </label>
  );
}

function PreviewInput({ type }: { type: string }) {
  if (type === 'integer' || type === 'decimal') return <input type="number" disabled />;
  if (type === 'date') return <input type="date" disabled />;
  if (type === 'time') return <input type="time" disabled />;
  if (type === 'dateTime' || type === 'datetime') return <input type="datetime-local" disabled />;
  if (type === 'note') return <p className="preview-note muted">(displayed as a note)</p>;
  if (isHiddenType(type)) return <em className="preview-hidden muted">(hidden)</em>;
  if (type.startsWith('select_one')) {
    return (
      <select disabled>
        <option>— choice —</option>
      </select>
    );
  }
  if (type.startsWith('select_multiple')) {
    return (
      <div className="preview-multi">
        <label><input type="checkbox" disabled /> choice 1</label>
        <label><input type="checkbox" disabled /> choice 2</label>
      </div>
    );
  }
  return <input type="text" disabled />;
}
