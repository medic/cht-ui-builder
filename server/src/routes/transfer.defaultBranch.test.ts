/**
 * export-git must never push to the remote's default branch, whatever it is
 * called. The default is read from the remote (`ls-remote --symref`), so these
 * pin the parser and run it against a real local remote named neither
 * `main` nor `master`.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseDefaultBranch, remoteDefaultBranch } from './transfer.js';

test('parses the symref line for any branch name', () => {
  const sha = 'a'.repeat(40);
  assert.equal(parseDefaultBranch(`ref: refs/heads/main\tHEAD\n${sha}\tHEAD\n`), 'main');
  assert.equal(parseDefaultBranch(`ref: refs/heads/master\tHEAD\n${sha}\tHEAD\n`), 'master');
  assert.equal(
    parseDefaultBranch(`ref: refs/heads/release/v4\tHEAD\n${sha}\tHEAD\n`),
    'release/v4',
  );
});

test('no symref (empty remote) → null', () => {
  assert.equal(parseDefaultBranch(''), null);
  assert.equal(parseDefaultBranch(`${'a'.repeat(40)}\tHEAD\n`), null);
});

test('reads the default from the remote even when the clone is single-branch on another branch', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cht-defbranch-'));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd,
      stdio: 'pipe',
    });
  try {
    const seed = path.join(tmp, 'seed');
    const bare = path.join(tmp, 'remote.git');
    const clone = path.join(tmp, 'clone');
    await fs.mkdir(seed);
    git(seed, 'init', '-b', 'trunk');
    await fs.writeFile(path.join(seed, 'a.txt'), 'a');
    git(seed, 'add', '.');
    git(seed, 'commit', '-m', 'seed');
    git(seed, 'branch', 'feature');
    git(tmp, 'clone', '--bare', seed, bare);
    git(
      tmp,
      'clone',
      '--depth',
      '1',
      '--single-branch',
      '--branch',
      'feature',
      `file://${bare}`,
      clone,
    );

    const r = await remoteDefaultBranch(clone);
    assert.deepEqual(r, { ok: true, branch: 'trunk' });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
