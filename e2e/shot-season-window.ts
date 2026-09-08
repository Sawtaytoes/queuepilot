// Before/after shots for the SEASON WINDOW
// (decision `2026-09-08-a-season-window-gates-the-existing-enabled-flag`).
//
//   SHOT_TAG=after server/node_modules/.bin/tsx e2e/shot-season-window.ts
//
// Two panels, because the change lands in two places: the queue EDITOR grows the row that
// states the window, and the Picks SHELF grows the mark that says a queue is out of it.
//
// ⚠️ SYNTHETIC DATA ONLY. This repo is public, so a shot is taken against `e2e/fixtures/`
// (the Bob / Alice cast) and never against the running household app.
//
// Self-contained like the other `shot-*` scripts — it boots the fake broker and the server
// itself. Every scratch path and both ports carry a suffix nothing else in the repo uses:
// sibling agents run these harnesses at the same time, and a shared `/tmp/queues-harness.yaml`
// is exactly the collision the workspace rule forbids.
import { promises as fs } from 'node:fs';

import { startFakeMqtt } from './fake-mqtt.js';
import { chromium } from './playwright.js';
import { killServer, spawnServer, REPO_ROOT } from './stubs/server-process.mjs';

const TAG = process.env.SHOT_TAG || 'after';
const PORT = parseInt(process.env.WEB_PORT || '18977', 10);
const MQTT_PORT = parseInt(process.env.FAKE_MQTT_PORT || '11977', 10);
const BASE = `http://localhost:${PORT}`;
const OUT = '__screenshots__';
const QUEUES = '/tmp/qp-season-window.queues.yaml';
const SETS = '/tmp/qp-season-window.sets.yaml';

/**
 * `MM-DD` for a day `days` from today.
 *
 * The shot's window is computed rather than written down for the same reason
 * `e2e/season-window-test.ts` computes its fixture: availability is evaluated on the READ, so
 * a hardcoded `10-01` produces a card that says "Out of season" for ten months of the year
 * and "in season" for two — and a screenshot taken in October would show the wrong panel with
 * nothing to say it had.
 */
function dayFromToday(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);

  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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
    HISTORY_PATH: '/tmp/qp-season-window.history.json',
    STORE_PATH: '/tmp/qp-season-window.sqlite',
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

  // The state the shot is ABOUT. Written through the API so the fixture on disk stays the
  // fixture. The SERVER is the same build on both tags — only `web/` differs — so the shelf
  // card's "before" is honestly today's card for a queue the server already calls out of
  // season, rather than a different queue photographed twice.
  await fetch(`${BASE}/api/sets/bob_anime`, {
    body: JSON.stringify({
      season_end: dayFromToday(80),
      season_start: dayFromToday(40),
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'PATCH',
  });

  const browser = await chromium.launch();
  const page = await browser.newPage({
    colorScheme: 'dark',
    viewport: { height: 1000, width: 1280 },
  });

  // ── 1. The Picks shelf, with the out-of-season mark ────────────────────────────────────
  await page.goto(`${BASE}/picks`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.shelf[data-set="bob_anime"]', { timeout: 30_000 });
  await page.waitForTimeout(600);
  await page.locator('.shelf[data-set="bob_anime"] h2').screenshot({
    path: `${OUT}/season-window-shelf-${TAG}.png`,
  });
  console.log(`wrote ${OUT}/season-window-shelf-${TAG}.png`);
  console.log('shelf heading says:', (await page.locator('.shelf[data-set="bob_anime"] h2').innerText()).replace(/\n+/g, ' / '));

  // ── 2. The queue editor's season row ───────────────────────────────────────────────────
  await page.goto(`${BASE}/q/bob_anime`, { waitUntil: 'domcontentloaded' });
  // Wait for the GRID, not for the ⚙. The button paints before `/api/sets` answers, and
  // `SetModal` seeds its fields once from an effect keyed on the modal opening — open it in
  // that gap and every field prefills as if the queue were being CREATED, season row included.
  await page.waitForSelector('#grid .tile .cap', { timeout: 30_000 });
  await page.click('#qconfigure');
  await page.waitForSelector('#setmodal', { timeout: 10_000 });
  // The row sits below the promote window, so a shot of the modal's top says nothing about it.
  await page.locator('#set-promote-window').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.locator('#setmodal').screenshot({ path: `${OUT}/season-window-editor-${TAG}.png` });
  console.log(`wrote ${OUT}/season-window-editor-${TAG}.png`);
  const hasRow = await page.locator('#set-season').count();
  console.log(`queue editor: season row ${hasRow ? 'PRESENT ✓' : 'absent ✗'}`);

  await browser.close();
} catch (e) {
  console.log('SHOT FAILED:', e);
  failed = true;
} finally {
  // `process.exit` and not a fall-through: the fake broker's client keeps a live socket and
  // aedes keeps its own handles, so the event loop stays open and the script hangs after the
  // last PNG is already on disk.
  killServer(srv);
  try { fake.client.end(true); } catch { /* already down */ }
  try { fake.server.close(); } catch { /* already down */ }
  try { fake.aedes.close(); } catch { /* already down */ }
  process.exit(failed ? 1 : 0);
}
