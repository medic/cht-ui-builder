/**
 * Unit tests for the pure helpers behind POST /api/deploy/run. We don't
 * spin up Fastify or spawn cht-conf — the goal is to lock the load-bearing
 * shapes (argv construction, credential redaction, request validation,
 * friendly-error translation) so a regression there is caught at CI time
 * instead of surfacing as a leaked password in the streaming log.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  DEPLOY_STEPS,
  buildStepArgs,
  translateStderr,
  validateDeployRunBody,
  type DeployStep,
} from './deploy.js';

const CREDS = { url: 'https://cht.example', user: 'admin', password: 'p@ss w&rd' };

test('DEPLOY_STEPS is the fixed catalog and covers convert + upload for both form kinds', () => {
  assert.deepEqual(
    [...DEPLOY_STEPS],
    [
      'compile-app-settings',
      'convert-app-forms',
      'convert-contact-forms',
      'upload-app-forms',
      'upload-contact-forms',
      'upload-app-settings',
      'upload-resources',
      // W2 — the delivery path for translation strings (task titles).
      'upload-custom-translations',
    ],
  );
});

test('W2 — upload-custom-translations is last, matching cht-conf defaultActions order', () => {
  // cht-conf runs it after upload-resources (src/lib/main.js). Keeping the
  // same relative order means the friendly-error translator and the docs
  // both keep applying.
  assert.equal(DEPLOY_STEPS[DEPLOY_STEPS.length - 1], 'upload-custom-translations');
  assert.ok(
    DEPLOY_STEPS.indexOf('upload-custom-translations') >
      DEPLOY_STEPS.indexOf('upload-resources'),
  );
});

test('buildStepArgs — local step (convert-app-forms) does NOT embed credentials', () => {
  const { args, loggedArgs } = buildStepArgs('convert-app-forms', CREDS);
  assert.deepEqual(args, ['convert-app-forms']);
  assert.deepEqual(loggedArgs, ['convert-app-forms']);
});

test('buildStepArgs — local step (compile-app-settings) does NOT embed credentials', () => {
  const { args, loggedArgs } = buildStepArgs('compile-app-settings', CREDS);
  assert.deepEqual(args, ['compile-app-settings']);
  assert.deepEqual(loggedArgs, ['compile-app-settings']);
});

test('buildStepArgs — upload step embeds --url with url-encoded credentials', () => {
  const { args } = buildStepArgs('upload-app-forms', CREDS);
  // The user/password get percent-encoded so shell metachars survive the
  // Windows shell:true spawn — cht-conf's `new URL(...)` decodes them back.
  const urlArg = args[0]!;
  const action = args[1]!;
  assert.ok(urlArg.startsWith('--url=https://admin:'));
  assert.ok(urlArg.includes('p%40ss%20w%26rd@cht.example'));
  assert.equal(action, 'upload-app-forms');
});

test('buildStepArgs — upload step logged args redact the password to ***', () => {
  const { loggedArgs } = buildStepArgs('upload-app-settings', CREDS);
  const urlArg = loggedArgs[0]!;
  assert.ok(urlArg.startsWith('--url='), 'has --url flag');
  assert.ok(urlArg.includes(':***@'), 'password redacted');
  assert.ok(!urlArg.includes('p%40ss'), 'no percent-encoded password leak');
  assert.ok(!urlArg.includes('p@ss'), 'no raw password leak');
});

test('buildStepArgs — extras append after the action name', () => {
  const { args } = buildStepArgs('upload-app-forms', CREDS, ['--forms=pregnancy']);
  const iAction = args.indexOf('upload-app-forms');
  assert.equal(args[iAction + 1], '--forms=pregnancy');
});

test('buildStepArgs — all upload-* steps get creds; convert-* / compile-* do not', () => {
  const uploads: DeployStep[] = [
    'upload-app-forms',
    'upload-contact-forms',
    'upload-app-settings',
    'upload-resources',
    // W2 — talks to the instance, so it must get URL + credentials.
    'upload-custom-translations',
  ];
  for (const s of uploads) {
    const { args } = buildStepArgs(s, CREDS);
    assert.ok(args[0]?.startsWith('--url='), `${s} has --url`);
  }
  const locals: DeployStep[] = [
    'compile-app-settings',
    'convert-app-forms',
    'convert-contact-forms',
  ];
  for (const s of locals) {
    const { args } = buildStepArgs(s, CREDS);
    assert.equal(args[0], s, `${s} starts with the action name (no --url)`);
  }
});

test('validateDeployRunBody — rejects missing / bad shape', () => {
  assert.equal(validateDeployRunBody(null), 'body must be an object');
  assert.equal(validateDeployRunBody({}), 'url is required');
  assert.equal(
    validateDeployRunBody({ url: 'x' }),
    'user is required',
  );
  assert.equal(
    validateDeployRunBody({ url: 'x', user: 'y' }),
    'password is required',
  );
  assert.equal(
    validateDeployRunBody({ url: 'x', user: 'y', password: 'z' }),
    'steps must be a non-empty array',
  );
  assert.equal(
    validateDeployRunBody({ url: 'x', user: 'y', password: 'z', steps: [] }),
    'steps must be a non-empty array',
  );
  assert.equal(
    validateDeployRunBody({ url: 'x', user: 'y', password: 'z', steps: ['whatever'] }),
    'unknown step: whatever',
  );
});

test('validateDeployRunBody — accepts a minimal valid body', () => {
  const ok = validateDeployRunBody({
    url: 'https://x',
    user: 'u',
    password: 'p',
    steps: ['upload-app-forms'],
  });
  assert.equal(ok, null);
});

test('validateDeployRunBody — extraArgs shape enforced', () => {
  const base = { url: 'https://x', user: 'u', password: 'p', steps: ['upload-app-forms'] };
  assert.equal(
    validateDeployRunBody({ ...base, extraArgs: 'nope' }),
    'extraArgs must be an object of step-name → string[]',
  );
  assert.equal(
    validateDeployRunBody({ ...base, extraArgs: { 'upload-app-forms': 'not-array' } }),
    'extraArgs[upload-app-forms] must be a string[]',
  );
  assert.equal(
    validateDeployRunBody({ ...base, extraArgs: { 'upload-app-forms': [1, 2] } }),
    'extraArgs[upload-app-forms] must be a string[]',
  );
  assert.equal(
    validateDeployRunBody({
      ...base,
      extraArgs: { 'upload-app-forms': ['--forms=preg'] },
    }),
    null,
  );
});

test('translateStderr — recognises a pyxform missing-column stderr blob', () => {
  const stderr = [
    'Traceback (most recent call last):',
    `pyxform.error.PyXFormError: ValueError: missing required 'name' column on survey sheet.`,
    '',
  ].join('\n');
  const hint = translateStderr(stderr);
  assert.ok(hint, 'produced a hint');
  assert.equal(hint!.patternId, 'pyxform-missing-required-column');
  assert.ok(hint!.friendly.length > 0, 'friendly summary is non-empty');
  // The raw line is preserved as-is on the hint — this is the "attach both
  // raw + translated" contract from the task spec.
  assert.ok(hint!.rawLine.includes("missing required 'name'"));
});

test('translateStderr — returns null when nothing recognisable is in stderr', () => {
  const stderr = 'random noise line 1\nno pattern match here\n';
  assert.equal(translateStderr(stderr), null);
});

test('translateStderr — never mutates the raw stderr string it was given', () => {
  const stderr = `pyxform.error.PyXFormError: ValueError: missing required 'name' column on survey sheet.`;
  const before = stderr;
  translateStderr(stderr);
  assert.equal(stderr, before, 'input string unchanged');
});
