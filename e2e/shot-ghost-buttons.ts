// Before/after shots for the `.ghost` / `.ghost accent` secondary-action pass.
//
// Four frames, one per place the app painted a Charcuterie appearance by hand:
//   tools        — the Home toolbar: Collapse all / ＋ New queue / Pools ›
//   playlinks    — the landing's ＋ New queue
//   queuetools   — a queue page's Remove all completed / ⚙ Configure
//   grouplist    — the groups panel's ＋ New group, whose `accent` matched NO rule
//
// EVERY byte on screen is FIXTURE data. The repo is public, so the `libraries` half of
// `/api/sets` is fulfilled from the constant below rather than from a Plex server, and the
// queue and pool labels come from `e2e/fixtures/sets.fixture.yaml`, which is synthetic.
//
// Usage: `server/node_modules/.bin/tsx e2e/shot-ghost-buttons.ts [before|after]`
// Writes `__screenshots__/ghost-<slug>-<stage>.png`.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = process.argv[2] === 'after' ? 'after' : 'before';
const PORT = parseInt(process.env.WEB_PORT || '18898', 10);
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
await fs.copyFile(`${ROOT}/e2e/fixtures/queues.harness.yaml`, '/tmp/queues-ghost.yaml');
await fs.copyFile(`${ROOT}/e2e/fixtures/sets.fixture.yaml`, '/tmp/sets-ghost.yaml');
for (const lock of ['/tmp/queues-ghost.yaml.lock', '/tmp/sets-ghost.yaml.lock']) {
  await fs.rm(lock, { force: true });
}

const srv = spawnServer({
  env: {
    ...process.env,
    HISTORY_PATH: '/tmp/.history-ghost.json',
    MQTT_HOST: '',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    QUEUES_PATH: '/tmp/queues-ghost.yaml',
    SETS_PATH: '/tmp/sets-ghost.yaml',
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
    const file = `${OUT}/ghost-${slug}-${STAGE}.png`;
    await page.locator(selector).screenshot({ path: file });
    console.log(`shot: ${file}`);
  };


  // 1 — the Home toolbar (`#tools`), where `.accent` DOES paint: an accent border and
  //     accent text, filling on hover. That is `appearance="outline" intent="accent"`.
  await page.goto(`${BASE}/queues`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tools', { timeout: 30000 });
  await page.waitForTimeout(2500);
  await shot('tools', '#tools');

  // 2 — the landing's link row (`.playlinks`), the second place `.accent` has a rule.
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.playlinks', { timeout: 30000 });
  await page.waitForTimeout(2000);
  await shot('playlinks', '.playlinks');

  // 3 — a queue page's action row: two plain `.ghost` buttons.
  await page.goto(`${BASE}/q/bob`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#qconfigure', { timeout: 30000 });
  await page.waitForTimeout(2000);
  await shot('queuetools', '#qconfigure');

  // 4 — the groups panel's ＋ New group. Its `accent` matches NEITHER `#tools button.accent`
  //     NOR `.playlinks button.accent`, so it has never once shown the treatment its class
  //     asks for — the same latent bug the channels toolbar had.
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#playgrid li[data-set]', { timeout: 30000 });
  await page.waitForTimeout(1500);
  const groupEdit = page.locator('.groupedit').first();
  if (await groupEdit.count()) {
    await groupEdit.click();
    await page.waitForSelector('#groupsmodal[data-open]', { timeout: 15000 });
    await page.waitForTimeout(1000);
    await shot('grouplist', '#groupnew');
  } else {
    console.log('SKIPPED grouplist — no group bar on the landing fixture');
  }

  await browser.close();
} finally {
  killServer(srv);
}
