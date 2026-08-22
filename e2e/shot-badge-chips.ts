// Before/after shots for the badge-chip pass — the six pill-shaped controls that were a
// hand-rolled `<button className="badge …">` because `Badge` is a `<span>`.
//
//   tiletags   — a queue tile's footer: the setting tags, and the Edit chip beside them
//   poolchips  — a pool tile's footer: the start chip and the Exclude chip
//
// The entry is a SYNTHETIC one, patched into `/api/queues`, carrying every override at
// once so all four chips render in one frame: an episode count, a weight, a start point.
// Plex is unroutable here and the repo is public, so it is invented rather than captured.
// (decision `2026-08-19-pr-screenshots-are-fixture-data-never-live` in the agentic root repo)
//
// Runs against ANY vintage of the app — it shoots both sides — so a frame whose control is
// missing logs SKIP rather than failing the run.
//
// Usage: `server/node_modules/.bin/tsx e2e/shot-badge-chips.ts [before|after]`
// Writes `__screenshots__/chip-<slug>-<stage>.png`.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = process.argv[2] === 'after' ? 'after' : 'before';
const PORT = parseInt(process.env.WEB_PORT || '18909', 10);
const BASE = `http://localhost:${PORT}`;
const OUT = `${ROOT}/__screenshots__`;

// One entry, every override at once. `start` is what puts an amber start chip on the tile,
// `weight` the success one, `episodes` the neutral one — and `resolved` is what makes the
// tile render its footer at all.
const SYNTHETIC = {
  batch_stops_at: null,
  childCount: 12,
  done: false,
  duration: 0,
  editionTitle: null,
  episodes: 3,
  isNextEpFailed: false,
  key: 'title:A Synthetic Show',
  nextEp: null,
  partiallyWatched: false,
  raw: 'A Synthetic Show',
  ratingKey: '900001',
  resolved: true,
  start: { episode: 1, season: 2 },
  title: 'A Synthetic Show',
  type: 'show',
  viewOffset: 0,
  weight: 2,
  year: 2020,
};

const waitReady = async (url: string, ms = 30000) => {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > end) throw new Error(`not ready: ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
};

await fs.mkdir(OUT, { recursive: true });
await fs.copyFile(`${ROOT}/e2e/fixtures/queues.harness.yaml`, '/tmp/queues-chip.yaml');
await fs.copyFile(`${ROOT}/e2e/fixtures/sets.fixture.yaml`, '/tmp/sets-chip.yaml');
for (const lock of ['/tmp/queues-chip.yaml.lock', '/tmp/sets-chip.yaml.lock']) {
  await fs.rm(lock, { force: true });
}

const srv = spawnServer({
  env: {
    ...process.env,
    HISTORY_PATH: '/tmp/.history-chip.json',
    MQTT_HOST: '',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    QUEUES_PATH: '/tmp/queues-chip.yaml',
    SETS_PATH: '/tmp/sets-chip.yaml',
    WEB_PORT: String(PORT),
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});

try {
  await waitReady(`${BASE}/api/queues`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.route('**/api/thumb/**', (route) => route.fulfill({ body: '', status: 404 }));
  await page.route('**/api/queues*', async (route) => {
    const res = await route.fetch();
    const json = (await res.json()) as { sets?: Record<string, { items: unknown[] }> };
    const target = json.sets?.bob_anime;
    if (target) target.items = [SYNTHETIC];
    await route.fulfill({ body: JSON.stringify(json), contentType: 'application/json' });
  });

  // The pool page previews through the Python side, which needs Plex. One bucket stands in,
  // so the pool tile — and the Exclude chip on it — renders here.
  await page.route('**/api/generic/*/preview*', (route) =>
    route.fulfill({
      body: JSON.stringify({
        buckets: [{
          next: { episode: 4, multiSeason: true, ratingKey: '900002', season: 2, title: 'A Synthetic Episode' },
          ratingKey: '900001',
          show: 'A Synthetic Show',
          unwatched: 7,
          weight: 2,
        }],
      }),
      contentType: 'application/json',
    }));

  const shot = async (slug: string, selector: string) => {
    if (!(await page.locator(selector).count())) {
      console.log(`SKIPPED ${slug} — no ${selector} at this commit`);
      return;
    }
    const target = page.locator(selector).first();
    const box = await target.boundingBox();
    await target.screenshot({ path: `${OUT}/chip-${slug}-${STAGE}.png` });
    console.log(`shot: chip-${slug}-${STAGE}  ${box ? `${Math.round(box.width)}x${Math.round(box.height)}` : '?'}`);
  };

  // 1 — a queue tile, whose footer carries the setting tags and the Edit chip.
  await page.goto(`${BASE}/q/bob_anime`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#grid .tile', { timeout: 30000 });
  await page.waitForTimeout(2000);
  await shot('tiletags', '#grid .tile');

  // 2 — a pool tile, whose footer carries the start chip and Exclude.
  await page.goto(`${BASE}/channels/younger`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#chbody', { timeout: 30000 });
  await page.waitForTimeout(3000);
  const poolTile = '#chpool .tile, #chbody .tile';
  if (await page.locator(poolTile).count()) {
    await shot('poolchips', poolTile);
  } else {
    console.log('SKIPPED poolchips — the pool rendered no tiles (Plex is unroutable)');
  }

  await browser.close();
} finally {
  killServer(srv);
}
