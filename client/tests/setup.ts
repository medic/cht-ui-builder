import { test as base, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Project path to open before each test. Defaults to the committed
 * `fixtures/mini-config` so a fresh clone runs the suite with no env
 * export. Override with `PLAYWRIGHT_PROJECT_PATH` to point at a real
 * cht-conf project (e.g. config-gandaki) when running against richer data.
 */
export const PROJECT_PATH =
  process.env.PLAYWRIGHT_PROJECT_PATH ?? path.resolve(here, 'fixtures', 'mini-config');

/**
 * Custom fixture that ensures the dev server has a project open before each
 * test. Hits the Fastify API directly so we don't have to drive the project
 * picker UI in every test.
 */
export const test = base.extend<{ projectOpen: void }>({
  projectOpen: [
    async ({ request }, use) => {
      // 127.0.0.1 (not `localhost`) so the request lands on the IPv4 socket
      // Fastify binds to; on Windows, Node resolves localhost → ::1 (IPv6)
      // and the dev server doesn't listen there.
      const res = await request.post('http://127.0.0.1:5174/api/project/open', {
        data: { path: PROJECT_PATH },
      });
      if (!res.ok()) {
        throw new Error(
          `Failed to open project at ${PROJECT_PATH}: ${res.status()} ${await res.text()}`,
        );
      }
      await use();
    },
    { auto: true },
  ],
});

/**
 * Copy the project fixture into a throwaway directory and return its path.
 *
 * Specs that BUILD forms (rather than just read them) must never write into
 * the committed fixture — round-trip safety is the repo's invariant, and a
 * dirtied fixture makes every later run start from a different place. This is
 * the shared form of the `mkdtemp` + `fs.cp` pattern that the editing specs
 * already use inline.
 *
 * Source is `PROJECT_PATH`, so `PLAYWRIGHT_PROJECT_PATH` points the whole
 * suite at a richer cht-conf project when you have one. With nothing exported,
 * a fresh clone still runs: it copies the committed fixture.
 *
 * The caller owns cleanup — `await fs.rm(dir, { recursive: true, force: true })`
 * in a `finally`, or leave it in the OS temp dir for post-mortem.
 */
export async function makeScratchProject(label = 'e2e'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `cht-ui-${label}-`));
  await fs.cp(PROJECT_PATH, dir, { recursive: true });
  return dir;
}

export { expect };
