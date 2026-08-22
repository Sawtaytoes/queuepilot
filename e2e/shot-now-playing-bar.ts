// The Now-playing bar — the transport controls under the header while something is on
// screen. Wide and narrow, playing and paused.
//
// Self-contained: its own server, its own temp copies of `fixtures/landing.*.yaml`, an
// unroutable Plex, no MQTT.
//
// **The `now` payload is intercepted, not played.** With no broker there is no
// `now-playing` topic, so `/api/now` answers `{now: null}` and the bar correctly renders
// nothing. Fulfilling that one route is the whole fixture — it is also the only way to
// shoot a DETERMINISTIC position, since the real bar interpolates against wall-clock and
// two runs a second apart would differ.
//
// **Fixture data, never live.** A screenshot is opaque to every grep, and this bar renders
// the episode title that is on the household's TV
// (decision `2026-08-19-pr-screenshots-are-fixture-data-never-live`).
//
//   server/node_modules/.bin/tsx e2e/shot-now-playing-bar.ts --tag=after
import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const PORT = 18795;
const tagArg = process.argv.find((a) => a.startsWith('--tag='));
const TAG = tagArg ? tagArg.slice('--tag='.length) : 'after';

const env = {
  ...process.env,
  WEB_PORT: String(PORT),
  QUEUES_PATH: '/tmp/queues-shotnpbar.yaml',
  SETS_PATH: '/tmp/sets-shotnpbar.yaml',
  GROUPS_PATH: '/tmp/groups-shotnpbar.yaml',
  HISTORY_PATH: '/tmp/history-shotnpbar.json',
  CACHE_PATH: '/tmp/cache-shotnpbar.sqlite',
  PLEX_API_SERVER_URL: 'https://127.0.0.1:1',
  PLEX_TOKEN: '',
  MQTT_HOST: '',
  NODE_TLS_REJECT_UNAUTHORIZED: '0',
};

for (const [src, dest] of [
  ['e2e/fixtures/landing.sets.yaml', env.SETS_PATH],
  ['e2e/fixtures/landing.queues.yaml', env.QUEUES_PATH],
  ['e2e/fixtures/landing.groups.yaml', env.GROUPS_PATH],
] as const) {
  await fs.copyFile(src, dest);
  await fs.rm(`${dest}.lock`, { force: true, recursive: true });
}

/** `positionAt` is the FETCH time, so the interpolated clock starts at `position`. */
const nowPayload = (state: 'paused' | 'playing') => ({
  now: {
    state,
    ratingKey: '90210',
    title: 'The Cave of Two Lovers',
    showTitle: 'Bob’s Long-Running Cartoon',
    duration: 1_412,
    position: 517,
    positionAt: Math.floor(Date.now() / 1000),
  },
  set: 'bob_kids',
  kind: 'cartoons',
  mqtt: true,
});

let server: ChildProcess | undefined;
const browser = await chromium.launch();

try {
  server = spawnServer({ env, stdio: 'ignore' });

  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`http://localhost:${PORT}/api/sets`).then((r) => r.json());
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // The owner's UI is dark; the scheme persists to localStorage, so set it before first
  // paint rather than clicking the toggle after it.
  const ctx = await browser.newContext({ viewport: { width: 1420, height: 900 } });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('charcuterie-scheme', 'dark');
    } catch {
      /* private mode — the shot is just light then, and says so */
    }
  });

  const page = await ctx.newPage();

  let state: 'paused' | 'playing' = 'playing';
  await page.route('**/api/now', async (route) => {
    await route.fulfill({
      body: JSON.stringify(nowPayload(state)),
      contentType: 'application/json',
      status: 200,
    });
  });

  const settle = async (expectBar: boolean) => {
    await page.waitForSelector('.playcard, .playrow', { timeout: 30000 });
    if (expectBar) await page.waitForSelector('.npbar', { timeout: 30000 });
    await page.waitForTimeout(1200);
  };

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await settle(true);
  await page.screenshot({ path: `__screenshots__/npbar-${TAG}-wide.png`, fullPage: false });

  state = 'paused';
  await page.reload({ waitUntil: 'domcontentloaded' });
  await settle(true);
  await page.screenshot({ path: `__screenshots__/npbar-${TAG}-paused.png`, fullPage: false });

  // The Narrow View — named for the WIDTH, which is what the query asks about. The scrubber
  // takes a row of its own here rather than shrinking to unusable.
  state = 'playing';
  await page.setViewportSize({ width: 390, height: 780 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await settle(true);
  await page.screenshot({ path: `__screenshots__/npbar-${TAG}-narrow.png`, fullPage: false });

  // The BEFORE case, and the one that proves the bar costs nothing when idle: with no
  // session the payload is null and the header sits straight on the content.
  await page.unroute('**/api/now');
  await page.setViewportSize({ width: 1420, height: 900 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await settle(false);
  if (await page.locator('.npbar').count()) {
    throw new Error('the bar rendered with nothing playing');
  }
  await page.screenshot({ path: `__screenshots__/npbar-${TAG}-idle.png`, fullPage: false });

  console.log(`shot: __screenshots__/npbar-${TAG}-{wide,paused,narrow,idle}.png`);
} finally {
  await browser.close();
  if (server) killServer(server);
}
