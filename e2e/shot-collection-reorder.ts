// Before/after shot of a collection RE-ORDERED in Plex, against a stub Plex.
//
// The change is a UI one, so the evidence is the same fixture queue rendered twice. Both
// stages do the same three things: warm the cache, move the last member to the front (which
// is what the owner does in the Plex UI), then open "What plays".
//
//   BEFORE  the panel lists the CACHED order. Plex has been re-ordered and the panel cannot
//           know: no timestamp moved, no count moved, no member joined or left.
//   AFTER   the panel opens on the cached rows, says "Checking Plex…", and corrects itself to
//           Plex's order with "Updated from Plex" beside the count.
//
// The two stages run the SAME script (`--tag=before` on `main`). Every byte on screen is
// fixture data (`stubs/plex-member-list.mjs`) — the repo is public, and a PNG is opaque to
// every grep that would otherwise find household data later
// (decision `2026-08-19-pr-screenshots-are-fixture-data-and-pinned-to-the-merge`).
//
// Usage: `server/node_modules/.bin/tsx e2e/shot-collection-reorder.ts [before|after]`
// Writes `__screenshots__/collection-reorder-<stage>-*.png`.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright.js';
import {
  QUEUES_YAML, setMemberOrder, setsYamlWithSkips, startStubPlex,
} from './stubs/plex-member-list.mjs';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = process.argv[2] === 'after' ? 'after' : 'before';
const PORT = parseInt(process.env.WEB_PORT || '18894', 10);
const PLEX_PORT = parseInt(process.env.STUB_PLEX_PORT || '18895', 10);
const BASE = `http://localhost:${PORT}`;
const OUT = `${ROOT}/__screenshots__`;
const TMP = `/tmp/qp-reorder-shot-${process.pid}`;

/** The re-order: the last member moves to the front, which is where a new cut lands. */
const AFTER_ORDER = ['9605', '9601', '9602', '9603', '9604'];

const waitReady = async (url: string, ms = 30000) => {
  const end = Date.now() + ms;
  for (;;) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`not ready: ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
};

await fs.mkdir(OUT, { recursive: true });
await fs.mkdir(TMP, { recursive: true });
await fs.writeFile(`${TMP}/queues.yaml`, QUEUES_YAML);
await fs.writeFile(`${TMP}/sets.yaml`, setsYamlWithSkips(['9602']));

const plex = startStubPlex(PLEX_PORT);
await plex.ready;

const srv = spawnServer({
  env: {
    ...process.env,
    ADB_ENABLED: 'false',
    CACHE_PATH: `${TMP}/cache.sqlite`,
    HISTORY_PATH: `${TMP}/.history.json`,
    MQTT_HOST: '',
    PLEX_API_SERVER_URL: `http://127.0.0.1:${PLEX_PORT}`,
    PLEX_TOKEN: 'stub',
    QUEUES_PATH: `${TMP}/queues.yaml`,
    SETS_PATH: `${TMP}/sets.yaml`,
    STORE_PATH: `${TMP}/store.sqlite`,
    WEB_PORT: String(PORT),
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

try {
  await waitReady(`${BASE}/api/shelves`);
  // Warm `collection_children` in the DECLARED order, then re-order Plex under it. This is
  // the state every stage below starts from, and the one no validator can detect.
  await fetch(`${BASE}/api/collection/9600/children`);
  setMemberOrder(AFTER_ORDER);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  // The stub serves no artwork, so a poster request would only stall the shot.
  await page.route('**/api/thumb/**', (route) => route.fulfill({ body: '', status: 404 }));
  // A real Plex round trip is a few hundred milliseconds; a stub on loopback answers inside
  // one frame, which would leave the "Checking Plex…" state unphotographable. The delay is
  // for the CAMERA only — it slows the re-read the app already makes, and it fires on the
  // after stage alone, because the before stage never asks for `fresh=1`.
  await page.route(
    /\/api\/collection\/\d+\/children\?[^?]*\bfresh=1\b/,
    async (route) => {
      await new Promise((r) => setTimeout(r, 1400));
      await route.continue();
    },
  );

  await page.goto(`${BASE}/q/bob`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#queue:not([hidden])', { timeout: 30000 });
  await page.waitForFunction(
    () => document.body.innerText.includes('Great Train Robbery'),
    undefined,
    { timeout: 60000 },
  );

  const card = page.locator('text=The Frontier Trilogy').first();
  await card.scrollIntoViewIfNeeded();
  const box = await card.boundingBox();
  if (!box) throw new Error('the collection tile never rendered');
  await page.mouse.click(box.x + 30, box.y + 5, { button: 'right' });
  await page.waitForSelector('#tilemenu:not([hidden])', { timeout: 10000 });
  await page.getByRole('button', { name: /Choose what plays/ }).click();
  await page.waitForSelector('#memberlist', { timeout: 30000 });

  // 1 — the panel the instant it opens. Both stages show the cached order here; only the
  // after stage carries the chip that says it is about to change.
  await page.waitForTimeout(350);
  await page.screenshot({
    clip: { height: 560, width: 720, x: 230, y: 90 },
    path: `${OUT}/collection-reorder-${STAGE}-1-open.png`,
  });
  console.log(`${STAGE} on open:`, (await page.locator('#membersmodal').innerText()).split('\n').join(' | '));

  // 2 — a moment later. Before: unchanged, still wrong. After: Plex's order, and the chip
  // says so.
  await page.waitForTimeout(2500);
  await page.screenshot({
    clip: { height: 560, width: 720, x: 230, y: 90 },
    path: `${OUT}/collection-reorder-${STAGE}-2-settled.png`,
  });
  console.log(`${STAGE} settled:`, (await page.locator('#membersmodal').innerText()).split('\n').join(' | '));

  console.log(`shot: ${OUT}/collection-reorder-${STAGE}-*.png`);
  await browser.close();
} finally {
  killServer(srv);
  await plex.close();
  await fs.rm(TMP, { recursive: true, force: true });
}

process.exit(0);
