// THE TILE MENU CARRIES WHAT THE CARD CANNOT — AND A LONG PRESS IS ONE GESTURE, NOT TWO.
//
// Two decisions, one screen, and every assertion here started as something the owner saw on a
// tablet (decisions `2026-08-26-the-tile-menu-carries-what-the-card-cannot`,
// `2026-08-26-a-long-press-is-the-menu-or-the-drag-never-both`).
//
// What it pins, and what each one cost before it existed:
//
//   1. THE MENU HOLDS THE LANE MOVES, and no Remove. On a queue tile the menu used to open
//      with one row — "Remove from this queue" — which the ✕ on the same card already did.
//   2. A LONG PRESS DOES NOT ARM THE DRAG. The hold armed a reorder at 200 ms, the browser
//      fired its own long-press menu at ~500 ms, and the menu opened over a tile that had
//      been picked up out of its card. One hold, two gestures, both half-done.
//   3. …AND THE DRAG STILL WORKS. The fix defers the pick-up to the first MOVE, so the
//      gesture that made the bug has to keep working: hold, then move, and the tile lifts.
//   4. A RIGHT-CLICK ON THE POSTER OPENS THE MENU, NOT THE ENTRY SHEET. `pointerdown` fires
//      for the right button too, so the press its own `pointerup` settled as a TAP — which
//      opens the sheet, on top of the menu the same click had just opened.
//   5. THE LANE ROWS WRITE. `placement` first, then the order, the same two calls and the
//      same order the drag across the divider makes.
//
// Touch is dispatched as real `PointerEvent`s from inside the page rather than through CDP:
// the hook listens on `pointerdown`/`pointermove`/`pointerup` and nothing else, so a
// synthetic pointer exercises the whole gesture, and the harness keeps no CDP dependency.
//
// Browser, but NO PLEX — like `lane-drag-test`, so it runs on every PR.
//
// Usage: `server/node_modules/.bin/tsx e2e/tile-menu-test.ts`  (spawns its own server)
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = parseInt(process.env.WEB_PORT || '18983', 10);
const BASE = `http://localhost:${PORT}`;
// `bob` is priority-by-default: every entry starts in the Priority queue, so the menu's lane
// row is the DEMOTE and the pool is the empty lane.
const ORDERED_QUEUE = 'bob';
// `bob_anime` is random-by-default: everything starts in the pool, which is where the bulk
// Lane picker has something to promote.
const POOL_QUEUE = 'bob_anime';

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

await fs.copyFile(`${ROOT}/e2e/fixtures/queues.harness.yaml`, '/tmp/queues-tilemenu.yaml');
await fs.copyFile(`${ROOT}/e2e/fixtures/sets.fixture.yaml`, '/tmp/sets-tilemenu.yaml');
for (const lock of ['/tmp/queues-tilemenu.yaml.lock', '/tmp/sets-tilemenu.yaml.lock']) {
  await fs.rm(lock, { force: true });
}

const srv = spawnServer({
  env: {
    ...process.env,
    HISTORY_PATH: '/tmp/.history-tilemenu.json',
    MQTT_HOST: '',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    QUEUES_PATH: '/tmp/queues-tilemenu.yaml',
    SETS_PATH: '/tmp/sets-tilemenu.yaml',
    STORE_PATH: '/tmp/queuepilot-tilemenu.sqlite',
    WEB_PORT: String(PORT),
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

try {
  await waitReady(`${BASE}/api/queues`);

  const browser = await chromium.launch();
  // `hasTouch`, because the gesture under test is a touch long-press. The viewport is the
  // Narrow View: it is where the owner met the bug, and where the menu has least room.
  const page = await browser.newPage({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 500, height: 900 },
  });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

  /** Every write this page makes, in order, so a menu row can be asserted on its EFFECT. */
  const writes: { body: string; method: string; url: string }[] = [];
  await page.route('**/api/queues/**', async (route, request) => {
    if (request.method() === 'PATCH') {
      writes.push({ body: request.postData() || '', method: request.method(), url: request.url() });
    }
    await route.continue();
  });

  /**
   * One synthetic touch step. A string, not a function: tsx compiles a serialised callback
   * with `keepNames`, and the `__name` it emits does not exist in the page (see
   * `playwright.ts`).
   */
  const pointer = (type: string, x: number, y: number, selector = '') => page.evaluate(
    `(() => {`
    + ` const target = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : 'window'};`
    + ` if (!target) return false;`
    + ` target.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, {`
    + `   bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y},`
    + `   button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: 'touch' }));`
    + ` return true; })()`,
  );

  const dispatchContextMenu = (x: number, y: number, selector: string) => page.evaluate(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)});`
    + ` if (!el) return false;`
    + ` el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,`
    + `   clientX: ${x}, clientY: ${y} })); return true; })()`,
  );

  const state = async () => JSON.parse(String(await page.evaluate(
    `JSON.stringify({`
    + ` dragging: document.querySelectorAll('li.tile.dragging').length,`
    + ` gdrag: document.body.classList.contains('gdrag'),`
    + ` menu: !!document.querySelector('#tilemenu'),`
    + ` rows: [...document.querySelectorAll('#tilemenu button')].map((b) => b.textContent.trim()),`
    + ` sheet: !!document.querySelector('#entrymodal'),`
    + `})`,
  ))) as { dragging: number; gdrag: boolean; menu: boolean; rows: string[]; sheet: boolean };

  const thumbBox = async () => JSON.parse(String(await page.evaluate(
    `(() => { const el = document.querySelector('#grid-priority li.tile .thumb');`
    + ` if (!el) return 'null'; const r = el.getBoundingClientRect();`
    + ` return JSON.stringify([r.x + 8, r.y + 8]); })()`,
  ))) as [number, number] | null;

  // ── 1 + 2: the long press opens the MENU and picks nothing up ───────────────────────────
  await page.goto(`${BASE}/q/${ORDERED_QUEUE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#grid-priority li.tile', { timeout: 30000 });
  // Let the page SETTLE before the gesture, and do not scroll to the tile: the first one is
  // already in view at this viewport, and a scroll that is still coming to rest closes the
  // menu — correctly, because the menu is pinned to where the tile was.
  await page.waitForTimeout(2500);

  const grab = await thumbBox();
  if (!grab) throw new Error('no tile to press');

  await pointer('pointerdown', grab[0], grab[1], '#grid-priority li.tile .thumb');
  // Past the 200 ms hold that arms the gesture, and short of the ~500 ms at which a real
  // browser fires its long-press `contextmenu`.
  await page.waitForTimeout(350);

  const held = await state();
  check(
    'a held finger does not pick the tile up',
    held.dragging === 0 && !held.gdrag,
    'the drag armed during the hold, so the menu would open over a tile lifted out of its card',
  );

  await dispatchContextMenu(grab[0], grab[1], '#grid-priority li.tile .thumb');
  await page.waitForTimeout(600);

  const open = await state();
  check('the long press opens the tile menu', open.menu, `rows: ${JSON.stringify(open.rows)}`);
  check(
    'and the tile is still in its card',
    open.dragging === 0 && !open.gdrag,
    'a menu over a mid-drag tile is the bug this pins',
  );
  check(
    'the menu offers the lane moves',
    open.rows.includes('Move to the Random pool'),
    `rows: ${JSON.stringify(open.rows)}`,
  );
  check(
    'and NOT Remove — the ✕ on the card is the remove',
    !open.rows.some((r) => r.toLowerCase().includes('remove')),
    `rows: ${JSON.stringify(open.rows)}`,
  );

  await pointer('pointerup', grab[0], grab[1]);
  await page.waitForTimeout(500);

  const lifted = await state();
  check(
    'lifting the finger leaves the menu open and opens no entry sheet',
    lifted.menu && !lifted.sheet,
    `menu=${lifted.menu} sheet=${lifted.sheet}`,
  );

  // ── 5: the lane row writes placement, then the order ────────────────────────────────────
  const demotedKey = String(await page.evaluate(
    `document.querySelector('#grid-priority li.tile').dataset.key`,
  ));

  writes.length = 0;
  await page.locator('#tilemenu button', { hasText: 'Move to the Random pool' }).click();
  await page.waitForTimeout(1200);

  const placementWrite = writes.find((w) => w.url.includes('/placement'));
  const orderWrite = writes.find((w) => w.url.endsWith('/order'));
  check(
    '"Move to the Random pool" PATCHes placement: random',
    Boolean(placementWrite && JSON.parse(placementWrite.body).placement === 'random'),
    `writes: ${JSON.stringify(writes.map((w) => `${w.url.split('/api')[1]} ${w.body}`))}`,
  );
  check(
    'placement is written BEFORE the order, as the drag does',
    Boolean(placementWrite && orderWrite)
      && writes.indexOf(placementWrite!) < writes.indexOf(orderWrite!),
    'a scan landing between the two would read a half-written file',
  );

  const landedInPool = Boolean(await page.evaluate(
    `!!document.querySelector('#grid-pool li.tile[data-key=${JSON.stringify(demotedKey)}]')`,
  ));
  check('and the tile is in the pool on screen', landedInPool, 'it stayed put');

  // ── "Play this next" puts it at the HEAD of the Priority queue ──────────────────────────
  writes.length = 0;
  const poolBox = JSON.parse(String(await page.evaluate(
    `(() => { const el = document.querySelector('#grid-pool li.tile');`
    + ` if (!el) return 'null'; const r = el.getBoundingClientRect();`
    + ` return JSON.stringify([r.x + r.width / 2, r.y + 10]); })()`,
  ))) as [number, number] | null;
  if (!poolBox) throw new Error('nothing in the pool to promote');

  await dispatchContextMenu(poolBox[0], poolBox[1], '#grid-pool li.tile');
  await page.waitForTimeout(600);
  await page.locator('#tilemenu button', { hasText: 'Play this next' }).click();
  await page.waitForTimeout(1200);

  const headOrder = writes.find((w) => w.url.endsWith('/order'));
  check(
    '"Play this next" writes an order that LEADS with the entry',
    Boolean(headOrder && JSON.parse(headOrder.body).keys?.[0] === demotedKey),
    `order was ${headOrder ? JSON.stringify(JSON.parse(headOrder.body).keys?.slice(0, 3)) : 'not written'}`,
  );

  // ── 3: hold, then MOVE, and the drag still arms ─────────────────────────────────────────
  await page.goto(`${BASE}/q/${ORDERED_QUEUE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#grid-priority li.tile', { timeout: 30000 });
  await page.waitForTimeout(2500);

  const grab2 = await thumbBox();
  if (!grab2) throw new Error('no tile to drag');

  await pointer('pointerdown', grab2[0], grab2[1], '#grid-priority li.tile .thumb');
  await page.waitForTimeout(350);
  for (let i = 1; i <= 6; i += 1) {
    await pointer('pointermove', grab2[0], grab2[1] + i * 25);
    await page.waitForTimeout(30);
  }

  const dragging = await state();
  check(
    'a hold followed by a move still arms the reorder drag',
    dragging.dragging === 1 && dragging.gdrag,
    'the deferred pick-up broke the gesture it was meant to keep',
  );

  await pointer('pointerup', grab2[0], grab2[1] + 150);
  await page.waitForTimeout(900);

  // ── 4: a right-click on the poster is the MENU, not the entry sheet ─────────────────────
  await page.waitForTimeout(1200);
  const rc = await thumbBox();
  if (!rc) throw new Error('no tile to right-click');

  await page.mouse.move(rc[0], rc[1]);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(800);

  const clicked = await state();
  check(
    'a right-click on the poster opens the menu and not the entry sheet',
    clicked.menu && !clicked.sheet,
    `menu=${clicked.menu} sheet=${clicked.sheet} — the press settled as a tap and opened the sheet over it`,
  );

  // ── The BULK lane picker: a selection is promoted together ──────────────────────────────
  await page.goto(`${BASE}/q/${POOL_QUEUE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#grid-pool li.tile', { timeout: 30000 });
  await page.waitForTimeout(1500);

  await page.locator('#grid-pool li.tile .check').nth(0).click();
  await page.locator('#grid-pool li.tile .check').nth(1).click();
  await page.waitForTimeout(400);

  check(
    'the selection bar offers a Lane control on a Picks queue',
    (await page.locator('#bulklane').count()) === 1,
    'a selection could be re-weighted and moved and removed, but not promoted',
  );

  writes.length = 0;
  await page.locator('#bulklane').click();
  await page.waitForTimeout(300);
  await page.locator('[role="option"]', { hasText: 'Priority queue' }).first().click();
  await page.waitForTimeout(300);
  await page.locator('#bulkapply').click();
  // The apply RE-READS the queue before it settles the order, and this harness has no Plex —
  // so that read waits on a resolve that has to time out. Poll for the promote landing rather
  // than guessing a duration.
  // Wait for the ORDER write, not just for the tiles. The tiles are the earlier signal — the
  // promote paints from the bulk apply's own `load()`, and `settleLanes` PATCHes the order
  // after that — so breaking on the tile count alone reads the writes list one turn early and
  // reports a missing settle that is still in flight. Same fix `lane-drag-test` took.
  for (let i = 0; i < 60; i += 1) {
    const n = Number(await page.evaluate(
      `document.querySelectorAll('#grid-priority li.tile').length`,
    ));
    if (n === 2 && writes.some((w) => w.url.endsWith('/order'))) break;
    await page.waitForTimeout(500);
  }

  const bulk = writes.find((w) => w.url.endsWith('/bulk'));
  check(
    'Apply sends placement: priority for the whole selection',
    Boolean(bulk && JSON.parse(bulk.body).placement === 'priority'
      && JSON.parse(bulk.body).items?.length === 2),
    `bulk body was ${bulk?.body ?? '(not sent)'}`,
  );
  check(
    'and settles the ORDER behind it, so a promote is not left at its old file position',
    Boolean(writes.find((w) => w.url.endsWith('/order'))),
    'the entries would join the Priority queue wherever they happened to sit in the file',
  );

  const promoted = Number(await page.evaluate(
    `document.querySelectorAll('#grid-priority li.tile').length`,
  ));
  check('both entries are in the Priority queue on screen', promoted === 2, `got ${promoted}`);

  await browser.close();
} finally {
  killServer(srv);
}

console.log(failed ? `\n${failed} FAILURE(S)` : '\nALL PASS');
process.exit(failed ? 1 : 0);
