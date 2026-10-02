import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config.js';

/**
 * Recording config for the T9 feature demos (`tests/t9-demos/*.demo.spec.ts`).
 *
 * Same servers and fixture as the e2e suite, but every test records a video
 * (with slow-motion actions and on-screen captions, see `demo-helpers.ts`)
 * and the helper copies the clip to `client/demo/t9/<ticket>.webm`. The
 * normal config ignores this folder, so `pnpm test:e2e` never records.
 *
 *   pnpm --filter @cht-ui/client exec playwright test -c playwright.demo.config.ts
 *   pnpm --filter @cht-ui/client exec playwright test -c playwright.demo.config.ts tests/t9-demos/t9e.demo.spec.ts
 */
export default defineConfig({
  ...base,
  testDir: './tests/t9-demos',
  testIgnore: undefined,
  testMatch: /\.demo\.spec\.ts$/,
  timeout: 600_000,
  outputDir: 'test-results/t9-demos',
  retries: 0,
  use: {
    ...base.use,
    viewport: { width: 1440, height: 900 },
    video: { mode: 'on', size: { width: 1440, height: 900 } },
    launchOptions: { slowMo: Number(process.env.DEMO_MS ?? 450) },
    trace: 'off',
    screenshot: 'off',
  },
  // The base project's `devices['Desktop Chrome']` carries its own 1280×720
  // viewport, which would win over the one above; restate it here.
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
});
