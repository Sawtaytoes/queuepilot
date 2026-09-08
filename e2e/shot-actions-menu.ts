// Before/after shots for the queue toolbar's Actions menu
// (decision `2026-09-08-a-destructive-queue-action-lives-in-an-actions-menu-behind-a-confirm`).
//
//   SHOT_TAG=before server/node_modules/.bin/tsx e2e/shot-actions-menu.ts
//   SHOT_TAG=after  server/node_modules/.bin/tsx e2e/shot-actions-menu.ts
//
// Four panels, and the first is the only one both builds can produce:
//
//   1. THE TOOLBAR ROW. The whole point of the change is what this row holds — `Remove all
//      completed` used to sit two controls from `▶ Play on ▾`, and it is a menu now.
//   2. THE MENU OPEN. A shot of a closed trigger says nothing about a menu.
//   3. THE CONFIRM OPEN, with a real count in its heading. "Clear 2 completions in …?" is the
//      assertion the record is about, and a picture is how a reader checks it a year later.
//   4. THE NARROW VIEW. Taken on BOTH builds, because the row that wraps is the thing the
//      change is about — with the menu open where there is one.
//
// Panels 2 and 3 are SKIPPED when the build has no `#qactions`, so the same script produces
// the `before` on a tree that predates the menu.
//
// ⚠️ THE FIXTURE IS SYNTHETIC AND MUST STAY THAT WAY. This repo is public and these PNGs are
// committed under `docs/images/` forever; a PNG is opaque to every grep, so nobody notices a
// real queue name in one the way they notice one in a diff.
//
// Self-contained: it boots its own server over /tmp copies of the harness fixtures, and every
// scratch path and the port carry a suffix nothing else in the repo uses, because sibling
// agents run these harnesses at the same time.
import { promises as fs } from 'node:fs';

import { chromium } from './playwright.js';
import { killServer, spawnServer, REPO_ROOT } from './stubs/server-process.mjs';

const TAG = process.env.SHOT_TAG || 'after';
const PORT = parseInt(process.env.WEB_PORT || '18988', 10);
const BASE = `http://localhost:${PORT}`;
const OUT = '__screenshots__';
const QUEUES = '/tmp/qp-shot-actions-menu.queues.yaml';
const SETS = '/tmp/qp-shot-actions-menu.sets.yaml';
// Two `done: true` entries, and a typed label — so the confirm reads
// "Clear 2 completions in Bob — Movies?".
const QUEUE = 'bob';

await fs.mkdir(OUT, { recursive: true });
await fs.copyFile(`${REPO_ROOT}/e2e/fixtures/queues.harness.yaml`, QUEUES);
await fs.copyFile(`${REPO_ROOT}/e2e/fixtures/sets.fixture.yaml`, SETS);
for (const p of [`${QUEUES}.lock`, `${SETS}.lock`]) {
  await fs.rm(p, { recursive: true, force: true });
}
await fs.rm('/tmp/qp-shot-actions-menu.sqlite', { force: true });
await fs.rm('/tmp/qp-shot-actions-menu.history.json', { force: true });

let failed = false;
const srv = spawnServer({
  env: {
    ...process.env,
    HISTORY_PATH: '/tmp/qp-shot-actions-menu.history.json',
    MQTT_HOST: '',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    QUEUES_PATH: QUEUES,
    SETS_PATH: SETS,
    STORE_PATH: '/tmp/qp-shot-actions-menu.sqlite',
    WEB_PORT: String(PORT),
  },
  stdio: 'ignore',
});

const ready = async (): Promise<void> => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(`${BASE}/api/queues`)).ok) return; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server never came up');
    await new Promise((r) => setTimeout(r, 300));
  }
};

try {
  await ready();

  const browser = await chromium.launch();
  const page = await browser.newPage({
    colorScheme: 'dark',
    viewport: { width: 1440, height: 1000 },
  });

  /**
   * Open the queue and wait for the TILES, not for the toolbar. `#qtoolbar` paints before
   * `/api/queues` answers, and the Actions menu is a function of what that payload says is
   * `done` — read the page in that gap and a build that HAS the menu photographs without it.
   */
  const openQueue = async () => {
    await page.goto(`${BASE}/q/${QUEUE}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#grid li.tile', { timeout: 30_000 });
    await page.waitForTimeout(1500);
  };

  // ── 1. The toolbar row ──────────────────────────────────────────────────────────────────
  await openQueue();
  await page.locator('#queue .add').screenshot({
    path: `${OUT}/actions-menu-toolbar-${TAG}.png`,
  });
  console.log(`wrote ${OUT}/actions-menu-toolbar-${TAG}.png`);

  const labels = await page.locator('#queue .add button').allInnerTexts();
  console.log(`toolbar buttons: ${JSON.stringify(labels.map((l) => l.trim()))}`);

  const hasMenu = Boolean(await page.locator('#qactions').count());
  console.log(`Actions menu ${hasMenu ? 'PRESENT ✓' : 'absent ✗'} on this build`);

  if (hasMenu) {
    // ── 2. The menu, OPEN ─────────────────────────────────────────────────────────────────
    // A PAGE shot, not an element clip: the panel portals to `<body>`, so a clip of the
    // toolbar would cut off the very thing being photographed.
    await page.click('#qactions');
    await page.waitForSelector('.qactionsmenu [role="menuitem"]', { timeout: 10_000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/actions-menu-open-${TAG}.png` });
    console.log(`wrote ${OUT}/actions-menu-open-${TAG}.png`);
    console.log(
      `rows: ${JSON.stringify(
        (await page.locator('.qactionsmenu [role="menuitem"]').allInnerTexts()).map((r) => r.trim()),
      )}`,
    );

    // ── 3. The confirm, OPEN, with a real count ───────────────────────────────────────────
    await page
      .locator('.qactionsmenu [role="menuitem"]', { hasText: 'Mark all unwatched' })
      .click();
    await page.waitForSelector('#qactionsconfirm', { timeout: 10_000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/actions-menu-confirm-${TAG}.png` });
    console.log(`wrote ${OUT}/actions-menu-confirm-${TAG}.png`);
    console.log(
      `confirm says: ${String(await page.evaluate(`document.querySelector('[role="dialog"] h2, [role="dialog"] h3').textContent.trim()`))}`,
    );

    // Cancel rather than confirm — the shot is the question, and running the reset would
    // empty the queue the next panel photographs.
    await page.click('#qactionscancel');
    await page.waitForTimeout(400);
  } else {
    console.log('panels 2–3: SKIPPED — this build has no Actions menu.');
  }

  // ── 4. The Narrow View ────────────────────────────────────────────────────────────────
  // Taken on BOTH builds, because the row that wraps is the thing the change is about — and
  // with the menu OPEN where there is one, since a portalled `position: fixed` panel at 430px
  // is exactly what hangs off the right edge when it goes wrong.
  await page.setViewportSize({ width: 430, height: 932 });
  await openQueue();

  if (hasMenu) {
    await page.click('#qactions');
    await page.waitForSelector('.qactionsmenu [role="menuitem"]', { timeout: 10_000 });
    await page.waitForTimeout(400);
  }

  await page.screenshot({ path: `${OUT}/actions-menu-narrow-${TAG}.png` });
  console.log(`wrote ${OUT}/actions-menu-narrow-${TAG}.png`);

  if (hasMenu) {
    // A screenshot alone does not settle an overflow — read the box.
    const box = JSON.parse(String(await page.evaluate(
      `(() => { const p = document.querySelector('.qactionsmenu');`
      + ` if (!p) return 'null'; const r = p.getBoundingClientRect();`
      + ` return JSON.stringify({ left: Math.round(r.left), right: Math.round(r.right),`
      + `   width: Math.round(window.innerWidth) }); })()`,
    ))) as { left: number; right: number; width: number } | null;
    console.log(`narrow panel box: ${JSON.stringify(box)}`);
  }

  await browser.close();
} catch (e) {
  console.log('SHOT FAILED:', e);
  failed = true;
} finally {
  killServer(srv);
  process.exit(failed ? 1 : 0);
}
