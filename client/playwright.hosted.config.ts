import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Playwright config for the HOSTED-mode acceptance (docs/plans/hosted-authoring.md §12).
 *
 * Separate from playwright.config.ts because the server must run in
 * `CHT_UI_MODE=hosted` against a throwaway DATA_ROOT, on its own port, and
 * serve the built client itself (SERVE_CLIENT=1) — the exact shape the
 * Dockerfile ships. Requires `pnpm build` (shared, server AND client) first.
 *
 *   pnpm --filter @cht-ui/client exec playwright test -c playwright.hosted.config.ts
 */
const dataRoot = mkdtempSync(path.join(os.tmpdir(), 'cht-ui-hosted-e2e-'));
const port = 5194;

export default defineConfig({
  testDir: './tests',
  testMatch: /hosted-authoring\.spec\.ts$/,
  timeout: 60_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  webServer: {
    command: 'node server/dist/index.js',
    cwd: repoRoot,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      CHT_UI_MODE: 'hosted',
      DATA_ROOT: dataRoot,
      PORT: String(port),
      HOST: '127.0.0.1',
      SERVE_CLIENT: '1',
      LOG_LEVEL: 'warn',
    },
  },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    actionTimeout: 5_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
