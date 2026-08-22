// Before/after shots for the `.playbtn` pass — the app's primary action, in three places.
//
//   chplay     — a pool page's ▶ Play on ▾
//   queueplay  — a queue page's ▶ Play on ▾
//   cardplay   — the landing card's ▶ Play on ▾, inside `.playcard`
//
// `.playbtn` is a SOLID accent button (background, on-solid text, no border, 600 weight),
// which is Charcuterie's default `appearance` with `intent="accent"`.
//
// EVERY byte on screen is FIXTURE data. The repo is public, so the `libraries` half of
// `/api/sets` is fulfilled from the constant below rather than from a Plex server, and the
// queue and pool labels come from `e2e/fixtures/sets.fixture.yaml`, which is synthetic.
//
// Usage: `server/node_modules/.bin/tsx e2e/shot-playbtn.ts [before|after]`
// Writes `__screenshots__/playbtn-<slug>-<stage>.png`.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = process.argv[2] === 'after' ? 'after' : 'before';
const PORT = parseInt(process.env.WEB_PORT || '18899', 10);
const BASE = `http://localhost:${PORT}`;
const OUT = `${ROOT}/__screenshots__`;

const LIBRARIES = [
  { id: 1, title: 'Movies', type: 'movie', video: true },
  { id: 5, title: 'Shows', type: 'show', video: true },
  { id: 11, title: 'Anime', type: 'show', video: true },
  { id: 14, title: 'Documentaries', type: 'movie', video: true },
  { id: 15, title: 'Shorts', type: 'movie', video: true },
];

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
await fs.copyFile(`${ROOT}/e2e/fixtures/queues.harness.yaml`, '/tmp/queues-playbtn.yaml');
await fs.copyFile(`${ROOT}/e2e/fixtures/sets.fixture.yaml`, '/tmp/sets-playbtn.yaml');
for (const lock of ['/tmp/queues-playbtn.yaml.lock', '/tmp/sets-playbtn.yaml.lock']) {
  await fs.rm(lock, { force: true });
}

const srv = spawnServer({
  env: {
    ...process.env,
    HISTORY_PATH: '/tmp/.history-playbtn.json',
    MQTT_HOST: '',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    QUEUES_PATH: '/tmp/queues-playbtn.yaml',
    SETS_PATH: '/tmp/sets-playbtn.yaml',
    WEB_PORT: String(PORT),
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});

try {
  await waitReady(`${BASE}/api/queues`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

  await page.route('**/api/sets', async (route) => {
    const res = await route.fetch();
    const json = (await res.json()) as Record<string, unknown>;
    await route.fulfill({
      body: JSON.stringify({ ...json, libraries: LIBRARIES }),
      contentType: 'application/json',
    });
  });
  await page.route('**/api/thumb/**', (route) => route.fulfill({ body: '', status: 404 }));

  // Plex is unroutable here, so every entry comes back `resolved: false` — and BOTH remaining
  // footers hang off a resolved item: `#startmodal` needs `isStartable` (resolved + a show or
  // a collection) and `#entrymodal`'s Edit chip needs `item.resolved`. So one synthetic
  // RESOLVED show is patched into `bob_anime`. Invented, not captured: the repo is public and
  // a PNG is opaque to every grep.
  await page.route('**/api/queues*', async (route) => {
    const res = await route.fetch();
    const json = (await res.json()) as { sets: Record<string, { items: unknown[] }> };
    const target = json.sets?.bob_anime;
    if (target) {
      target.items = [{
        key: 'title:A Synthetic Show', raw: 'A Synthetic Show', resolved: true,
        ratingKey: '900001', type: 'show', title: 'A Synthetic Show', year: 2020,
        childCount: 12, nextEp: null, isNextEpFailed: false, partiallyWatched: false,
        viewOffset: 0, duration: 0, editionTitle: null, start: null, done: false,
      }];
    }
    await route.fulfill({ body: JSON.stringify(json), contentType: 'application/json' });
  });

  const shot = async (slug: string, selector: string) => {
    const file = `${OUT}/playbtn-${slug}-${STAGE}.png`;
    await page.locator(selector).screenshot({ path: file });
    console.log(`shot: ${file}`);
  };


  // 1 — a pool page's play button.
  await page.goto(`${BASE}/channels/younger`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#chplay', { timeout: 30000 });
  await page.waitForTimeout(2500);
  await shot('chplay', '#chplay');

  // 2 — a queue page's play button.
  await page.goto(`${BASE}/q/bob`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#queue', { timeout: 30000 });
  await page.waitForTimeout(2000);
  const queuePlay = page.locator('#queue .playbtn').first();
  if (await queuePlay.count()) {
    await shot('queueplay', '#queue .playbtn');
  } else {
    console.log('SKIPPED queueplay — no push queue on this fixture');
  }

  // 3 — the landing card's play button, which also carries `.playcard .playbtn`'s
  //     `flex-shrink: 0`. That rule is LAYOUT and survives the swap; the skin does not.
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#playgrid li[data-set]', { timeout: 30000 });
  await page.waitForTimeout(2000);
  const cardPlay = page.locator('#playgrid .playbtn').first();
  if (await cardPlay.count()) {
    await shot('cardplay', '#playgrid li:first-child .playbtn');
  } else {
    console.log('SKIPPED cardplay — no card play button on this fixture');
  }

  await browser.close();
} finally {
  killServer(srv);
}
