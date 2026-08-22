// Before/after shot for the returning-show badge: a `done` entry whose next episode aired.
//
// Runs the whole thing itself — stub Plex, real server, browser — so the SAME command can be
// run in a checkout of `main` and in this branch and the two images differ only by the code:
//
//   SHOT_TAG=before server/node_modules/.bin/tsx e2e/shot-revived-badge.ts   (from a main checkout)
//   SHOT_TAG=after  server/node_modules/.bin/tsx e2e/shot-revived-badge.ts
//
// Writes __screenshots__/revived-badge-<tag>.png. Needs `yarn workspace queuepilot-web run
// build` first (the server serves web/dist) and the workspace's Playwright.
//
// The fixture is synthetic (stubs/plex-returning-show.mjs): three placeholder shows, all
// marked done, and only one of them with a fresh episode and a `done_at` to revive from.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';
import { QUEUES_YAML, SETS_YAML, startStubPlex } from './stubs/plex-returning-show.mjs';

const TAG = process.env.SHOT_TAG || 'after';
const PORT = Number(process.env.WEB_PORT || 18799);
const PLEX_PORT = Number(process.env.PLEX_STUB_PORT || 18800);
const OUT = '__screenshots__';

const Q_PATH = `/tmp/queues-shot-revived-${TAG}.yaml`;
const S_PATH = `/tmp/sets-shot-revived-${TAG}.yaml`;

mkdirSync(OUT, { recursive: true });
writeFileSync(S_PATH, SETS_YAML);
writeFileSync(Q_PATH, QUEUES_YAML);
for (const p of [`${Q_PATH}.lock`, `${S_PATH}.lock`, `/tmp/cache-shot-revived-${TAG}.sqlite`]) {
  rmSync(p, { force: true });
}

const plex = startStubPlex(PLEX_PORT);
await plex.ready;

const child = spawnServer({
  env: {
    ...process.env,
    WEB_PORT: String(PORT),
    QUEUES_PATH: Q_PATH,
    SETS_PATH: S_PATH,
    HISTORY_PATH: `/tmp/history-shot-revived-${TAG}.json`,
    CACHE_PATH: `/tmp/cache-shot-revived-${TAG}.sqlite`,
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
  await page.goto(`http://localhost:${PORT}/q/anime`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#grid .tile', { timeout: 30000 });
  await page.evaluate(() => document.documentElement.setAttribute('data-scheme', 'dark'));
  await page.waitForTimeout(800);

  const grid = page.locator('#grid');
  const path = `${OUT}/revived-badge-${TAG}.png`;
  await grid.screenshot({ path });
  console.log('wrote', path);
  await browser.close();
} finally {
  killServer(child);
  await plex.close();
}
