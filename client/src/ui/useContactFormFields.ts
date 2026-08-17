/**
 * Load every contact-category form in the current project once and return a
 * pick-list of field names appropriate for `contact.X` comparisons.
 *
 * Plumbing rows are filtered out — `calculate`, `hidden`, `note`, media,
 * geopoint, barcode types and any name beginning with `_` or matching the
 * well-known XLSForm meta field names. Otherwise a form author would see
 * `_id`, `source`, `parent`, `__start` in the dropdown and have no idea
 * which one is "patient name".
 */
import { useEffect, useState } from 'react';
import { isPlaceholderFormFile } from '@cht-ui/shared';
import { api } from '../api.js';
import { useApp } from '../state/store.js';
import type { ContactFormFields } from './FieldPicker.js';

const INPUT_TYPES = new Set([
  'text',
  'string',
  'integer',
  'decimal',
  'date',
  'time',
  'datetime',
  'select_one',
  'select_multiple',
]);

const META_FIELDS = new Set([
  'source',
  'source_id',
  'parent',
  'meta',
  'start',
  'end',
  'today',
  'deviceid',
  'instanceid',
  'phone',
  'simserial',
  'subscriberid',
]);

// Module-level cache: loading contact-form field lists is expensive
// (one XLSX parse per form, server-side). Project may have 30+ contact forms,
// so we load once per session and share across every FormEditor mount.
let cache: ContactFormFields[] | null = null;
let inflight: Promise<ContactFormFields[]> | null = null;
let cacheKey: string | null = null;
const subscribers = new Set<(v: ContactFormFields[]) => void>();

function keyFor(ids: string[]): string {
  return ids.slice().sort().join('|');
}

async function loadAll(entries: Array<{ id: string }>): Promise<ContactFormFields[]> {
  // Serial fetch to avoid pegging the single-threaded server with 30+
  // concurrent XLSX parses. Each form is small; total latency is acceptable
  // and other requests (like the one the user actually clicked) stay snappy.
  const out: ContactFormFields[] = [];
  for (const f of entries) {
    // Skip cht-conf's place-type SCAFFOLD. `PLACE_TYPE-create.xlsx` is not a
    // contact form — the token is substituted when a place type is added, and
    // it is the only contact form cht-conf never compiles. Its placeholder
    // questions contributed 18 field names on gandaki and 14 on our own
    // cht-default template that exist on no real contact
    // (`custom_place_name_label_translator`, `generated_name_translation_temp`,
    // …). That got worse once picking a contact field started DECLARING it:
    // picking a phantom would write a real-looking inputs/contact node for a
    // field no contact has. See shared/src/xlsform/placeholderForms.ts.
    if (isPlaceholderFormFile(f.id)) continue;
    try {
      const res = await api.getForm(f.id);
      const fields = res.form.survey
        .filter((r) => {
          if (!r.name) return false;
          const lc = r.name.toLowerCase();
          if (lc.startsWith('_')) return false;
          if (META_FIELDS.has(lc)) return false;
          const t = r.type.trim().toLowerCase().replace(/\s+/g, '_');
          if (!INPUT_TYPES.has(t)) return false;
          return true;
        })
        .map((r) => r.name);
      if (fields.length > 0) {
        out.push({ label: f.id.replace(/^contact:/, ''), fields });
      }
    } catch {
      /* non-fatal — picker just won't include this form */
    }
  }
  return out;
}

export function useContactFormFields(): ContactFormFields[] {
  const formsList = useApp((s) => s.forms);
  const [contactForms, setContactForms] = useState<ContactFormFields[]>(cache ?? []);

  useEffect(() => {
    const entries = formsList.filter((f) => f.category === 'contact');
    if (entries.length === 0) {
      setContactForms([]);
      return;
    }
    const key = keyFor(entries.map((e) => e.id));
    if (cache && cacheKey === key) {
      setContactForms(cache);
      return;
    }
    let alive = true;
    const notify = (v: ContactFormFields[]) => {
      if (alive) setContactForms(v);
    };
    subscribers.add(notify);

    if (!inflight || cacheKey !== key) {
      cacheKey = key;
      inflight = loadAll(entries).then((out) => {
        cache = out;
        for (const fn of subscribers) fn(out);
        inflight = null;
        return out;
      });
    }

    return () => {
      alive = false;
      subscribers.delete(notify);
    };
  }, [formsList]);

  return contactForms;
}
