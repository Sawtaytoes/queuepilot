// Before/after shots for the entry-action pass.
//
//   entryactions — the settings sheet's ▶ Play on ▾ + Remove row
//   ctxmenu      — the tile's right-click menu
//
// The ▶ in that row also carries a BUG this pass fixes: it wears `.primary`, which is not in
// `PlayMenu`'s outside-click allowlist (`.playmenu`, `.playbtn`, `.shelfplay`), so the
// document handler closes the menu on the very click that opened it.
//
// EVERY byte on screen is FIXTURE data. The repo is public, so the `libraries` half of
// `/api/sets` is fulfilled from the constant below rather than from a Plex server, and the
// queue and pool labels come from `e2e/fixtures/sets.fixture.yaml`, which is synthetic.
//
// Usage: `server/node_modules/.bin/tsx e2e/shot-entry-actions.ts [before|after]`
// Writes `__screenshots__/entryact-<slug>-<stage>.png`.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = process.argv[2] === 'after' ? 'after' : 'before';
const PORT = parseInt(process.env.WEB_PORT || '18900', 10);
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
await fs.copyFile(`${ROOT}/e2e/fixtures/queues.harness.yaml`, '/tmp/queues-entryact.yaml');
await fs.copyFile(`${ROOT}/e2e/fixtures/sets.fixture.yaml`, '/tmp/sets-entryact.yaml');
for (const lock of ['/tmp/queues-entryact.yaml.lock', '/tmp/sets-entryact.yaml.lock']) {
  await fs.rm(lock, { force: true });
}

const srv = spawnServer({
  env: {
    ...process.env,
    HISTORY_PATH: '/tmp/.history-entryact.json',
    MQTT_HOST: '',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    QUEUES_PATH: '/tmp/queues-entryact.yaml',
    SETS_PATH: '/tmp/sets-entryact.yaml',
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
    const file = `${OUT}/entryact-${slug}-${STAGE}.png`;
    await page.locator(selector).screenshot({ path: file });
    console.log(`shot: ${file}`);
  };


  await page.goto(`${BASE}/q/bob_anime`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#grid .tile .cap', { timeout: 30000 });
  await page.waitForTimeout(2000);

  // 1 — the tile's right-click menu.
  await page.locator('#grid .tile').first().click({ button: 'right' });
  await page.waitForSelector('#tilemenu:not([hidden])', { timeout: 10000 });
  await page.waitForTimeout(400);
  await shot('ctxmenu', '#tilemenu');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // 2 — the settings sheet's action row.
  await page.locator('#grid .tile .editbtn').first().click();
  await page.waitForSelector('#entrymodal', { timeout: 15000 });
  await page.waitForTimeout(900);
  await shot('entryactions', '#entrymodal .entryactions');

  await browser.close();
} finally {
  killServer(srv);
}
