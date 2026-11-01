// Black-box integration suite: real server process + real PostgreSQL 18 + fake AI/push at the network edge.
// Run with `npm run test:bb` (or `npm run test:all` for unit + black-box). See docs/wiki.md section 14.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test-bb',
  testMatch: '**/*.spec.mjs',
  globalSetup: './test-bb/harness/global-setup.mjs',
  fullyParallel: true,
  workers: process.env.CI ? 4 : 6,
  forbidOnly: true,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['list'],
    ['./test-bb/harness/manifest-reporter.mjs'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],
  use: {
    browserName: 'chromium',
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  outputDir: 'test-results/bb',
});
