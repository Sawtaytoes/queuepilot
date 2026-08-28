// THE TILE'S THREE CONTROLS: remove, select, and move between the lanes.
//
// Two reports on 2026-08-26, one gate — both are about the same stack of chrome, and neither
// is something a unit test can see.
//
//   1. "Checkbox icon isn't working." The select circle painted the SAME in every state. The
//      rule that fills it accent when the tile is selected (`.tile.selected .check`, 0-2-1) is
//      outranked by the rule that draws the circle at all (`.editable .tile .tilechrome
//      .check`, 0-3-1), so the checked state never landed and the mark — a text `✓` under
//      `color: transparent` — never painted in any state. The click worked the whole time,
//      which is why nothing caught it: the selection bar appeared, and the tile looked
//      untouched.
//
//      **This is a computed-style assertion on purpose.** tsc cannot read CSS, Biome sees a
//      string, and axe passes an invisible glyph. The only thing that can tell "checked" from
//      "unchecked" here is asking the browser what it painted.
//
//   2. "instead of right-click, I think we should add a 3rd icon under the checkbox that
//      allows you to move it into Priority or out of Priority." The drag across the divider
//      stays; this is the same write from a button
//      (decision `2026-08-26-a-tile-carries-a-lane-control-and-the-select-mark-paints`).
//
// Browser, but NO PLEX: it drives the degraded path where tiles render unresolved but render.
// The Plex-gated suites are skipped on every PR, so a gate that lived there would never run.
//
// Usage: `server/node_modules/.bin/tsx e2e/tile-lane-test.ts`  (spawns its own server)
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = parseInt(process.env.WEB_PORT || '18984', 10);
const BASE = `http://localhost:${PORT}`;
// The fixture's RANDOM-order queue: every entry starts in the pool, so the first press of the
// lane control is a promote into an empty Priority lane.
const POOL_QUEUE = 'bob_anime';
// Priority-by-default, so its tiles start promoted and the same control is a demote.
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

await fs.copyFile(`${ROOT}/e2e/fixtures/queues.harness.yaml`, '/tmp/queues-tilelane-gate.yaml');
await fs.copyFile(`${ROOT}/e2e/fixtures/sets.fixture.yaml`, '/tmp/sets-tilelane-gate.yaml');
for (const p of [
  '/tmp/queues-tilelane-gate.yaml.lock', '/tmp/sets-tilelane-gate.yaml.lock',
  '/tmp/queuepilot-tilelane-gate.sqlite',
]) {
  await fs.rm(p, { force: true, recursive: true });
}

const srv = spawnServer({
  env: {
    ...process.env,
    HISTORY_PATH: '/tmp/.history-tilelane-gate.json',
    MQTT_HOST: '',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    QUEUES_PATH: '/tmp/queues-tilelane-gate.yaml',
    SETS_PATH: '/tmp/sets-tilelane-gate.yaml',
    STORE_PATH: '/tmp/queuepilot-tilelane-gate.sqlite',
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

  /** Every write this page makes, so a press can be asserted on its EFFECT. */
  const writes: { body: string; method: string; url: string }[] = [];
  await page.route('**/api/queues/**', async (route, request) => {
    if (request.method() === 'PATCH') {
      writes.push({ body: request.postData() || '', method: 'PATCH', url: request.url() });
    }
    await route.continue();
  });

  // ── The pool queue: the stack, the mark, and a promote ──────────────────────────────────
  await page.goto(`${BASE}/q/${POOL_QUEUE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#grid-pool li.tile', { timeout: 30000 });
  await page.waitForTimeout(1200);

  const firstTile = page.locator('#grid-pool li.tile').first();
  const controls = await firstTile.evaluate((el) =>
    [...el.querySelectorAll('.tilechrome > *')].map((c) => c.className));
  check(
    'the chrome stack carries remove, check and the lane control',
    ['remove', 'check', 'lanebtn'].every((c) => controls.includes(c)),
    `got [${controls.join(', ')}]`,
  );

  const isButton = await firstTile.locator('.check').evaluate((el) => el.tagName);
  check(
    'the select control is a BUTTON, not a span nobody can reach',
    isButton === 'BUTTON',
    `got <${isButton.toLowerCase()}>`,
  );
  check(
    '…and it is not aria-hidden',
    (await firstTile.locator('.check').getAttribute('aria-hidden')) === null,
  );

  /** What the browser actually painted for the circle and its mark. */
  const paint = () => firstTile.locator('.check').evaluate((el) => {
    const svg = el.querySelector('svg');
    return {
      background: getComputedStyle(el).backgroundColor,
      markOpacity: svg ? getComputedStyle(svg).opacity : null,
      pressed: el.getAttribute('aria-pressed'),
    };
  });

  await firstTile.locator('.thumb').hover();
  await page.waitForTimeout(300);
  const atRest = await paint();
  check('unchecked, the mark does not paint', atRest.markOpacity === '0', JSON.stringify(atRest));
  check('unchecked announces aria-pressed="false"', atRest.pressed === 'false');

  await firstTile.locator('.check').click();
  await page.waitForTimeout(400);
  const checked = await paint();
  check(
    'CHECKED, the mark paints — the reported bug',
    checked.markOpacity === '1',
    `mark opacity ${checked.markOpacity}; the checked rule is being outranked again`,
  );
  check(
    'CHECKED, the circle fills — it must not look identical to unchecked',
    checked.background !== atRest.background,
    `both states painted ${checked.background}`,
  );
  check('checked announces aria-pressed="true"', checked.pressed === 'true');

  // Clear the selection: the lane control is a separate claim, and "move mode" (a poster tap
  // toggles selection once anything is checked) would answer the next press instead.
  await firstTile.locator('.check').click();
  await page.waitForTimeout(400);

  const promoteLabel = await firstTile.locator('.lanebtn').getAttribute('aria-label');
  check(
    'a pooled tile offers to move INTO the Priority queue',
    promoteLabel === 'Move to the Priority queue',
    `got ${JSON.stringify(promoteLabel)}`,
  );

  const promotedTitle = (await firstTile.locator('.title').textContent() || '').trim();
  writes.length = 0;
  await firstTile.locator('.thumb').hover();
  await firstTile.locator('.lanebtn').click();
  await page.waitForFunction(
    (expectedTitle) => [...document.querySelectorAll('ul.grid[data-lane="priority"] li.tile .title')]
      .some((el) => (el.textContent || '').trim() === expectedTitle),
    promotedTitle,
    { timeout: 20000 },
  );
  await page.waitForTimeout(600);

  const placementWrite = writes.find((w) => w.url.includes('/placement'));
  check(
    'the press PATCHes the placement',
    Boolean(placementWrite) && JSON.parse(placementWrite!.body).placement === 'priority',
    JSON.stringify(placementWrite ?? null),
  );
  const orderWrite = writes.find((w) => w.url.endsWith('/order'));
  check(
    '…and an order PATCH follows it, never the other way round',
    Boolean(orderWrite)
      && writes.indexOf(placementWrite!) < writes.indexOf(orderWrite!),
    `writes: ${writes.map((w) => w.url.split('/').pop()).join(' → ')}`,
  );

  const priorityTitles = await page.$$eval(
    'ul.grid[data-lane="priority"] li.tile .title',
    (els) => els.map((e) => (e.textContent || '').trim()),
  );
  check(
    'the promoted entry is in the Priority lane',
    priorityTitles.includes(promotedTitle),
    `lane holds [${priorityTitles.join(', ')}], expected ${promotedTitle}`,
  );

  // It has to SURVIVE a reload: the optimistic move is a repaint, and the file is the claim.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    (expectedTitle) => [...document.querySelectorAll('ul.grid[data-lane="priority"] li.tile .title')]
      .some((el) => (el.textContent || '').trim() === expectedTitle),
    promotedTitle,
    { timeout: 30000 },
  );
  await page.waitForTimeout(1200);
  const afterReload = await page.$$eval(
    'ul.grid[data-lane="priority"] li.tile .title',
    (els) => els.map((e) => (e.textContent || '').trim()),
  );
  check(
    'the move survives a reload — the file agrees with the screen',
    afterReload.includes(promotedTitle),
    `lane holds [${afterReload.join(', ')}]`,
  );

  // ── The ordered queue: the same control is a DEMOTE, and it writes no order ─────────────
  await page.goto(`${BASE}/q/${ORDERED_QUEUE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#grid-priority li.tile', { timeout: 30000 });
  await page.waitForTimeout(1200);

  const promoted = page.locator('#grid-priority li.tile').first();
  const demoteLabel = await promoted.locator('.lanebtn').getAttribute('aria-label');
  check(
    'a promoted tile offers to move OUT of the Priority queue',
    demoteLabel === 'Move out of the Priority queue',
    `got ${JSON.stringify(demoteLabel)}`,
  );

  writes.length = 0;
  await promoted.locator('.thumb').hover();
  await promoted.locator('.lanebtn').click();
  await page.waitForFunction(
    () => document.querySelectorAll('ul.grid[data-lane="random"] li.tile').length >= 1,
    undefined,
    { timeout: 20000 },
  );
  await page.waitForTimeout(600);

  const demoteWrite = writes.find((w) => w.url.includes('/placement'));
  check(
    'the demote PATCHes placement: random',
    Boolean(demoteWrite) && JSON.parse(demoteWrite!.body).placement === 'random',
    JSON.stringify(demoteWrite ?? null),
  );
  // CHANGED 2026-08-27, and the old claim was the opposite one: "the demote writes NO order".
  //
  // The arrow and the tile menu's two lane rows were two functions computing the file order
  // two ways, and they disagreed here — the menu's demote wrote an order, the arrow's did not.
  // They are one function now (`setEntryLane`), so one of the two claims had to go, and this
  // is the one that goes: the file is ONE sequence, and an entry that leaves the Priority
  // queue has to leave the priority run of the file with it. It is also what the drag across
  // the divider has always written, which is the precedent the arrow says it follows.
  //
  // Nothing on screen changes either way — `splitLanes` re-derives the lanes from `placement`
  // — so what this pins is the FILE, and the order the two writes go out in.
  const demoteOrderWrite = writes.find((w) => w.url.endsWith('/order'));
  check(
    'the demote writes the order too — the file is one sequence, so it must agree with the lane',
    Boolean(demoteOrderWrite),
    `writes: ${writes.map((w) => w.url.split('/').pop()).join(' → ')}`,
  );
  check(
    '…and placement still goes FIRST, so the file never says a lane the order contradicts',
    Boolean(
      demoteWrite
        && demoteOrderWrite
        && writes.indexOf(demoteWrite) < writes.indexOf(demoteOrderWrite),
    ),
    `writes: ${writes.map((w) => w.url.split('/').pop()).join(' → ')}`,
  );

  await browser.close();
} finally {
  killServer(srv);
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll tile-lane checks passed.');
process.exit(failed ? 1 : 0);
