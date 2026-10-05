import { createPlaywrightConfig } from '@charcuterie/playwright-config';

import { smokeServers } from './smoke/ports.js';

// The browser smoke: every top-level route in the fleet's four windows (`narrow` 384x824,
// `tall` 1080x1920, `wide` 1920x1080, `ultrawide` 3440x1440), one Chromium project each —
// `createPlaywrightConfig()` builds them. Charcuterie's decision record:
// https://github.com/Sawtaytoes/charcuterie/blob/master/docs/decisions/2026-10-04-every-browser-test-runs-in-four-named-windows.md
//
// This is the ONLY `@playwright/test` suite in the repo. Every other browser harness in `e2e/`
// is a plain `tsx` script driving the `playwright` library through `e2e/playwright.ts`, so
// `testDir` is `smoke/` and nothing else — a `*-test.ts` harness is not a spec and must never be
// collected by this runner.
//
// The server is the real one, over the committed fixtures (`smoke/serve.ts`), serving
// `web/dist` — build the web app first. Everything on screen is the repo's invented cast.
export default createPlaywrightConfig({
  outputDir: './test-results',
  reporter: [['html', { open: 'never', outputFolder: './playwright-report' }], ['list']],
  testDir: './smoke',
  // The no-Plex store load is slow by design: every Plex read retries against a closed port
  // before it gives up, so a page's first `/api/queues` answers about eleven seconds after it
  // asks (measured in `vrt-capture.ts`). Playwright's local 30 s would leave the route almost
  // nothing; this is the factory's own CI budget, used everywhere.
  timeout: 90_000,
  // The factory runs ONE worker on CI, for the shared Forgejo runner. This repo's CI is a
  // GitHub-hosted runner (4 vCPUs, 16 GB), and 48 tests that each wait out an 11 s store load
  // would take most of the job's 30 minutes serially.
  workers: process.env.CI ? 4 : undefined,
  webServer: {
    command: 'server/node_modules/.bin/tsx e2e/smoke/serve.ts',
    cwd: '..',
    // The servers live in their own process groups (tsx forks); `serve.ts` stops them on
    // SIGTERM, which Playwright's default SIGKILL would never give it the chance to do.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    reuseExistingServer: false,
    stdout: 'pipe',
    timeout: 120_000,
    url: `${smokeServers.boardGames}/api/people`,
  },
});
