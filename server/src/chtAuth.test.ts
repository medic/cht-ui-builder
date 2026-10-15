/**
 * CHT sign-in (chtAuth.ts) against scripts/fake-cht.mjs: the same allow/deny
 * decisions cht-user-management makes — right password, then admin or every
 * required permission held by one of the user's roles.
 */
import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ChtLoginError, loginToCht, missingPermissions } from './chtAuth.js';
import { parseInstances } from './config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// server/dist → <repo>/scripts
const fakeChtUrl = pathToFileURL(path.resolve(here, '..', '..', 'scripts', 'fake-cht.mjs')).href;

interface FakeCht {
  url: string;
  stats: { logins: number; logouts: number };
  close: () => Promise<void>;
}
let cht: FakeCht;

before(async () => {
  const mod = (await import(fakeChtUrl)) as { startFakeCht: () => Promise<FakeCht> };
  cht = await mod.startFakeCht();
});
after(() => cht.close());

async function rejects(p: Promise<unknown>, status: number, re: RegExp) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof ChtLoginError, `expected ChtLoginError, got ${String(e)}`);
    assert.equal(e.status, status);
    assert.match(e.message, re);
    return true;
  });
}

test('a user whose role holds the permission is let in, with their roles', async () => {
  const id = await loginToCht(cht.url, 'alice', 'alice-pass', ['can_configure']);
  assert.deepEqual(id, { instance: cht.url, username: 'alice', roles: ['program_officer'] });
});

test('a wrong password is 401', async () => {
  await rejects(loginToCht(cht.url, 'alice', 'nope', ['can_configure']), 401, /incorrect/);
});

test('a user missing a required permission is 403 and told which', async () => {
  await rejects(
    loginToCht(cht.url, 'chw', 'chw-pass', ['can_configure', 'can_edit']),
    403,
    /missing: can_configure\.$/,
  );
});

test('a server admin with no user-settings doc is let in without a permission check', async () => {
  const id = await loginToCht(cht.url, 'admin', 'admin-pass', ['can_configure']);
  assert.deepEqual(id.roles, ['_admin']);
});

test('the CHT session is closed after the checks', async () => {
  const before = cht.stats.logouts;
  await loginToCht(cht.url, 'bob', 'bob-pass', ['can_configure']);
  assert.equal(cht.stats.logouts, before + 1);
});

test('an unreachable instance is a 502, not a crash', async () => {
  await rejects(
    loginToCht('http://127.0.0.1:1', 'alice', 'alice-pass', []),
    502,
    /Could not reach/,
  );
});

test('missingPermissions: any one role suffices; absent or malformed grants count as missing', () => {
  const perms = { a: ['r1', 'r2'], b: ['r3'], c: 'r1' };
  assert.deepEqual(missingPermissions(['r2'], perms, ['a', 'b', 'c', 'd']), ['b', 'c', 'd']);
  assert.deepEqual(missingPermissions(['r1', 'r3'], perms, ['a', 'b']), []);
});

test('parseInstances normalises, de-duplicates and refuses credentials or non-http', () => {
  assert.deepEqual(
    parseInstances(' https://a.example.org/ , https://a.example.org,http://b:5988/cht/ '),
    ['https://a.example.org', 'http://b:5988/cht'],
  );
  assert.throws(() => parseInstances('https://u:p@a.example.org'), /credentials/);
  assert.throws(() => parseInstances('ftp://a.example.org'), /not http/);
  assert.throws(() => parseInstances('not a url'));
});
