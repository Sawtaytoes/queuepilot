import { createVitestConfig } from '@charcuterie/vitest-config';

/**
 * The server's first unit-test runner.
 *
 * Until now `server/` had no unit gate at all: `tsc --noEmit` proved it compiled, and the real
 * coverage was `e2e/` — Playwright suites plus a dozen browserless `tsx e2e/*-test.ts`
 * harnesses that spawn a live server against a stubbed Plex. Those harnesses are the right
 * tool for "does the engine behave"; they are the wrong tool for "does this 200-line module
 * return the shape it claims", because each one costs a server boot.
 *
 * Vitest, and specifically `@charcuterie/vitest-config`, because it is what `web/` in this
 * repo already runs and what the rest of the fleet runs. A second, novel runner in the same
 * repo would be a new thing to learn for no gain.
 *
 * `environment: "node"` and no setup file — these are pure gates over Node built-ins.
 * `globals` is on (the shared base sets it), but every suite here imports `describe`/`it`/
 * `expect` explicitly, because `server/tsconfig.json` declares `types: ["node"]` and an
 * ambient global would not typecheck.
 */
export default createVitestConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    name: 'server',
  },
});
