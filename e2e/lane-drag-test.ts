// DRAGGING ACROSS THE DIVIDER IS THE PROMOTE.
//
// The queue page is two lanes — a Priority queue that plays first in file order, and a
// Random pool below it (decision `2026-08-26-the-queue-page-is-two-lanes-and-the-drag-is-the-promote`).
// Moving a tile between them is the whole gesture, and there is nothing a unit test can say
// about it: the lane a tile lands in is read off the DOM at pointerup, from geometry captured
// at grab, after a drag that never re-renders.
//
// Four things it pins, and each one broke at least once while it was being written:
//
//   1. a tile dragged from the pool into the Priority lane is PATCHed `placement: priority`;
//   2. …and the order PATCH that follows lists BOTH lanes, priority first, because the file
//      is one sequence and the engine plays the priority entries in file order;
//   3. a drag that begins and ends in the POOL writes nothing at all — the pool is not
//      hand-ordered, and an accidental nudge must not save an order that means nothing;
//   4. an EMPTY lane is still a drop target. A queue with nothing promoted has no tile to aim
//      at, so the lane's own box is the slot — without it the first promote is undraggable,
//      which is the case the whole feature exists for.
//
// Browser, but NO PLEX: it drives the degraded path where tiles render unresolved but render.
// The Plex-gated suites are skipped on every PR, so a gate that lived there would never run.
//
// Usage: `server/node_modules/.bin/tsx e2e/lane-drag-test.ts`  (spawns its own server)
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = parseInt(process.env.WEB_PORT || '18981', 10);
const BASE = `http://localhost:${PORT}`;
// `bob_anime` is the fixture's RANDOM-order queue, so every entry starts in the pool and a
// promote is a drag upwards into an empty Priority lane — cases 1, 2 and 4 in one gesture.
const POOL_QUEUE = 'bob_anime';
// `bob` is priority-by-default: everything starts in the Priority lane, so its pool is the
// empty one and a demote is the drag downwards.
const ORDERED_QUEUE = 'bob';

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

await fs.copyFile(`${ROOT}/e2e/fixtures/queues.harness.yaml`, '/tmp/queues-lanedrag.yaml');
await fs.copyFile(`${ROOT}/e2e/fixtures/sets.fixture.yaml`, '/tmp/sets-lanedrag.yaml');
for (const lock of ['/tmp/queues-lanedrag.yaml.lock', '/tmp/sets-lanedrag.yaml.lock']) {
  await fs.rm(lock, { force: true });
}

const srv = spawnServer({
  env: {
    ...process.env,
    HISTORY_PATH: '/tmp/.history-lanedrag.json',
    MQTT_HOST: '',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    QUEUES_PATH: '/tmp/queues-lanedrag.yaml',
    SETS_PATH: '/tmp/sets-lanedrag.yaml',
    STORE_PATH: '/tmp/queuepilot-lanedrag.sqlite',
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
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

  /** Every write this page makes, in order, so a gesture can be asserted on its EFFECT. */
  const writes: { body: string; method: string; url: string }[] = [];
  await page.route('**/api/queues/**', async (route, request) => {
    const method = request.method();
    if (method === 'PATCH') {
      writes.push({ body: request.postData() || '', method, url: request.url() });
    }
    await route.continue();
  });

  /** Centre of a `.thumb`, which is the only part of a tile the drag arms from. */
  const centreOf = async (selector: string) => JSON.parse(String(await page.evaluate(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)});`
    + ` if (!el) return 'null'; const r = el.getBoundingClientRect();`
    + ` return JSON.stringify([r.x + r.width / 2, r.y + r.height / 2]); })()`,
  ))) as [number, number] | null;

  /** A slow, deliberate pointer drag — the same motion `drag-stability-test` uses. */
  const dragTo = async (from: [number, number], to: [number, number]) => {
    await page.mouse.move(from[0], from[1]);
    await page.mouse.down();
    for (let i = 1; i <= 24; i += 1) {
      await page.mouse.move(
        from[0] + ((to[0] - from[0]) * i) / 24,
        from[1] + ((to[1] - from[1]) * i) / 24,
      );
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
    await page.waitForTimeout(700);
  };

  // ── A POOL queue: both lanes render, and the Priority one is an empty drop strip ────────
  await page.goto(`${BASE}/q/${POOL_QUEUE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#grid-pool li.tile', { timeout: 30000 });
  await page.waitForTimeout(1500);

  const laneCount = Number(await page.evaluate(
    `document.querySelectorAll('#grid ul.grid[data-lane]').length`,
  ));
  check('the page renders two lanes', laneCount === 2, `got ${laneCount}`);

  const hasStrip = Boolean(await page.evaluate(
    `!!document.querySelector('ul.grid[data-lane="priority"] .dropstrip')`,
  ));
  check(
    'an empty Priority lane renders a drop strip, not nothing',
    hasStrip,
    'no `.dropstrip` — the first promote would have nothing to aim at',
  );

  const stripBox = await centreOf('ul.grid[data-lane="priority"] .dropstrip');
  const firstPoolTile = await centreOf('#grid-pool li.tile .thumb');
  assert.ok(stripBox && firstPoolTile, 'need both a strip and a pool tile to drag');

  const promotedKey = String(await page.evaluate(
    `document.querySelector('#grid-pool li.tile').dataset.key`,
  ));

  writes.length = 0;
  await dragTo(firstPoolTile, stripBox);

  const placementWrite = writes.find((w) => w.url.includes('/placement'));
  check(
    'a drag into the Priority lane PATCHes placement: priority',
    Boolean(placementWrite && JSON.parse(placementWrite.body).placement === 'priority'),
    `writes: ${JSON.stringify(writes.map((w) => w.url.split('/api')[1]))}`,
  );

  const orderWrite = writes.find((w) => w.url.endsWith('/order'));
  check(
    'and the order that follows leads with the promoted entry',
    Boolean(orderWrite && JSON.parse(orderWrite.body).keys?.[0] === promotedKey),
    `order was ${orderWrite ? JSON.stringify(JSON.parse(orderWrite.body).keys?.slice(0, 3)) : 'not written'}`,
  );

  check(
    'placement is written BEFORE the order',
    Boolean(placementWrite && orderWrite)
      && writes.indexOf(placementWrite!) < writes.indexOf(orderWrite!),
    'a scan landing between the two would read a half-written file',
  );

  // WAIT for it, do not read it once.
  //
  // The optimistic lane is written to the store during pointerup and painted on React's next
  // commit; the three checks above are satisfied the moment the network writes are OBSERVED.
  // Those two are not ordered with respect to each other, so a bare `evaluate()` here is a
  // race — it read the DOM one commit early on CI run 33037647755 and passed on a re-run of
  // the same commit, which is the signature of a flake and cost an afternoon of looking for
  // a regression that was not there.
  //
  // The CLAIM is unchanged and is not weakened: the tile must be in the Priority lane, and a
  // tile that snapped back never arrives, so this still fails — ten seconds later.
  //
  // Two seconds was enough until the read cache landed. Phase 3 (`/api/queues?fresh=1`) now
  // re-reads every provider behind the page that has already painted, and on a CI runner
  // that pass is in flight at exactly this moment: the same drag, the same commit, failed on
  // CI run 33052181234 and passed on the re-run of it. The commit this waits for is not late
  // because anything is wrong, it is late because the machine is busy. Waiting longer costs a
  // green run nothing — it returns the moment the tile arrives — and costs a genuine
  // snap-back only the extra seconds before it reports.
  const landed = await page
    .waitForFunction(
      (key) =>
        !!document.querySelector(
          `ul.grid[data-lane="priority"] li.tile[data-key="${(key as string).replace(/["\\]/g, '\\$&')}"]`,
        ),
      promotedKey,
      { timeout: 10000 },
    )
    .then(() => true)
    .catch(() => false);
  check('the tile is now in the Priority lane on screen', landed, 'it snapped back');

  // ── A drag that stays in the POOL writes nothing ────────────────────────────────────────
  const poolA = await centreOf('#grid-pool li.tile .thumb');
  const poolB = await centreOf('#grid-pool li.tile:nth-child(3) .thumb');
  assert.ok(poolA && poolB, 'need two pool tiles');

  writes.length = 0;
  await dragTo(poolA, poolB);
  check(
    'a drag inside the pool saves nothing',
    writes.length === 0,
    `wrote ${JSON.stringify(writes.map((w) => w.url.split('/api')[1]))} — the pool is shuffled at playback, so its order is not a thing to save`,
  );

  // ── An ORDERED queue: the pool is the empty lane, and the drag down is a demote ─────────
  await page.goto(`${BASE}/q/${ORDERED_QUEUE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#grid-priority li.tile', { timeout: 30000 });
  await page.waitForTimeout(1500);

  const poolStrip = await centreOf('ul.grid[data-lane="random"] .dropstrip');
  const firstOrdered = await centreOf('#grid-priority li.tile .thumb');
  assert.ok(poolStrip && firstOrdered, 'need a pool strip and an ordered tile');

  const demotedKey = String(await page.evaluate(
    `document.querySelector('#grid-priority li.tile').dataset.key`,
  ));

  writes.length = 0;
  await dragTo(firstOrdered, poolStrip);

  const demote = writes.find((w) => w.url.includes('/placement'));
  check(
    'a drag into the pool PATCHes placement: random',
    Boolean(demote && JSON.parse(demote.body).placement === 'random'),
    `writes: ${JSON.stringify(writes.map((w) => `${w.url.split('/api')[1]} ${w.body}`))}`,
  );
  check(
    'and it names the entry that was dragged',
    Boolean(demote?.url.includes(encodeURIComponent(demotedKey))),
    `patched ${demote?.url.split('/items/')[1]}, dragged ${demotedKey}`,
  );

  // ── TOUCH: the number owns its hold, and a poster hold always becomes a drag ───────────
  await page.setViewportSize({ width: 390, height: 640 });
  await page.goto(`${BASE}/q/${ORDERED_QUEUE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#grid-priority li.tile .priority-position', { timeout: 30000 });
  await page.waitForTimeout(1000);

  await page.evaluate(() => {
    const input = document.querySelector('#grid-priority .priority-position');
    input?.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      button: 2,
      cancelable: true,
    }));
  });
  check(
    'a hold on the Priority number does not open the tile menu',
    !await page.locator('#tilemenu:not([hidden])').count(),
    'the number press passed through to the poster action',
  );

  const main = page.locator('main');
  await main.evaluate((element) => {
    element.scrollTop = (element.scrollHeight - element.clientHeight) / 2;
  });
  const touchTiles = page.locator('#grid-priority li.tile .thumb');
  const mainBox = await main.boundingBox();
  assert.ok(mainBox, 'need the Main scroll region');
  let visibleTileIndex = -1;
  for (let index = 0; index < await touchTiles.count(); index += 1) {
    const box = await touchTiles.nth(index).boundingBox();
    if (box && box.y >= mainBox.y
      && box.y + box.height <= mainBox.y + mainBox.height) {
      visibleTileIndex = index;
      break;
    }
  }
  assert.ok(visibleTileIndex >= 0, 'need a Priority poster inside the Main viewport');
  const touchTile = touchTiles.nth(visibleTileIndex);
  const touchBox = await touchTile.boundingBox();
  assert.ok(touchBox, 'need a visible Priority poster for the touch gesture');
  const touchStart = {
    x: touchBox.x + touchBox.width / 2,
    y: touchBox.y + touchBox.height / 2,
  };

  await touchTile.evaluate((element, start) => {
    element.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      button: 0,
      buttons: 1,
      clientX: start.x,
      clientY: start.y,
      pointerId: 41,
      pointerType: 'touch',
    }));
  }, touchStart);
  await page.waitForTimeout(250);

  check(
    'a touch hold picks up the tile without a just-right movement window',
    await touchTile.evaluate((element) => element.closest('li.tile')?.classList.contains('dragging') === true),
    'the tile was not dragging after the 200 ms hold',
  );

  await touchTile.evaluate((element) => {
    element.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      button: 2,
      cancelable: true,
    }));
  });
  check(
    'the later touch contextmenu cannot replace an armed drag',
    !await page.locator('#tilemenu:not([hidden])').count()
      && await touchTile.evaluate((element) => element.closest('li.tile')?.classList.contains('dragging') === true),
    'the Play / lane menu opened over the drag',
  );

  const scrollBefore = await main.evaluate((element) => element.scrollTop);
  const scrollOwnerState = await touchTile.evaluate((element) => {
    const owners = [];
    let ancestor = element.parentElement;

    while (ancestor) {
      const overflowY = getComputedStyle(ancestor).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') {
        owners.push({
          className: ancestor.className,
          clientHeight: ancestor.clientHeight,
          scrollHeight: ancestor.scrollHeight,
          scrollTop: ancestor.scrollTop,
          tagName: ancestor.tagName,
        });
      }
      ancestor = ancestor.parentElement;
    }

    return owners;
  });
  await page.evaluate(({ x, y }) => {
    window.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      button: 0,
      buttons: 1,
      clientX: x,
      clientY: y,
      pointerId: 41,
      pointerType: 'touch',
    }));
  }, { x: touchStart.x, y: 638 });
  await page.waitForTimeout(500);
  const scrollAfter = await main.evaluate((element) => element.scrollTop);
  check(
    'holding a dragged tile at the viewport edge scrolls to later items',
    scrollAfter > scrollBefore,
    `scroll stayed at ${scrollBefore} (after ${scrollAfter}); owners ${JSON.stringify(scrollOwnerState)}`,
  );

  await page.evaluate(({ x, y }) => {
    window.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true,
      button: 0,
      buttons: 0,
      clientX: x,
      clientY: y,
      pointerId: 41,
      pointerType: 'touch',
    }));
  }, { x: touchStart.x, y: 638 });
  await page.waitForTimeout(500);

  await browser.close();
} finally {
  killServer(srv);
}

console.log(failed ? `\n${failed} FAILURE(S)` : '\nALL PASS');
process.exit(failed ? 1 : 0);
