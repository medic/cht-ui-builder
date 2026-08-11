/**
 * Translation-key derivation for task titles (docs/NEXT.md item 8, spec
 * docs/handoff-argpreserve-and-translations-2026-08-06.md §2 REVISED).
 *
 * A task title in `tasks.js` is a TRANSLATION KEY; the human strings live in
 * `translations/messages-<locale>.properties`. The no-code contract is that
 * the author types the strings and never sees the key, so the key has to be
 * derived — the same "identifiers are auto-derived, never typed" rule that
 * already governs form filenames, choice names and hierarchy ids.
 *
 * CHT convention is `task.<name>.title`. The WORD SEPARATOR inside a segment
 * is NOT ours to choose: measured across the four real configs on disk
 * (gandaki, lumbini, moh-nepal, nssd), underscore beats hyphen 69 to 1, and
 * ZERO of the 42 real task-title keys contain a hyphen — the shapes are
 * `task.delivery_confirmation.title`, `task.pnc_visit.title`,
 * `task.anc.pregnancy_home_visit.title`. So the separator is DERIVED from
 * whatever the project already uses and only falls back to `_` when the
 * project offers no evidence (docs/principle-config-agnostic.md, posture 2).
 *
 * The trailing `.title` IS a deliberate constant, not an undiscovered one:
 * it is the only thing distinguishing a task's title key from its
 * `priority_label` key, so dropping it would be lossy. (NSSD omits it on 23
 * of 29 keys; those keys are ambiguous, and copying that is not an
 * improvement.)
 */
import { slugifyHierarchyId } from '../hierarchy/buildLinearHierarchy.js';

/**
 * Shape of a string that is a translation KEY rather than a literal title.
 * Deliberately permissive about case and separators (real configs carry
 * `task.foo.title`, `targets.bar.subtitle`, `contact.type.person.plural`)
 * but it MUST contain at least one dot, which is what separates a key from
 * a human sentence like "Follow up with the patient".
 */
export const TRANSLATION_KEY_RE = /^[A-Za-z][\w-]*(?:\.[\w-]+)+$/;

/** True when `title` looks like a translation key rather than a literal. */
export function looksLikeTranslationKey(title: string): boolean {
  return TRANSLATION_KEY_RE.test(title.trim());
}

/**
 * The word separator a project uses inside key/name segments, inferred from
 * strings it already contains. Pass task names, title keys, or both.
 *
 * Counts segment-by-segment so `task.anc.pregnancy_home_visit.title` votes
 * once for `_`, not three times. Ties and no-evidence both resolve to `_`,
 * which is what all four real configs and our own cht-default scaffold use.
 */
export function inferTaskSeparator(samples: readonly string[]): '_' | '-' {
  let underscore = 0;
  let hyphen = 0;
  for (const s of samples) {
    for (const seg of s.split('.')) {
      if (seg.includes('_')) underscore++;
      if (seg.includes('-')) hyphen++;
    }
  }
  return hyphen > underscore ? '-' : '_';
}

/**
 * Slugify a task name into one key/name segment. `slugifyHierarchyId`
 * produces underscores; `separator` re-spells them if the project prefers
 * hyphens.
 */
export function slugifyTaskName(name: string, separator: '_' | '-' = '_'): string {
  const slug = slugifyHierarchyId(name);
  return separator === '_' ? slug : slug.replace(/_/g, separator);
}

export interface DerivedTitleKey {
  /** The key to write into `tasks.js` (`task.<slug>.title`). */
  key: string;
  /** True when a numeric suffix was appended to avoid a collision. */
  collided: boolean;
}

/**
 * Derive `task.<slug(name)>.title` for a task, avoiding collisions with keys
 * already defined in the project.
 *
 * The suffix goes on the NAME segment (`task.eye-check-2.title`), not after
 * `.title` — CHT reads the trailing segment as the field, so
 * `task.eye-check.title_2` would be a different (meaningless) field rather
 * than a second title.
 *
 * @param taskName the task's `name` field (friendly or already-slugged)
 * @param takenKeys every key already defined in any locale file. Matched
 *                  case-sensitively — .properties keys are case-sensitive.
 *                  ALSO the evidence the separator is inferred from.
 * @param samples   extra strings to infer the separator from (e.g. the
 *                  project's existing task `name`s, which are often the
 *                  better evidence — a project may define no title keys yet
 *                  while already having tasks).
 * @returns `{ key: '', collided: false }` when the name yields no slug
 *          (e.g. all non-ASCII), so the caller can prompt instead of
 *          writing `task..title`.
 */
export function deriveTaskTitleKey(
  taskName: string,
  takenKeys: readonly string[] = [],
  samples: readonly string[] = [],
): DerivedTitleKey {
  // Only `task.*` keys are evidence about TASK naming style; a project's
  // `contact.type.*` or SMS keys say nothing about it.
  const evidence = [...takenKeys.filter((k) => k.startsWith('task.')), ...samples];
  const sep = inferTaskSeparator(evidence);
  const slug = slugifyTaskName(taskName, sep);
  if (!slug) return { key: '', collided: false };
  const taken = new Set(takenKeys);
  const base = `task.${slug}.title`;
  if (!taken.has(base)) return { key: base, collided: false };
  for (let i = 2; i < 1000; i++) {
    // The suffix uses the project's separator too.
    const candidate = `task.${slug}${sep}${i}.title`;
    if (!taken.has(candidate)) return { key: candidate, collided: true };
  }
  return { key: base, collided: true };
}
