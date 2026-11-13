import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';

const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cht-ui-project-picker-'));
process.env.CHT_UI_MODE = 'desktop';
process.env.DATA_ROOT = dataRoot;

const { listProjects } = await import('../state.js');
const { registerProjectRoutes } = await import('./project.js');

test('a missing desktop last-opened path quietly returns the picker and leaves legacy state.json unchanged', async (t) => {
  const app = Fastify();
  t.after(async () => {
    await app.close();
    await fs.rm(dataRoot, { recursive: true, force: true });
  });

  const projectPath = path.join(dataRoot, 'remembered-project');
  await fs.mkdir(projectPath, { recursive: true });

  const legacyState = JSON.stringify(
    { projectPath, deployConfig: { target: 'local' } },
    null,
    2,
  );
  const legacyStatePath = path.join(dataRoot, 'state.json');
  await fs.writeFile(legacyStatePath, legacyState, 'utf8');

  // Trigger the existing one-way migration while the remembered folder exists.
  const imported = await listProjects('local');
  assert.equal(imported.length, 1);
  assert.equal(imported[0]!.path, projectPath);

  await fs.rm(projectPath, { recursive: true, force: true });
  await registerProjectRoutes(app);

  const response = await app.inject({ method: 'GET', url: '/api/project' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { open: false });

  const remaining = await listProjects('local');
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]!.exists, false);
  assert.equal(await fs.readFile(legacyStatePath, 'utf8'), legacyState);
});
