// Before/after shots of the two "Add to" menus — the Pending tile's and the Home
// toolbar search row's — driven to the OPEN state, which is the only state where the
// change is visible.
//
// EVERY byte on screen is FIXTURE data. The repo is public, so `/api/pending`,
// `/api/search` and the `libraries` half of `/api/sets` are all fulfilled from the
// constants below rather than from a Plex server: a real capture would put the owner's
// library names and queue names into a committed PNG, where no grep will ever find
// them again. The queue labels come from `e2e/fixtures/sets.fixture.yaml`, which is
// already synthetic ("Bob — Movies", "Bob & Alice — Movies").
//
// Usage: `server/node_modules/.bin/tsx e2e/shot-addto-menus.ts [before|after]`
// Writes `__screenshots__/addto-<slug>-<stage>.png`.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = process.argv[2] === 'after' ? 'after' : 'before';
const PORT = parseInt(process.env.WEB_PORT || '18823', 10);
const BASE = `http://localhost:${PORT}`;
const OUT = `${ROOT}/__screenshots__`;

/** Section ids are the fixture's own (Movies=1, Documentaries=14, Shorts=15). */
const LIBRARIES = [
  { id: 1, title: 'Movies', type: 'movie' },
  { id: 14, title: 'Documentaries', type: 'movie' },
  { id: 15, title: 'Shorts', type: 'movie' },
];

// Public-domain films, so the list reads like a library without being anyone's.
//
// `p1` carries an EDITION, and it is the tile the close-up frames. The owner's report was a
// caption reading "Duel 1971Original TV Version" — year and edition run together with no
// separator — so the fixture has to produce that same shape or the before/after proves
// nothing. Everything here is synthetic; the repo is public.
const PENDING = [
  { ratingKey: 'p1', title: 'Night of the Living Dead', year: 1968, type: 'movie', sectionId: 1, librarySectionTitle: 'Movies', contentRating: null, editionTitle: 'Restored Cut', addedAt: 1755000000 },
  { ratingKey: 'p2', title: 'Nosferatu', year: 1922, type: 'movie', sectionId: 1, librarySectionTitle: 'Movies', contentRating: null, editionTitle: null, addedAt: 1755000100 },
  { ratingKey: 'p3', title: 'The General', year: 1926, type: 'movie', sectionId: 1, librarySectionTitle: 'Movies', contentRating: null, editionTitle: null, addedAt: 1755000200 },
  // Section 15 is in NO fixture queue, so this tile is the empty-state case.
  { ratingKey: 'p4', title: 'Steamboat Willie', year: 1928, type: 'movie', sectionId: 15, librarySectionTitle: 'Shorts', contentRating: null, editionTitle: null, addedAt: 1755000300 },
];

const SEARCH_HITS = [
  { ratingKey: 's1', title: 'Metropolis', year: 1927, type: 'movie', sectionId: 1, hasThumb: false },
  { ratingKey: 's2', title: 'The Kid', year: 1921, type: 'movie', sectionId: 1, hasThumb: false },
];

const waitReady = async (url: string, ms = 30000) => {
  const end = Date.now() + ms;
  for (;;) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`not ready: ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
};

await fs.mkdir(OUT, { recursive: true });
await fs.copyFile(`${ROOT}/e2e/fixtures/queues.harness.yaml`, '/tmp/queues-addto.yaml');
await fs.copyFile(`${ROOT}/e2e/fixtures/sets.fixture.yaml`, '/tmp/sets-addto.yaml');
for (const p of ['/tmp/sets-addto.yaml.lock', '/tmp/queues-addto.yaml.lock']) await fs.rm(p, { force: true });

const srv = spawnServer({
  env: {
    ...process.env,
    QUEUES_PATH: '/tmp/queues-addto.yaml',
    SETS_PATH: '/tmp/sets-addto.yaml',
    HISTORY_PATH: '/tmp/.history-addto.json',
    WEB_PORT: String(PORT),
    MQTT_HOST: '',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

try {
  await waitReady(`${BASE}/api/queues`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

  // Plex is unroutable from the harness, so the server answers these with an error or an
  // empty list. Fixtures stand in — see the header.
  await page.route('**/api/pending', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: PENDING }) }));
  await page.route('**/api/search*', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: SEARCH_HITS }) }));
  await page.route('**/api/thumb/**', (route) => route.fulfill({ status: 404, body: '' }));
  // The sets come from the YAML fixture; only `libraries` needs Plex, so patch that in.
  await page.route('**/api/sets', async (route) => {
    const res = await route.fetch();
    const json = (await res.json()) as Record<string, unknown>;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...json, libraries: LIBRARIES }) });
  });

  const shot = async (slug: string) => {
    await page.screenshot({ path: `${OUT}/addto-${slug}-${STAGE}.png` });
    console.log(`shot: ${OUT}/addto-${slug}-${STAGE}.png`);
  };

  // The registry (`/api/sets`) is what tells a tile which queues draw from its library, and
  // the store resolves it together with `/api/queues` — which is a Plex read and takes
  // seconds. Click before that lands and every tile claims no queue is compatible.
  const waitForRegistry = () =>
    page.waitForFunction(
      () => !/Loading/.test(document.querySelector('#status')?.textContent ?? ''),
      undefined,
      { timeout: 60000 },
    );

  // The Add-to trigger's handle spans both revisions of this change ON PURPOSE: `before` is
  // captured against the raw `<button class="addto">` and `after` against the Charcuterie
  // `Button`, which carries `data-testid` instead. One script, two trees, same frames.
  const ADDTO = '.addto, [data-testid="pending-addto"]';

  // 0 — the TILE itself, closed. This is where the owner's three complaints live: the
  // edition badge jammed against the year, and two controls that do not read as controls.
  // Clipped to the first row, because a 1300px page shrinks a 160px tile to nothing.
  await page.goto(`${BASE}/pending`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#pendinggrid li', { timeout: 30000 });
  await waitForRegistry();
  await page.waitForTimeout(300);
  await page.screenshot({
    path: `${OUT}/addto-pending-tile-${STAGE}.png`,
    clip: { x: 0, y: 90, width: 660, height: 330 },
  });
  console.log(`shot: ${OUT}/addto-pending-tile-${STAGE}.png`);

  // 1 — the Pending tile's Add-to menu, the one the owner reported.
  await page.locator('#pendinggrid li').first().locator(ADDTO).click();
  await page.waitForSelector('.qmenu, .addtomenu', { timeout: 10000 });
  await page.waitForTimeout(300);
  await shot('pending');

  // 1b — the same menu on the tile whose library no queue draws from (the empty state).
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await page.locator('#pendinggrid li').nth(3).locator(ADDTO).click();
  await page.waitForSelector('.qmenu, .addtomenu', { timeout: 10000 });
  await page.waitForTimeout(300);
  await shot('pending-empty');

  // 2 — the Home toolbar search row's Add-to menu.
  await page.goto(`${BASE}/queues`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tools #gsearch', { timeout: 30000 });
  await waitForRegistry();
  await page.fill('#gsearch', 'metropolis');
  await page.waitForSelector('#gresults.open li', { timeout: 15000 });
  await page.locator('#gresults li').first().locator('.addto').click();
  await page.waitForSelector('.qmenu, .addtomenu', { timeout: 10000 });
  await page.waitForTimeout(300);
  await shot('toolbar');

  await browser.close();
} finally {
  killServer(srv);
}

process.exit(0);
