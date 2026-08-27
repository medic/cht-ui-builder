import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Playwright config for cht-ui-builder e2e tests.
 *
 * The suite targets Vite at http://localhost:5173 (proxied to Fastify on
 * :5174). The `webServer` array boots both automatically so the suite is
 * self-contained in CI and on a fresh clone:
 *   - the API via `server start` (node dist/index.js) — NOT the watch-mode
 *     `dev`, so it never restarts mid-run (the watcher's recompile→restart
 *     race made early tests flaky);
 *   - the client via Vite dev (serves from the prebuilt shared/dist).
 * Both require a prior `pnpm --filter @cht-ui/{shared,server} build` (the CI
 * job does this). Locally, `reuseExistingServer` reuses a `pnpm dev` you
 * already have running instead of starting a second one.
 *
 * Tests assume a project is loaded; setup.ts ensures one via the API.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  // The Fastify server holds a SINGLE global "open project"; setup.ts opens it
  // per test and the round-trip test repoints it to a temp copy. Parallel
  // workers would race that shared state, so the suite runs single-worker.
  workers: 1,
  reporter: [['list']],
  webServer: [
    {
      command: 'pnpm --filter @cht-ui/server run start',
      cwd: repoRoot,
      url: 'http://localhost:5174/api/health',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: 'pnpm --filter @cht-ui/client run dev',
      cwd: repoRoot,
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
  use: {
    baseURL: 'http://localhost:5173',
    actionTimeout: 5_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
