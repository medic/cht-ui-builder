/**
 * docs/NEXT.md item 8 — task-title translation-key derivation.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  deriveTaskTitleKey,
  looksLikeTranslationKey,
  slugifyTaskName,
} from './taskTitleKey.js';

test('derives the CHT convention task.<name>.title', () => {
  assert.deepEqual(deriveTaskTitleKey('Eye follow-up'), {
    key: 'task.eye-follow-up.title',
    collided: false,
  });
});

test('task names slug to hyphens, matching cht-default style', () => {
  assert.equal(slugifyTaskName('ANC follow up'), 'anc-follow-up');
  assert.equal(slugifyTaskName('already-hyphenated'), 'already-hyphenated');
  // The underscore→hyphen swap is the whole point of not reusing the raw slug.
  assert.equal(slugifyTaskName('snake_case_name'), 'snake-case-name');
});

test('collision suffixes the NAME segment, never after .title', () => {
  // `task.eye-check.title_2` would read as a different FIELD to CHT, not a
  // second title, so the suffix has to land on the name.
  const out = deriveTaskTitleKey('Eye check', ['task.eye-check.title']);
  assert.deepEqual(out, { key: 'task.eye-check-2.title', collided: true });
  assert.equal(/\.title$/.test(out.key), true, 'trailing segment stays .title');
});

test('collision walks past consecutive suffixes', () => {
  const out = deriveTaskTitleKey('Eye check', [
    'task.eye-check.title',
    'task.eye-check-2.title',
  ]);
  assert.equal(out.key, 'task.eye-check-3.title');
});

test('an unrelated taken key does not trigger a suffix', () => {
  const out = deriveTaskTitleKey('Eye check', ['task.other.title', 'Messages']);
  assert.deepEqual(out, { key: 'task.eye-check.title', collided: false });
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
