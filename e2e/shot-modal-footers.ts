// Before/after shots for the modal-footer button pass — every `.modalbtns` in the app.
//
// Five footers, and each one hand-rolled a skin `@charcuterie/ui` already ships:
//   dynmodal     — Delete pool / Cancel / Save
//   setmodal     — Delete queue / Cancel / Save
//   startmodal   — Clear / Cancel / Save
//   groupsmodal  — Delete group / Close / Save        (a click handler, not a submit)
//   entrymodal   — Done                               (ditto)
//
// EVERY byte on screen is FIXTURE data. The repo is public, so the `libraries` half of
// `/api/sets` is fulfilled from the constant below rather than from a Plex server, and the
// queue and pool labels come from `e2e/fixtures/sets.fixture.yaml`, which is synthetic.
//
// Usage: `server/node_modules/.bin/tsx e2e/shot-modal-footers.ts [before|after]`
// Writes `__screenshots__/footer-<slug>-<stage>.png`.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = process.argv[2] === 'after' ? 'after' : 'before';
const PORT = parseInt(process.env.WEB_PORT || '18897', 10);
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
await fs.copyFile(`${ROOT}/e2e/fixtures/queues.harness.yaml`, '/tmp/queues-footer.yaml');
await fs.copyFile(`${ROOT}/e2e/fixtures/sets.fixture.yaml`, '/tmp/sets-footer.yaml');
for (const lock of ['/tmp/queues-footer.yaml.lock', '/tmp/sets-footer.yaml.lock']) {
  await fs.rm(lock, { force: true });
}

const srv = spawnServer({
  env: {
    ...process.env,
    HISTORY_PATH: '/tmp/.history-footer.json',
    MQTT_HOST: '',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    QUEUES_PATH: '/tmp/queues-footer.yaml',
    SETS_PATH: '/tmp/sets-footer.yaml',
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
    const file = `${OUT}/footer-${slug}-${STAGE}.png`;
    await page.locator(selector).screenshot({ path: file });
    console.log(`shot: ${file}`);
  };

  const escape = async () => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  };

  // --- the pool editor, opened from the channels page -------------------------- //
  await page.goto(`${BASE}/channels/younger`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.chhead', { timeout: 30000 });
  await page.waitForTimeout(2500);
  // `#chconfigure`, not `#newdyn` — the EDIT footer is the superset. A new pool hides
  // Delete, so shooting the create path would leave the destructive button uncaptured,
  // and that is the one whose skin (`.danger`) is being replaced.
  await page.click('#chconfigure');
  await page.waitForSelector('#dynmodal[data-open]', { timeout: 15000 });
  await page.waitForTimeout(1200);
  await shot('dynmodal', '#dynmodal .modalbtns');
  await escape();

  // --- the queue editor, in EDIT mode, from a queue's own page ----------------- //
  await page.goto(`${BASE}/q/bob`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#queue', { timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.click('#qconfigure');
  await page.waitForSelector('#setmodal[data-open]', { timeout: 15000 });
  await page.waitForTimeout(1200);
  await shot('setmodal', '#setmodal .modalbtns');
  await escape();

  // --- the groups panel, from the group bar on the landing --------------------- //
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#playgrid li[data-set]', { timeout: 30000 });
  await page.waitForTimeout(1500);
  const groupEdit = page.locator('.groupedit').first();
  if (await groupEdit.count()) {
    await groupEdit.click();
    await page.waitForSelector('#groupsmodal[data-open]', { timeout: 15000 });
    await page.waitForTimeout(1000);
    // Pick a group first: Delete only exists once one is selected, and it is the
    // `ghost danger` pair this pass is replacing.
    const firstGroup = page.locator('#groupsmodal .grouppick').first();
    if (await firstGroup.count()) {
      await firstGroup.click();
      await page.waitForTimeout(600);
    }
    await shot('groupsmodal', '#groupsmodal .modalbtns');
    await escape();
  } else {
    console.log('skip: no group bar on the landing fixture');
  }

  // --- a queue tile: right-click opens `#tilemenu`, whose "Start from…" opens the modal.
  //     `#tilemenu` is a CONTEXT menu, so there is no button to press — the same
  //     `onContextMenu` the app binds is what a user does.
  await page.goto(`${BASE}/q/bob_anime`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#grid .tile .cap', { timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.locator('#grid .tile').first().click({ button: 'right' });
  await page.waitForSelector('#tilemenu:not([hidden])', { timeout: 10000 });
  await page.waitForTimeout(400);

  // `#startmodal` is reachable only from a STARTABLE entry — `isStartable` wants `resolved`
  // AND a show or collection — which is exactly what the `/api/queues*` stub above patches
  // in. An earlier version of this comment claimed the harness could not make one; that was
  // a stale build, not a limitation, and the frame captures.
  //
  // The branch stays anyway, and it prints what the menu DID offer rather than shooting
  // nothing, because the row is the thing being asserted.
  const rows = await page.locator('#tilemenu button').allTextContents();
  const startRow = page.locator('#tilemenu').getByRole('button', { name: 'Start from an episode…' });
  if (await startRow.count()) {
    await startRow.click();
    await page.waitForSelector('#startmodal', { timeout: 15000 });
    await page.waitForTimeout(900);
    await shot('startmodal', '#startmodal .modalbtns');
    await escape();
  } else {
    console.log(`SKIPPED startmodal — no startable entry offline. Tile menu offered: ${JSON.stringify(rows)}`);
    await escape();
  }

  // --- the per-entry settings panel: the quiet `Edit` chip on a tile ------------ //
  await page.locator('#grid .tile .editbtn').first().click();
  await page.waitForSelector('#entrymodal', { timeout: 15000 });
  await page.waitForTimeout(900);
  await shot('entrymodal', '#entrymodal .modalbtns');

  await browser.close();
} finally {
  killServer(srv);
}
