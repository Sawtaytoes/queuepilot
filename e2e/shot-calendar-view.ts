// Before/after shots for the calendar view
// (decision `2026-09-08-a-calendar-view-is-a-second-editor-for-date-based-queue-settings`).
//
//   SHOT_TAG=before server/node_modules/.bin/tsx e2e/shot-calendar-view.ts
//   SHOT_TAG=after  server/node_modules/.bin/tsx e2e/shot-calendar-view.ts
//
// Four panels, and on a `before` build three of them SKIP rather than lie — the route does not
// exist there, and the SPA fallback would otherwise hand back a screenshot of the task home
// with a calendar's filename on it:
//
//   1. the task home's Manage row — where the destination is reached from;
//   2. `/calendar` itself, the list of scheduled queues;
//   3. a date being EDITED, with the month panel open. A shot of a closed trigger says nothing
//      about a picker, and this view's whole claim is that it edits;
//   4. the Narrow View at 390px, which is where four pickers on a row have to wrap.
//
// Panel 5 is on both builds and is the point of the feature rather than a diff: the SAME two
// settings, in the queue's own editor. Neither surface owns the value.
//
// ⚠️ THE FIXTURE IS SYNTHETIC AND MUST STAY THAT WAY. This repo is public and these PNGs are
// committed under `docs/images/` forever; a PNG is opaque to every grep, so nobody notices a
// real queue name in one the way they notice one in a diff.
import { promises as fs } from 'node:fs';

import { chromium } from './playwright.js';
import { killServer, spawnServer, REPO_ROOT } from './stubs/server-process.mjs';

const TAG = process.env.SHOT_TAG || 'after';
const PORT = parseInt(process.env.WEB_PORT || '18993', 10);
const BASE = `http://localhost:${PORT}`;
const OUT = '__screenshots__';
const QUEUES = '/tmp/qp-calendar-shot.queues.yaml';
const SETS = '/tmp/qp-calendar-shot.sets.yaml';

await fs.mkdir(OUT, { recursive: true });
await fs.copyFile(`${REPO_ROOT}/e2e/fixtures/queues.harness.yaml`, QUEUES);
await fs.copyFile(`${REPO_ROOT}/e2e/fixtures/calendar.sets.yaml`, SETS);
for (const p of [`${QUEUES}.lock`, `${SETS}.lock`]) {
  await fs.rm(p, { force: true, recursive: true });
}
await fs.rm('/tmp/qp-calendar-shot.sqlite', { force: true });

let failed = false;
const srv = spawnServer({
  env: {
    ...process.env,
    HISTORY_PATH: '/tmp/qp-calendar-shot.history.json',
    MQTT_HOST: '',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    QUEUES_PATH: QUEUES,
    SETS_PATH: SETS,
    STORE_PATH: '/tmp/qp-calendar-shot.sqlite',
    WEB_PORT: String(PORT),
  },
  stdio: 'ignore',
});

const ready = async (): Promise<void> => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/sets`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('server never came up');
    await new Promise((r) => setTimeout(r, 300));
  }
};

/** The first `store.load()` ends with a "Ready" status. On the no-Plex path its `/api/queues`
 *  half takes about ten seconds, and a shot taken inside that window is a page mid-load. */
const settle = async (page: import('./playwright.js').Page): Promise<void> => {
  await page
    .waitForFunction(
      () => (document.querySelector('#status')?.textContent ?? '') === 'Ready',
      undefined,
      { timeout: 90_000 },
    )
    .catch(() => null);
  await page.waitForTimeout(400);
};

try {
  await ready();

  const browser = await chromium.launch();
  const page = await browser.newPage({
    colorScheme: 'dark',
    viewport: { width: 1280, height: 1100 },
  });

  // ── 1. The task home ────────────────────────────────────────────────────────────────────
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#mode-landing', { timeout: 30_000 });
  await page.waitForTimeout(600);
  await page.locator('.mode-management').screenshot({
    path: `${OUT}/calendar-task-home-${TAG}.png`,
  });
  console.log(`wrote ${OUT}/calendar-task-home-${TAG}.png`);

  // ── 2-4. The view, which does not exist on a `before` build ─────────────────────────────
  await page.goto(`${BASE}/calendar`, { waitUntil: 'domcontentloaded' });
  const hasView = await page
    .waitForSelector('#calendar-rows', { timeout: 20_000 })
    .then(() => true, () => false);

  if (hasView) {
    await settle(page);
    await page.screenshot({ path: `${OUT}/calendar-list-${TAG}.png` });
    console.log(`wrote ${OUT}/calendar-list-${TAG}.png`);

    // A DATE BEING EDITED. The panel portals to <body>, so this is a shot of the page rather
    // than a clip of the row — a row-scoped clip would cut the option list off at its edge.
    await page.locator('[data-set="bob"]').scrollIntoViewIfNeeded();
    await page.click('[data-testid="calendar-bob-reset-month"]');
    await page.waitForSelector('[role="listbox"] [role="option"]', { timeout: 10_000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/calendar-editing-${TAG}.png` });
    console.log(`wrote ${OUT}/calendar-editing-${TAG}.png`);

    const narrow = await browser.newPage({
      colorScheme: 'dark',
      viewport: { width: 390, height: 1200 },
    });
    await narrow.goto(`${BASE}/calendar`, { waitUntil: 'domcontentloaded' });
    await narrow.waitForSelector('#calendar-rows', { timeout: 30_000 });
    await settle(narrow);
    await narrow.screenshot({ path: `${OUT}/calendar-narrow-${TAG}.png` });
    console.log(`wrote ${OUT}/calendar-narrow-${TAG}.png`);
    const overflow = await narrow.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    console.log(
      `narrow view: scrollWidth ${overflow.scroll} vs clientWidth ${overflow.client}`,
      overflow.scroll <= overflow.client ? '✓ no sideways scroll' : '✗ SCROLLS',
    );
    await narrow.close();
  } else {
    console.log('calendar view: SKIPPED — the route does not exist on this build.');
  }

  // ── 5. THE SAME SETTINGS, in the queue's own editor ─────────────────────────────────────
  // On both builds. The calendar is a SECOND editor and neither surface owns the value, so
  // this panel is what the reader compares the new page against.
  await page.goto(`${BASE}/q/bob`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#grid', { timeout: 30_000 });
  await page.click('#qconfigure');
  await page.waitForSelector('#setmodal', { timeout: 10_000 });
  const season = page.locator('#set-season');
  if (await season.count()) {
    await season.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await page.locator('#setmodal').screenshot({
      path: `${OUT}/calendar-set-editor-${TAG}.png`,
    });
    console.log(`wrote ${OUT}/calendar-set-editor-${TAG}.png`);
  } else {
    console.log('set editor: SKIPPED — the season row does not exist on this build.');
  }

  await browser.close();
} catch (e) {
  console.log('SHOT FAILED:', e);
  failed = true;
} finally {
  killServer(srv);
  process.exit(failed ? 1 : 0);
}
