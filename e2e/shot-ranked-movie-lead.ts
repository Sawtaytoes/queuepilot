// Before/after shots for the "How often it leads" line on a RANKED MOVIE
// (decision `2026-09-23-a-ranked-movie-leads-until-it-is-watched`).
//
//   SHOT_TAG=before git stash … # or check out the base build
//   SHOT_TAG=after  server/node_modules/.bin/tsx e2e/shot-ranked-movie-lead.ts
//
// The panel this is about needs a RESOLVED entry, and Plex is unroutable in the harness — so
// `/api/queues` is intercepted and one synthetic resolved MOVIE is patched in, the way
// `e2e/shot-entry-actions.ts` does it. Invented, never captured: the repo is public and a PNG
// is opaque to every grep.
//
// Two entries, because the change is a CONTRAST and one panel cannot show it: the film's line
// moves from "once every 16 hours" to "every sitting", and the ranked SHOW beside it must not
// move at all.
//
// Self-contained, and every scratch path and port carries a suffix nothing else in the repo
// uses — sibling agents run these harnesses at the same time.
import { promises as fs } from 'node:fs';

import { startFakeMqtt } from './fake-mqtt.js';
import { chromium } from './playwright.js';
import { killServer, spawnServer, REPO_ROOT } from './stubs/server-process.mjs';

const TAG = process.env.SHOT_TAG || 'after';
const PORT = parseInt(process.env.WEB_PORT || '18977', 10);
const MQTT_PORT = parseInt(process.env.FAKE_MQTT_PORT || '11977', 10);
const BASE = `http://localhost:${PORT}`;
const OUT = '__screenshots__';
const QUEUES = '/tmp/qp-ranked-movie-lead.queues.yaml';
const SETS = '/tmp/qp-ranked-movie-lead.sets.yaml';

/** One ranked FILM and one ranked SHOW, so the shot carries the contrast. */
const SYNTHETIC = [
  {
    key: 'title:A Synthetic Film', raw: 'A Synthetic Film', resolved: true,
    ratingKey: '900002', type: 'movie', title: 'A Synthetic Film', year: 2021,
    placement: 'priority', lead: null, promote_window: null,
    childCount: 0, nextEp: null, isNextEpFailed: false, partiallyWatched: false,
    viewOffset: 0, duration: 0, editionTitle: null, start: null, done: false,
  },
  {
    key: 'title:A Synthetic Show', raw: 'A Synthetic Show', resolved: true,
    ratingKey: '900001', type: 'show', title: 'A Synthetic Show', year: 2020,
    placement: 'priority', lead: null, promote_window: null,
    childCount: 12, nextEp: null, isNextEpFailed: false, partiallyWatched: false,
    viewOffset: 0, duration: 0, editionTitle: null, start: null, done: false,
  },
];

await fs.mkdir(OUT, { recursive: true });
await fs.copyFile(`${REPO_ROOT}/e2e/fixtures/queues.harness.yaml`, QUEUES);
await fs.copyFile(`${REPO_ROOT}/e2e/fixtures/sets.fixture.yaml`, SETS);
for (const p of [`${QUEUES}.lock`, `${SETS}.lock`]) await fs.rm(p, { recursive: true, force: true });

let failed = false;
const fake = await startFakeMqtt({ port: MQTT_PORT });
const srv = spawnServer({
  env: {
    ...process.env,
    QUEUES_PATH: QUEUES,
    SETS_PATH: SETS,
    HISTORY_PATH: '/tmp/qp-ranked-movie-lead.history.json',
    STORE_PATH: '/tmp/qp-ranked-movie-lead.sqlite',
    WEB_PORT: String(PORT),
    MQTT_HOST: '127.0.0.1',
    MQTT_PORT: String(MQTT_PORT),
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
  },
  stdio: 'ignore',
});

const ready = async (): Promise<void> => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(`${BASE}/api/sets`)).ok) return; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server never came up');
    await new Promise((r) => setTimeout(r, 300));
  }
};

try {
  await ready();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, colorScheme: 'dark' });
  await page.route('**/api/thumb/**', (route) => route.fulfill({ body: '', status: 404 }));
  // The try/catch is not defensive noise. The LAST `/api/queues` fetch is still in flight when
  // the shots are done and the browser closes, so `route.fetch()` rejects with a disposed
  // context — out of the promise queue, after every PNG is already on disk, turning a finished
  // run into a reported failure. Unrouting first does not close the race; swallowing it does.
  await page.route('**/api/queues*', async (route) => {
    try {
      const res = await route.fetch();
      const json = (await res.json()) as { sets: Record<string, { items: unknown[] }> };
      const target = json.sets?.bob_anime;
      if (target) target.items = SYNTHETIC;
      await route.fulfill({ body: JSON.stringify(json), contentType: 'application/json' });
    } catch { /* the page is going away — nothing is left to paint */ }
  });

  for (const { slug, title } of [
    { slug: 'film', title: 'A Synthetic Film' },
    { slug: 'show', title: 'A Synthetic Show' },
  ]) {
    await page.goto(`${BASE}/q/bob_anime`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#grid .tile .cap', { timeout: 30_000 });
    await page.waitForTimeout(1200);
    const tile = page.locator('#grid .tile', { hasText: title }).first();
    await tile.locator('.editbtn').click();
    await page.waitForSelector('#entrymodal', { timeout: 15_000 });
    await page.waitForTimeout(700);
    const lead = page.locator('#entrymodal .field', { hasText: 'How often it leads' }).first();
    await lead.scrollIntoViewIfNeeded();
    const file = `${OUT}/ranked-${slug}-lead-${TAG}.png`;
    await lead.screenshot({ path: file });
    console.log(`wrote ${file}`);
    console.log(`${slug} panel says:`, (await lead.innerText()).replace(/\n+/g, ' / '));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }

  await browser.close();
} catch (e) {
  console.log('SHOT FAILED:', e);
  failed = true;
} finally {
  killServer(srv);
  try { fake.client.end(true); } catch { /* already down */ }
  try { fake.server.close(); } catch { /* already down */ }
  try { fake.aedes.close(); } catch { /* already down */ }
  process.exit(failed ? 1 : 0);
}
