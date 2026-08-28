// Before/after shot of "what plays inside one entry", against a stub Plex.
//
// The change is a UI one, so the honest evidence is the same fixture queue rendered twice.
// The fixture holds a collection with three EDITIONS of one film in it, and it starts with
// two of them already skipped — the state the old tile menu could reach, one skip at a time.
//
//   BEFORE  the tile names the film and not the cut, the menu offers one Skip, and the
//           Skipped panel lists two rows that read identically.
//   AFTER   the tile says which cut is next and that two are skipped, the menu opens the
//           member list, and every row names its edition and its runtime.
//
// The two stages run the SAME script: the frames that differ are found by selector, and the
// member-list frame is simply absent before the change (`--tag=before` on `main`). Every byte
// on screen is fixture data (`stubs/plex-member-list.mjs`) — the repo is public.
//
// Usage: `server/node_modules/.bin/tsx e2e/shot-member-list.ts [before|after]`
// Writes `__screenshots__/member-list-<stage>-*.png`.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright.js';
import {
  QUEUES_YAML, SKIPPED_BEFORE, setsYamlWithSkips, startStubPlex,
} from './stubs/plex-member-list.mjs';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = process.argv[2] === 'after' ? 'after' : 'before';
const PORT = parseInt(process.env.WEB_PORT || '18896', 10);
const PLEX_PORT = parseInt(process.env.STUB_PLEX_PORT || '18897', 10);
const BASE = `http://localhost:${PORT}`;
const OUT = `${ROOT}/__screenshots__`;

const waitReady = async (url: string, ms = 30000) => {
  const end = Date.now() + ms;
  for (;;) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`not ready: ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
};

await fs.mkdir(OUT, { recursive: true });
await fs.writeFile('/tmp/queues-memberlist.yaml', QUEUES_YAML);
await fs.writeFile('/tmp/sets-memberlist.yaml', setsYamlWithSkips(SKIPPED_BEFORE));
for (const p of [
  '/tmp/queues-memberlist.yaml.lock', '/tmp/sets-memberlist.yaml.lock',
  '/tmp/cache-memberlist.sqlite', '/tmp/queuepilot-memberlist.sqlite',
]) {
  await fs.rm(p, { recursive: true, force: true });
}

const plex = startStubPlex(PLEX_PORT);
await plex.ready;

const srv = spawnServer({
  env: {
    ...process.env,
    ADB_ENABLED: 'false',
    CACHE_PATH: '/tmp/cache-memberlist.sqlite',
    HISTORY_PATH: '/tmp/.history-memberlist.json',
    MQTT_HOST: '',
    PLEX_API_SERVER_URL: `http://127.0.0.1:${PLEX_PORT}`,
    PLEX_TOKEN: 'stub',
    QUEUES_PATH: '/tmp/queues-memberlist.yaml',
    SETS_PATH: '/tmp/sets-memberlist.yaml',
    STORE_PATH: '/tmp/queuepilot-memberlist.sqlite',
    WEB_PORT: String(PORT),
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

try {
  await waitReady(`${BASE}/api/shelves`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  // The stub serves no artwork, so a poster request would only stall the shot. Both stages
  // render the same placeholder.
  await page.route('**/api/thumb/**', (route) => route.fulfill({ body: '', status: 404 }));

  await page.goto(`${BASE}/q/bob`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#queue:not([hidden])', { timeout: 30000 });
  // The tile is resolved once its next-up line names a member of the collection.
  await page.waitForFunction(
    () => document.body.innerText.includes('Great Train Robbery'),
    undefined,
    { timeout: 60000 },
  );
  await page.waitForTimeout(600);

  // 1 — the GRID. What the tile can say about which cut is next, and about the skips.
  await page.screenshot({ path: `${OUT}/member-list-${STAGE}-1-tiles.png` });

  // 2 — the tile MENU on the collection.
  const card = page.locator('text=The Frontier Trilogy').first();
  await card.scrollIntoViewIfNeeded();
  const box = await card.boundingBox();
  if (box) {
    await page.mouse.click(box.x + 30, box.y + 5, { button: 'right' });
    await page.waitForSelector('#tilemenu:not([hidden])', { timeout: 10000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/member-list-${STAGE}-2-menu.png` });
    console.log(`${STAGE} menu:`, (await page.locator('#tilemenu').innerText()).split('\n').join(' | '));
  }

  // 3 — the MEMBER LIST, which only the after stage has. Absent before, and that absence IS
  // the finding rather than a failure, so the frame is skipped and said so.
  const choose = page.getByRole('button', { name: /Choose what plays/ });
  if (await choose.count()) {
    await choose.click();
    await page.waitForSelector('#memberlist', { timeout: 30000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/member-list-${STAGE}-3-members.png` });
    console.log(`${STAGE} list:`, (await page.locator('#memberlist').innerText()).split('\n').join(' | '));
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForSelector('#membersmodal', { state: 'detached' });
  } else {
    console.log(`${STAGE}: no member list on this build — the tile menu is the only way in`);
    await page.keyboard.press('Escape');
  }

  // 4 — the SKIPPED panel: two rows for two different cuts of one film.
  const panel = page.locator('.skippanel');
  if (await panel.count()) {
    await panel.scrollIntoViewIfNeeded();
    await panel.getByRole('button').first().click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/member-list-${STAGE}-4-skipped.png` });
    console.log(`${STAGE} skipped:`, (await panel.innerText()).split('\n').join(' | '));
  }

  // 5 — the same list on a SHOW, which is the other half of what shipped: episodes rather
  // than members, grouped by season. Absent before the change, like frame 3.
  const showCard = page.locator('text=The Phantom Carriage').first();
  const showBox = await showCard.boundingBox();
  if (showBox) {
    await page.mouse.click(showBox.x + 30, showBox.y + 5, { button: 'right' });
    await page.waitForSelector('#tilemenu:not([hidden])', { timeout: 10000 });
    const chooseEpisodes = page.getByRole('button', { name: /Choose which episodes play/ });
    if (await chooseEpisodes.count()) {
      await chooseEpisodes.click();
      await page.waitForSelector('#memberlist', { timeout: 30000 });
      await page.waitForTimeout(500);
      const special = page.locator('#memberlist input[value="9701"]');
      if (await special.isChecked()) throw new Error('regular special did not start unticked');
      if (await page.locator('#memberlist').locator('text=Closing Theme').count()) {
        throw new Error('OP/ED extra appeared in the special chooser');
      }
      await special.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${OUT}/member-list-${STAGE}-5-episodes.png` });
      console.log(`${STAGE} episodes:`, (await page.locator('#memberlist').innerText()).split('\n').join(' | '));
    } else {
      await page.keyboard.press('Escape');
    }
  }

  console.log(`shot: ${OUT}/member-list-${STAGE}-*.png`);
  await browser.close();
} finally {
  killServer(srv);
  await plex.close();
}

process.exit(0);
