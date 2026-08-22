// Before/after shots for the text-action pass — the small outline controls the app painted
// by hand in five places, plus the filter panel's solid Save.
//
//   chsave     — the pool filter panel's Save filters (solid accent, full width)
//   fieldrow   — the entry sheet's Choose… / Back to automatic
//   rmblock    — the queue editor's provider-block Remove
//
// EVERY byte on screen is FIXTURE data. The repo is public, so the `libraries` half of
// `/api/sets` is fulfilled from the constant below rather than from a Plex server, and the
// queue and pool labels come from `e2e/fixtures/sets.fixture.yaml`, which is synthetic.
//
// Usage: `server/node_modules/.bin/tsx e2e/shot-text-actions.ts [before|after]`
// Writes `__screenshots__/textact-<slug>-<stage>.png`.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = process.argv[2] === 'after' ? 'after' : 'before';
const PORT = parseInt(process.env.WEB_PORT || '18901', 10);
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
await fs.copyFile(`${ROOT}/e2e/fixtures/queues.harness.yaml`, '/tmp/queues-textact.yaml');
await fs.copyFile(`${ROOT}/e2e/fixtures/sets.fixture.yaml`, '/tmp/sets-textact.yaml');
for (const lock of ['/tmp/queues-textact.yaml.lock', '/tmp/sets-textact.yaml.lock']) {
  await fs.rm(lock, { force: true });
}

const srv = spawnServer({
  env: {
    ...process.env,
    HISTORY_PATH: '/tmp/.history-textact.json',
    MQTT_HOST: '',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    QUEUES_PATH: '/tmp/queues-textact.yaml',
    SETS_PATH: '/tmp/sets-textact.yaml',
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
    const file = `${OUT}/textact-${slug}-${STAGE}.png`;
    await page.locator(selector).screenshot({ path: file });
    console.log(`shot: ${file}`);
  };


  // 1 — the pool filter panel's pinned Save footer.
  await page.goto(`${BASE}/channels/younger`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#ch-save', { timeout: 30000 });
  await page.waitForTimeout(2500);
  await shot('chsave', '#ch-save');

  // 2 — the entry sheet's start-point row.
  await page.goto(`${BASE}/q/bob_anime`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#grid .tile .editbtn', { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.locator('#grid .tile .editbtn').first().click();
  await page.waitForSelector('#entrymodal', { timeout: 15000 });
  await page.waitForTimeout(900);
  const fieldrow = page.locator('#entrymodal .fieldrow').first();
  if (await fieldrow.count()) {
    await shot('fieldrow', '#entrymodal .fieldrow');
  } else {
    console.log('SKIPPED fieldrow — no start-point row on this entry');
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // 3 — the queue editor's provider block, which holds the Remove chip.
  await page.goto(`${BASE}/q/bob`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#qconfigure', { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.click('#qconfigure');
  await page.waitForSelector('#setmodal[data-open]', { timeout: 15000 });
  await page.waitForTimeout(1200);
  const pblock = page.locator('#setmodal .pblock').first();
  if (await pblock.count()) {
    await shot('rmblock', '#setmodal .pblock');
  } else {
    console.log('SKIPPED rmblock — no provider block rendered');
  }

  await browser.close();
} finally {
  killServer(srv);
}
