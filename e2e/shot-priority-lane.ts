// Before/after shots for the Priority queue / Random pool lanes.
//
//   lanepanel — the entry settings sheet, which gains the Lane picker and (once an entry is
//               in the Priority lane) the "How often it leads" picker
//   lanetag   — the tile itself, wearing the Priority chip
//   lanes     — the whole queue page, split into a Priority queue above and a Random pool
//               below, with the empty half a drop strip
//
// EVERY byte on screen is FIXTURE data. The repo is public: the set labels come from
// `e2e/fixtures/sets.fixture.yaml`, and the two entries are INVENTED here rather than
// captured, because a PNG is opaque to every grep and nobody notices a household's library
// in one later (decision `2026-08-19-pr-screenshots-are-fixture-data-and-pinned-to-the-merge`).
//
// Usage: `server/node_modules/.bin/tsx e2e/shot-priority-lane.ts [before|after]`
// Writes `__screenshots__/lane-<slug>-<stage>.png`.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = process.argv[2] === 'before' ? 'before' : 'after';
// A port nothing else has claimed. A devshare route outlives its process, so a shared port
// answers for whoever holds it next (decision
// `2026-08-19-a-devshare-route-outlives-its-process-so-bind-an-unclaimed-port`).
const PORT = parseInt(process.env.WEB_PORT || '18973', 10);
const BASE = `http://localhost:${PORT}`;
const OUT = `${ROOT}/__screenshots__`;

const LIBRARIES = [
  { id: 1, title: 'Movies', type: 'movie', video: true },
  { id: 11, title: 'Anime', type: 'show', video: true },
];

/** Two invented entries: one promoted into the Priority lane, one following the queue. */
const ITEMS = [
  {
    key: 'title:A Synthetic Robot Film', raw: 'A Synthetic Robot Film', resolved: true,
    ratingKey: '900001', type: 'movie', title: 'A Synthetic Robot Film', year: 2007,
    childCount: null, nextEp: null, isNextEpFailed: false, partiallyWatched: false,
    viewOffset: 0, duration: 8_640_000, editionTitle: null, start: null, done: false,
    episodes: null, volumes: null, weight: 1, batch_stops_at: null,
    placement: 'priority', lead: 'once', promote_window: '24h',
  },
  {
    key: 'title:A Synthetic Show', raw: 'A Synthetic Show', resolved: true,
    ratingKey: '900002', type: 'show', title: 'A Synthetic Show', year: 2020,
    childCount: 12, nextEp: null, isNextEpFailed: false, partiallyWatched: false,
    viewOffset: 0, duration: 0, editionTitle: null, start: null, done: false,
    episodes: null, volumes: null, weight: 1, batch_stops_at: null,
    placement: null, lead: null, promote_window: null,
  },
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
await fs.copyFile(`${ROOT}/e2e/fixtures/queues.harness.yaml`, '/tmp/queues-lane.yaml');
await fs.copyFile(`${ROOT}/e2e/fixtures/sets.fixture.yaml`, '/tmp/sets-lane.yaml');
for (const lock of ['/tmp/queues-lane.yaml.lock', '/tmp/sets-lane.yaml.lock']) {
  await fs.rm(lock, { force: true });
}

const srv = spawnServer({
  env: {
    ...process.env,
    HISTORY_PATH: '/tmp/.history-lane.json',
    MQTT_HOST: '',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    QUEUES_PATH: '/tmp/queues-lane.yaml',
    SETS_PATH: '/tmp/sets-lane.yaml',
    STORE_PATH: '/tmp/queuepilot-lane.sqlite',
    WEB_PORT: String(PORT),
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});

try {
  await waitReady(`${BASE}/api/queues`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
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
  // Plex is unroutable here, so every real entry comes back `resolved: false` — and the panel's
  // Edit chip hangs off `item.resolved`. Both entries are therefore substituted whole.
  await page.route('**/api/queues*', async (route) => {
    const res = await route.fetch();
    const json = (await res.json()) as { sets: Record<string, { items: unknown[] }> };
    if (json.sets?.bob_anime) json.sets.bob_anime.items = ITEMS;
    await route.fulfill({ body: JSON.stringify(json), contentType: 'application/json' });
  });

  const shot = async (slug: string, selector: string) => {
    const file = `${OUT}/lane-${slug}-${STAGE}.png`;
    await page.locator(selector).screenshot({ path: file });
    console.log(`shot: ${file}`);
  };

  await page.goto(`${BASE}/q/bob_anime`, { waitUntil: 'domcontentloaded' });
  // Wait for the SUBSTITUTED entries, not just for a grid. The first paint comes from the
  // fixture file and is replaced a moment later by the routed response; shooting on
  // `#grid .tile .cap` alone catches the fixture and reports it as the feature.
  await page.waitForSelector(
    '#grid .tile .cap:has-text("A Synthetic Robot Film")',
    { timeout: 30000 },
  );
  await page.waitForTimeout(1500);

  // 1 — the tile row. On `after` the promoted entry wears its Priority chip; on `before`
  //     there is no chip to wear, which is the whole point of the pair.
  await shot('tag', '#grid');

  // 1b — the whole page. `before` is one undivided grid; `after` is two named lanes with
  //      the promoted film alone above the pool.
  await shot('lanes', '#grid');

  // 2 — the settings sheet for the PROMOTED entry.
  await page.locator('#grid .tile .editbtn').first().click();
  await page.waitForSelector('#entrymodal', { timeout: 15000 });
  await page.waitForTimeout(900);
  await shot('panel', '#entrymodal');

  const lanes = await page.locator('#entrymodal .field').count();
  console.log(`entry panel fields: ${lanes}`);

  // 3 — the EMPTY-lane case, on a queue nobody has promoted anything in. `bob` is
  //     priority-by-default, so its pool is the empty half and the strip is what a person
  //     drags onto to demote. Real fixture entries here, not the substituted pair.
  await page.keyboard.press('Escape');
  await page.goto(`${BASE}/q/bob`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#grid-priority li.tile', { timeout: 30000 });
  await page.waitForTimeout(1200);
  await shot('strip', '#grid');

  await browser.close();
} finally {
  killServer(srv);
}
