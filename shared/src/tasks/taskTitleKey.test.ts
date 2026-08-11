/**
 * docs/NEXT.md item 8 — task-title translation-key derivation.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  deriveTaskTitleKey,
  inferTaskSeparator,
  looksLikeTranslationKey,
  slugifyTaskName,
} from './taskTitleKey.js';

test('derives the CHT convention task.<name>.title, UNDERSCORE by default', () => {
  // docs/principle-config-agnostic.md: zero of the 42 real task-title keys
  // across gandaki/lumbini/nssd contain a hyphen; underscore beats hyphen
  // 69 to 1 across their names and keys. A no-evidence project therefore
  // gets underscore, not the kebab we used to hardcode.
  assert.deepEqual(deriveTaskTitleKey('Eye follow-up'), {
    key: 'task.eye_follow_up.title',
    collided: false,
  });
});

test('slugifyTaskName defaults to underscore and re-spells only on request', () => {
  assert.equal(slugifyTaskName('ANC follow up'), 'anc_follow_up');
  assert.equal(slugifyTaskName('ANC follow up', '-'), 'anc-follow-up');
  assert.equal(slugifyTaskName('snake_case_name'), 'snake_case_name');
});

test('collision suffixes the NAME segment, never after .title', () => {
  // `task.eye_check.title_2` would read as a different FIELD to CHT, not a
  // second title, so the suffix has to land on the name.
  const out = deriveTaskTitleKey('Eye check', ['task.eye_check.title']);
  assert.deepEqual(out, { key: 'task.eye_check_2.title', collided: true });
  assert.equal(/\.title$/.test(out.key), true, 'trailing segment stays .title');
});

test('collision walks past consecutive suffixes', () => {
  const out = deriveTaskTitleKey('Eye check', [
    'task.eye_check.title',
    'task.eye_check_2.title',
  ]);
  assert.equal(out.key, 'task.eye_check_3.title');
});

test('an unrelated taken key does not trigger a suffix', () => {
  const out = deriveTaskTitleKey('Eye check', ['task.other.title', 'Messages']);
  assert.deepEqual(out, { key: 'task.eye_check.title', collided: false });
});

/* ===== config-agnosticism: DERIVE the separator from the project =====
 * Synthetic fixtures distilled from the four real configs — deliberately NOT
 * the customer files themselves (QA rider, 2026-08-11). Each one is a shape
 * that disagrees with what we used to hardcode.
 */

test('gandaki/nssd shape (snake_case keys) → underscore', () => {
  const keys = [
    'task.delivery_confirmation.title',
    'task.pnc_visit.title',
    'task.anc.pregnancy_home_visit.title',
  ];
  assert.equal(inferTaskSeparator(keys), '_');
  assert.equal(deriveTaskTitleKey('Eye check', keys).key, 'task.eye_check.title');
});

test('a kebab-case project → the editor ADOPTS hyphen', () => {
  // The point of deriving: a project that really does use kebab gets kebab,
  // without us hardcoding a second constant.
  const keys = ['task.home-visit.title', 'task.danger-sign.title', 'task.follow-up.title'];
  assert.equal(inferTaskSeparator(keys), '-');
  const out = deriveTaskTitleKey('Eye check', keys);
  assert.equal(out.key, 'task.eye-check.title');
  // …and so does the collision suffix.
  assert.equal(deriveTaskTitleKey('Home visit', keys).key, 'task.home-visit_2.title'.replace('_', '-'));
});

test('lumbini shape (mostly snake, ONE hyphenated name) → majority wins', () => {
  // lumbini has `immunization-report` among otherwise-underscored names.
  const names = [
    'anc.pregnancy_home_visit.known_lmp',
    'pnc.pnc_visit.known_delivery',
    'immunization-report',
  ];
  assert.equal(inferTaskSeparator(names), '_');
});

test('task NAMES are usable evidence when a project has no title keys yet', () => {
  // A project can carry tasks while defining no translations — the names are
  // then the only evidence available.
  const names = ['home-visit', 'danger-sign-followup'];
  assert.equal(deriveTaskTitleKey('Eye check', [], names).key, 'task.eye-check.title');
});

test('NON-task keys are not evidence about task naming', () => {
  // A project full of `contact.type.*` kebab keys says nothing about how it
  // spells TASK segments.
  const keys = ['contact.type.health-post', 'contact.type.health-post.plural'];
  assert.equal(deriveTaskTitleKey('Eye check', keys).key, 'task.eye_check.title');
});

test('segment-wise counting: a multi-segment key votes once per segment', () => {
  // `task.anc.pregnancy_home_visit.title` must not out-vote three kebab keys
  // just for being long.
  assert.equal(
    inferTaskSeparator(['task.anc.pregnancy_home_visit.title', 'task.a-b.title', 'task.c-d.title']),
    '-',
  );
});

test('a name with no ASCII yields NO key rather than task..title', () => {
  assert.deepEqual(deriveTaskTitleKey('गर्भावस्था'), { key: '', collided: false });
  assert.deepEqual(deriveTaskTitleKey('   '), { key: '', collided: false });
});

test('looksLikeTranslationKey separates keys from human titles', () => {
  for (const key of [
    'task.anc.delivery.title',
    'task.eye-follow-up.title',
    'targets.births.subtitle',
    'contact.type.person.plural',
    'task.overdue',
  ]) {
    assert.equal(looksLikeTranslationKey(key), true, `${key} is a key`);
  }
  for (const literal of [
    'Follow up with the patient',
    'ANC follow-up', // a real literal title: no dot
    '',
    'गर्भवती जाँच',
    // A sentence that ends in a full stop is still a sentence — the space
    // disqualifies it, which is what stops a literal being mistaken for a key.
    'Check the patient. Then refer.',
  ]) {
    assert.equal(looksLikeTranslationKey(literal), false, `${literal} is a literal`);
  }
});
