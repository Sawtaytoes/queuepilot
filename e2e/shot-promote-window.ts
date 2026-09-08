// Before/after shots for the promote-window control
// (decision `2026-08-26-the-promote-window-is-a-queue-setting`).
//
//   SHOT_TAG=after server/node_modules/.bin/tsx e2e/shot-promote-window.ts
//
// Two panels, because the change lands in two places: the QUEUE editor grows the field, and
// the ENTRY sheet stops hardcoding "once a day" and names the queue's actual window.
//
// Self-contained like `shots.ts` — it boots the fake broker and the server itself. Every
// scratch path and both ports carry a suffix nothing else in the repo uses: sibling agents
// run these harnesses at the same time, and the shared `/tmp/queues-harness.yaml` of the
// older scripts is exactly the collision the workspace rule forbids.
import { promises as fs } from 'node:fs';

import { startFakeMqtt } from './fake-mqtt.js';
import { chromium } from './playwright.js';
import { killServer, spawnServer, REPO_ROOT } from './stubs/server-process.mjs';

const TAG = process.env.SHOT_TAG || 'after';
/** The window to put on the queue before the shot. Empty = leave it on the default. */
const WINDOW = process.env.SHOT_PROMOTE_WINDOW ?? '20h';
const PORT = parseInt(process.env.WEB_PORT || '18974', 10);
const MQTT_PORT = parseInt(process.env.FAKE_MQTT_PORT || '11974', 10);
const BASE = `http://localhost:${PORT}`;
const OUT = '__screenshots__';
const QUEUES = '/tmp/qp-promote-window.queues.yaml';
const SETS = '/tmp/qp-promote-window.sets.yaml';

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
    HISTORY_PATH: '/tmp/qp-promote-window.history.json',
    STORE_PATH: '/tmp/qp-promote-window.sqlite',
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

  // The state the shot is ABOUT: a queue with a window, and an entry promoted into the lane
  // that window governs. Written through the API so the fixture on disk stays the fixture.
  // `after` only — the field does not exist on the before build, and a PATCH the old server
  // ignores would leave the two shots claiming the same setup.
  //
  // `SHOT_PROMOTE_WINDOW=` (empty) leaves the queue with NO window of its own, which is how
  // the PRODUCT DEFAULT gets on screen: the entry sheet reads entry > queue > default, so a
  // queue that names one hides the rung the default lives on.
  if (TAG === 'after' && WINDOW) {
    await fetch(`${BASE}/api/sets/bob_anime`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ promote_window: WINDOW }),
    });
  }
  const key = encodeURIComponent('title:Space Dandy');
  await fetch(`${BASE}/api/queues/bob_anime/items/${key}/placement`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ placement: 'priority' }),
  });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, colorScheme: 'dark' });

  // ── 1. The queue editor ────────────────────────────────────────────────────────────────
  await page.goto(`${BASE}/q/bob_anime`, { waitUntil: 'domcontentloaded' });
  // Wait for the GRID, not for the ⚙ button. The button paints before `/api/sets` answers,
  // and `SetModal` seeds its fields once, from an effect keyed on the modal opening — open it
  // in that gap and every field prefills as if the queue were being CREATED. That is what put
  // an empty window and a phantom 24h TTL in the first capture of this shot.
  await page.waitForSelector('#grid .tile .cap', { timeout: 30_000 });
  await page.click('#qconfigure');
  await page.waitForSelector('#setmodal', { timeout: 10_000 });
  // Scroll the duration knobs into frame: they sit below the provider blocks, and a shot of
  // the modal's top says nothing about the field that was added.
  await page.locator('#set-remove-after').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.locator('#setmodal').screenshot({ path: `${OUT}/promote-window-editor-${TAG}.png` });
  console.log(`wrote ${OUT}/promote-window-editor-${TAG}.png`);
  const hasField = await page.locator('#set-promote-window').count();
  console.log(`queue editor: promote-window field ${hasField ? 'PRESENT ✓' : 'absent ✗'}`);
  await page.keyboard.press('Escape');

  // ── 2. The entry sheet, on the promoted entry ──────────────────────────────────────────
  // ⚠️ NEEDS PLEX. The pencil is rendered under `item.resolved` (QueueView), and nothing in
  // this fixture resolves without a library behind it — so offline this panel is SKIPPED, out
  // loud, rather than timing out for thirty seconds and being swallowed by the `finally`
  // below. `e2e/shot-entry-actions.ts` shows the other way round it: build ONE synthetic
  // resolved entry. Do that here when this panel is what a change is about.
  await page.goto(`${BASE}/q/bob_anime`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#grid .tile .cap', { timeout: 30_000 });
  const tile = page.locator('#grid .tile', { hasText: 'Space Dandy' }).first();
  const pencil = tile.locator('.editbtn');
  if (await pencil.count()) {
    await pencil.click();
    await page.waitForSelector('#entrymodal', { timeout: 10_000 });
    await page.waitForTimeout(400);
    const lead = page.locator('#entrymodal .field', { hasText: 'How often it leads' }).first();
    await lead.scrollIntoViewIfNeeded();
    await lead.screenshot({ path: `${OUT}/promote-window-entry-${TAG}.png` });
    console.log(`wrote ${OUT}/promote-window-entry-${TAG}.png`);
    console.log('entry sheet says:', (await lead.innerText()).replace(/\n+/g, ' / '));
  } else {
    console.log('entry sheet: SKIPPED — no resolved entry, so no pencil. Needs Plex.');
  }

  await browser.close();
} catch (e) {
  // The `finally` below ends with `process.exit(0)`, which used to swallow a thrown shot
  // whole: the harness printed the panels it had managed and returned success. Record the
  // failure so the exit code can carry it.
  console.log('SHOT FAILED:', e);
  failed = true;
} finally {
  // `process.exit` and not a fall-through: the fake broker's client keeps a live socket and
  // aedes keeps its own handles, so the event loop stays open and the script hangs after the
  // last PNG is already on disk — work that is finished and never returns. `shots.ts` ends
  // the same way, for the same reason.
  killServer(srv);
  try { fake.client.end(true); } catch { /* already down */ }
  try { fake.server.close(); } catch { /* already down */ }
  try { fake.aedes.close(); } catch { /* already down */ }
  process.exit(failed ? 1 : 0);
}
