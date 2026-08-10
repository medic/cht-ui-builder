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
 * CHT convention is `task.<name>.title` (cht-default uses hyphenated task
 * names, e.g. `task.anc-follow-up.title`).
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
 * Slugify a task name the way `TasksEditor`'s name field does: the shared
 * hierarchy slugify, then `_` → `-` to match cht-default's task-id style.
 */
export function slugifyTaskName(name: string): string {
  return slugifyHierarchyId(name).replace(/_/g, '-');
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
 * @returns `{ key: '', collided: false }` when the name yields no slug
 *          (e.g. all non-ASCII), so the caller can prompt instead of
 *          writing `task..title`.
 */
export function deriveTaskTitleKey(
  taskName: string,
  takenKeys: readonly string[] = [],
): DerivedTitleKey {
  const slug = slugifyTaskName(taskName);
  if (!slug) return { key: '', collided: false };
  const taken = new Set(takenKeys);
  const base = `task.${slug}.title`;
  if (!taken.has(base)) return { key: base, collided: false };
  for (let i = 2; i < 1000; i++) {
    const candidate = `task.${slug}-${i}.title`;
    if (!taken.has(candidate)) return { key: candidate, collided: true };
  }
  return { key: base, collided: true };
}
