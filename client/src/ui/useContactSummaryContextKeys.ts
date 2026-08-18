/**
 * The context keys available to any app form's XForm expressions via
 * `instance('contact-summary')/context/<key>`, loaded once per session.
 *
 * Mirrors `useContactFormFields`: module-level cache + inflight promise +
 * subscriber set, so multiple FormEditor mounts share one fetch.
 *
 * ## Why this stopped parsing one file itself
 *
 * It used to fetch `contact-summary.templated.js` and run
 * `parseContactSummary` on it. On config-nssd/chis that produced ZERO keys
 * where there are about seventy, because line 18 of that file is
 * `const context = getContext(thisContact, allReports)` — the keys live in
 * the extras file, and the detector only recognised a literal. Four separate
 * causes could produce the same silent empty list, and the blanket `catch`
 * made all four indistinguishable from "this config computes nothing".
 *
 * Now the server does a three-channel scan (form calculations, form
 * eligibility, static definition scan) and returns per-key detail plus an
 * explicit statement of what it could NOT see. Measured through the route:
 * nssd 70, lumbini 39, cht-default 14, gandaki 9.
 *
 * The templated-file parse is still done here, but only for its original
 * second job — recognising the cross-form bridge IIFE that our own Context
 * values tab emits, which needs the literal's right-hand side.
 *
 * Used by `SingleValuePanel`'s "Contact-summary value" reference kind
 * (plan docs/plans/calc-reference-builder.md Tier 1.5) and by
 * docs/plans/pick-preexisting-context-values.md.
 */
import { useEffect, useState } from 'react';
import {
  parseContactSummary,
  recognizeContextValueBridge,
  type ContextKeyInfo,
  type ContextWrapper,
  type IndeterminateNote,
} from '@cht-ui/shared';
import { api } from '../api.js';
import { useApp } from '../state/store.js';

/**
 * A single context-value bridge exposed to the calc-side picker's
 * "From another form (via contact summary)" source group. Wave 3 · Note 6.
 */
export interface ContextBridgeKey {
  /** The context key (e.g. `bmi`). */
  key: string;
  /** Form basename the bridge reads from (e.g. `diabetes_screening`). */
  sourceForm: string;
  /** Field path within the source form's report (e.g. `bmi`). */
  sourceField: string;
}

/**
 * Everything the pickers need to offer pre-existing context values.
 *
 * `keys` stays a plain `string[]` so existing consumers are untouched; the
 * richer per-key detail rides alongside in `scan`.
 */
interface Snapshot {
  keys: string[];
  bridges: ContextBridgeKey[];
  /**
   * The full three-channel scan (form calculations + form eligibility +
   * static definition scan), ranked most-used first. `null` when the
   * server route is unavailable — distinct from "scanned and found none",
   * which is the distinction today's zero-keys bug fails to make.
   */
  scan: ContextKeyScan | null;
}

export interface ContextKeyScan {
  keys: ContextKeyInfo[];
  indeterminate: IndeterminateNote[];
  /** False ⇒ we could not find the context object at all, not "it's empty". */
  definitionsFound: boolean;
  /** Contact-summary files the scan actually read, whatever they're called. */
  summaryFiles: string[];
  /** Forms whose workbook could not be parsed, so their reads are missing. */
  unreadableForms: string[];
  /** The wrapper idiom this project already uses; null when no evidence. */
  houseWrapper: ContextWrapper | null;
}

let cache: Snapshot | null = null;
let inflight: Promise<Snapshot> | null = null;
let cacheKey: string | null = null;
const subscribers = new Set<(v: Snapshot) => void>();

/**
 * The cached snapshot, but ONLY if it belongs to `projectPath`.
 *
 * Switching project is a plain `setProject` with no reload, so this module's
 * state survives it. Seeding component state from `cache` without checking
 * whose it is meant a form opened just after a switch could be offered the
 * PREVIOUS project's context keys — and the wrapper marked "this config's
 * usual style" was the previous config's too. A key picked in that window
 * wrote a reference the new project does not define.
 */
function snapshotFor(projectPath: string): Snapshot | null {
  return cacheKey === projectPath ? cache : null;
}

async function loadSnapshot(): Promise<Snapshot> {
  // Two independent requests. The bridges list needs the templated file's
  // own `context` literal (it recognises the reports-scan IIFE our own
  // Context-values tab emits), while the key list needs the three-channel
  // scan. Neither failing may take the other down, and neither may take the
  // picker down — it degrades to free-type, never errors.
  const [scan, bridges] = await Promise.all([loadScan(), loadBridges()]);
  // Prefer the scan's ranked union; fall back to whatever the templated-file
  // parse found, so an older/absent route still yields the old behaviour.
  const keys = scan ? scan.keys.map((k) => k.key) : bridges.fallbackKeys;
  return { keys, bridges: bridges.bridges, scan };
}

async function loadScan(): Promise<ContextKeyScan | null> {
  try {
    const res = await api.getContactSummaryContextKeys();
    return {
      keys: res.keys,
      indeterminate: res.indeterminate,
      definitionsFound: res.definitionsFound,
      summaryFiles: res.summaryFiles ?? [],
      unreadableForms: res.unreadableForms ?? [],
      houseWrapper: res.houseWrapper ?? null,
    };
  } catch {
    return null;
  }
}

async function loadBridges(): Promise<{
  bridges: ContextBridgeKey[];
  fallbackKeys: string[];
}> {
  try {
    const files = await api.getContactSummaryFiles();
    const src = files['contact-summary.templated.js'];
    if (!src) return { bridges: [], fallbackKeys: [] };
    const parsed = parseContactSummary(src);
    const bridges: ContextBridgeKey[] = [];
    for (const key of parsed.contextOrder) {
      const expr = parsed.contextFlags[key] ?? '';
      const b = recognizeContextValueBridge(expr);
      if (b) bridges.push({ key, sourceForm: b.sourceForm, sourceField: b.sourceField });
    }
    return { bridges, fallbackKeys: parsed.contextOrder };
  } catch {
    return { bridges: [], fallbackKeys: [] };
  }
}

function subscribeToSnapshot(
  projectPath: string,
  notify: (v: Snapshot) => void,
): () => void {
  if (!projectPath) {
    notify({ keys: [], bridges: [], scan: null });
    return () => {};
  }
  // ALWAYS register the subscriber — even on a warm cache — so a later
  // `invalidateContactSummaryContextKeys()` reaches every mounted hook.
  // The previous early-return left warm-cache subscribers unregistered,
  // which is why the calc builder showed stale "No cross-form values"
  // until a full reload (audit P1-4).
  let alive = true;
  const wrapped = (v: Snapshot) => {
    if (alive) notify(v);
  };
  subscribers.add(wrapped);
  if (cache && cacheKey === projectPath) {
    notify(cache);
  } else if (!inflight || cacheKey !== projectPath) {
    cacheKey = projectPath;
    const loadingFor = projectPath;
    inflight = loadSnapshot().then((out) => {
      // Only commit if this is still the open project. The route parses every
      // workbook, so a slow scan for the project the user just left could
      // otherwise land on top of the new one's.
      if (cacheKey !== loadingFor) return out;
      cache = out;
      for (const fn of subscribers) fn(out);
      inflight = null;
      return out;
    });
  }
  return () => {
    alive = false;
    subscribers.delete(wrapped);
  };
}

/**
 * Drop the cached snapshot and re-fetch, notifying every mounted hook.
 * Call after any write to `contact-summary.templated.js` (the Contact
 * Summary editor's save) so the calc builder's "From another form"
 * picker reflects newly defined context values without a full reload —
 * the feature's own empty-state → deep-link → define → back loop
 * depends on this (audit P1-4). Mirrors `parsedFormCache.invalidate`.
 */
export function invalidateContactSummaryContextKeys(): void {
  cache = null;
  cacheKey = null;
  inflight = null;
  // Re-fetch eagerly so already-mounted consumers update in place.
  inflight = loadSnapshot().then((out) => {
    cache = out;
    for (const fn of subscribers) fn(out);
    inflight = null;
    return out;
  });
}

/**
 * The full three-channel scan, for surfaces that want usage counts, the
 * conditional marker, or the honesty banner. `null` until loaded / when the
 * route is unavailable.
 */
export function useContextKeyScan(): ContextKeyScan | null {
  const projectPath = useApp((s) => s.project?.path ?? '');
  // snapshotFor, not `cache` — see its doc. Seeding from another project's
  // cache offered that project's keys until the new scan resolved.
  const [scan, setScan] = useState<ContextKeyScan | null>(
    () => snapshotFor(useApp.getState().project?.path ?? '')?.scan ?? null,
  );
  useEffect(() => subscribeToSnapshot(projectPath, (snap) => setScan(snap.scan)), [projectPath]);
  return scan;
}

export function useContactSummaryContextKeys(): string[] {
  const projectPath = useApp((s) => s.project?.path ?? '');
  const [keys, setKeys] = useState<string[]>(
    () => snapshotFor(useApp.getState().project?.path ?? '')?.keys ?? [],
  );
  useEffect(() => subscribeToSnapshot(projectPath, (snap) => setKeys(snap.keys)), [projectPath]);
  return keys;
}

/**
 * Wave 3 · Note 6 — the calc-side "From another form (via contact summary)"
 * picker source group's dropdown data. Returns the subset of context keys
 * whose value in `contact-summary.templated.js` is the canonical
 * self-contained reports-scan IIFE the Contact Summary editor's
 * "Context values" sub-tab emits (or its legacy Utils-based predecessor).
 * Consumers use `.key` as the argument to
 * `emitContactSummary(key, 'fallback-to-current')` and display the
 * source form + field as human-readable context.
 */
export function useContactSummaryBridgeKeys(): ContextBridgeKey[] {
  const projectPath = useApp((s) => s.project?.path ?? '');
  const [bridges, setBridges] = useState<ContextBridgeKey[]>(
    () => snapshotFor(useApp.getState().project?.path ?? '')?.bridges ?? [],
  );
  useEffect(
    () => subscribeToSnapshot(projectPath, (snap) => setBridges(snap.bridges)),
    [projectPath],
  );
  return bridges;
}
