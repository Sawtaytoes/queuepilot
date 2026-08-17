// Before/after shot for the Completed badge: a film finished since the last scan.
//
// Runs the whole thing itself — stub Plex, real server, browser — so the SAME command can be
// run in a checkout of `main` and in this branch and the two images differ only by the code:
//
//   SHOT_TAG=before server/node_modules/.bin/tsx e2e/shot-completed-badge.ts   (from a main checkout)
//   SHOT_TAG=after  server/node_modules/.bin/tsx e2e/shot-completed-badge.ts
//
// Writes __screenshots__/completed-badge-<tag>.png. Needs `npm --prefix web run build` first
// (the server serves web/dist) and a sibling's Playwright (see e2e/playwright.ts).
//
// The fixture is the live 2026-08-16 case, and its stub is deliberately split: the section
// listing (= what the 7-day resolved cache holds) reports the PRE-playback view state, and
// only the batched metadata read knows the film is watched. See stubs/plex-watch-state.mjs.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';
import { QUEUES_YAML, SETS_YAML, startStubPlex } from './stubs/plex-watch-state.mjs';

const TAG = process.env.SHOT_TAG || 'after';
const PORT = Number(process.env.WEB_PORT || 18795);
const PLEX_PORT = Number(process.env.PLEX_STUB_PORT || 18796);
const OUT = '__screenshots__';

const Q_PATH = `/tmp/queues-shot-completed-${TAG}.yaml`;
const S_PATH = `/tmp/sets-shot-completed-${TAG}.yaml`;

mkdirSync(OUT, { recursive: true });
writeFileSync(S_PATH, SETS_YAML);
writeFileSync(Q_PATH, QUEUES_YAML);
rmSync(`/tmp/cache-shot-completed-${TAG}.sqlite`, { force: true });

const plex = startStubPlex(PLEX_PORT);
await plex.ready;

const child = spawnServer({
  env: {
    ...process.env,
    WEB_PORT: String(PORT),
    QUEUES_PATH: Q_PATH,
    SETS_PATH: S_PATH,
    HISTORY_PATH: `/tmp/history-shot-completed-${TAG}.json`,
    CACHE_PATH: `/tmp/cache-shot-completed-${TAG}.sqlite`,
    PLEX_API_SERVER_URL: `http://127.0.0.1:${PLEX_PORT}`,
    PLEX_TOKEN: 'offline-shot-token',
    MQTT_HOST: '',
  },
  stdio: process.env.SHOT_DEBUG ? 'inherit' : 'ignore',
});

try {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/api/queues`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1100, height: 760 },
    colorScheme: 'dark',
  });
  // The queue path is a real URL since the router moved off `#/` (2026-08-16).
  await page.goto(`http://localhost:${PORT}/q/movies`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#grid .tile', { timeout: 30000 });
  await page.evaluate(() => document.documentElement.setAttribute('data-scheme', 'dark'));
  await page.waitForTimeout(800);

  const grid = page.locator('#grid');
  const path = `${OUT}/completed-badge-${TAG}.png`;
  await grid.screenshot({ path });
  console.log('wrote', path);
  await browser.close();
} finally {
  killServer(child);
  await plex.close();
}
