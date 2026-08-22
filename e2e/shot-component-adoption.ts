// Before/after shots for the "a Charcuterie component, configured by props" pass.
//
// Five frames, one per place a class name was doing nothing:
//   channels-toolbar  — `.chhead`, where `＋ Filtered pool` / `＋ Curated pool` wore `accent`
//   channels-filters  — `#chfilters`, where the all-libraries hint wore `subhint`
//   dyn-lineup        — the pool editor's Playback box, which wore `flags`
//   dyn-collections   — the "Preferred queued items" box, a hand-rolled fieldset+legend
//   selbar            — the selection bar, where Apply wore `primary`
//
// EVERY byte on screen is FIXTURE data. The repo is public, so the `libraries` half of
// `/api/sets` is fulfilled from the constant below rather than from a Plex server; the
// queue and pool labels come from `e2e/fixtures/sets.fixture.yaml`, which is synthetic
// ("Bob — Movies", "Younger Kids"). A live capture would put the owner's library names
// into a committed PNG, where no grep will ever find them again.
//
// Usage: `server/node_modules/.bin/tsx e2e/shot-component-adoption.ts [before|after]`
// Writes `__screenshots__/adopt-<slug>-<stage>.png`.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = process.argv[2] === 'after' ? 'after' : 'before';
const PORT = parseInt(process.env.WEB_PORT || '18896', 10);
const BASE = `http://localhost:${PORT}`;
const OUT = `${ROOT}/__screenshots__`;

/** Section ids are the fixture's own (Movies=1, Shows=5, Anime=11, Documentaries=14, Shorts=15). */
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
await fs.copyFile(`${ROOT}/e2e/fixtures/queues.harness.yaml`, '/tmp/queues-adopt.yaml');
await fs.copyFile(`${ROOT}/e2e/fixtures/sets.fixture.yaml`, '/tmp/sets-adopt.yaml');
for (const lock of ['/tmp/queues-adopt.yaml.lock', '/tmp/sets-adopt.yaml.lock']) {
  await fs.rm(lock, { force: true });
}

const srv = spawnServer({
  env: {
    ...process.env,
    HISTORY_PATH: '/tmp/.history-adopt.json',
    MQTT_HOST: '',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    QUEUES_PATH: '/tmp/queues-adopt.yaml',
    SETS_PATH: '/tmp/sets-adopt.yaml',
    WEB_PORT: String(PORT),
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});

try {
  await waitReady(`${BASE}/api/queues`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

  // Plex is unroutable from the harness, so only `libraries` needs patching in; the sets
  // themselves come from the YAML fixture.
  await page.route('**/api/sets', async (route) => {
    const res = await route.fetch();
    const json = (await res.json()) as Record<string, unknown>;
    await route.fulfill({
      body: JSON.stringify({ ...json, libraries: LIBRARIES }),
      contentType: 'application/json',
    });
  });
  await page.route('**/api/thumb/**', (route) => route.fulfill({ body: '', status: 404 }));

  const shot = async (slug: string, selector?: string) => {
    const file = `${OUT}/adopt-${slug}-${STAGE}.png`;
    if (selector) await page.locator(selector).screenshot({ path: file });
    else await page.screenshot({ path: file });
    console.log(`shot: ${file}`);
  };

  // 1 — the channels toolbar. `.chhead` holds the two pool-creation buttons whose `accent`
  //     class matched no rule, beside the ⚙ Configure / Resample controls they share a row
  //     with.
  await page.goto(`${BASE}/channels/younger`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.chhead', { timeout: 30000 });
  await page.waitForTimeout(2500);
  await shot('channels-toolbar', '.chhead');

  // 2 — the filter panel, scrolled to the all-libraries hint.
  await page.evaluate(() => {
    document.querySelector('#ch-alllibs')?.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(400);
  await shot('channels-filters', '#chfilters');

  // 3 — the pool editor's Playback box and the "when a show has nothing left to watch"
  //     control below it.
  await page.click('#newdyn');
  await page.waitForSelector('#dynmodal[data-open]', { timeout: 15000 });
  await page.waitForTimeout(1400);
  await page.evaluate(() => {
    document
      .querySelector('#dyn-lineup')
      ?.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(400);
  await shot('dyn-lineup', '#dyn-lineup');

  // 3b — the "Preferred queued items" box in the same editor. It hand-rolled the
  //      `<fieldset>` + `<legend>` a `FieldGroup` renders, and wore `.field` while doing
  //      it — a class whose `display: block` is exactly what cancels the component's own
  //      column. Same modal, so no re-open.
  await page.evaluate(() => {
    document
      .querySelector('#dyn-collections')
      ?.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(400);
  await shot('dyn-collections', '#dyn-collections');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // 4 — the selection bar, with one entry ticked so every control is live.
  await page.goto(`${BASE}/q/bob`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#grid .tile', { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.locator('#grid .tile .check').first().click();
  await page.waitForSelector('#selbar:not([hidden])', { timeout: 10000 });
  await page.waitForTimeout(400);
  await shot('selbar', '#selbar');

  // 4b — the same bar with an edit staged, so Apply is ENABLED. That is the frame the
  //      `primary` finding is about: with nothing staged the button is disabled, and a
  //      disabled control says nothing about whether it is the emphasised one.
  await page.locator('#selbar .bulkfield').first().getByRole('button').click();
  await page.waitForTimeout(400);
  await shot('selbar-apply', '#selbar');

  await browser.close();
} finally {
  killServer(srv);
}

process.exit(0);
