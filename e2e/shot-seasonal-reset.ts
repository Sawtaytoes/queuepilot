// Before/after shots for the seasonal-reset control in the Set editor
// (decision `2026-09-08-a-queue-can-clear-its-own-watched-state-on-a-date-each-year`).
//
//   SHOT_TAG=before server/node_modules/.bin/tsx e2e/shot-seasonal-reset.ts
//   SHOT_TAG=after  server/node_modules/.bin/tsx e2e/shot-seasonal-reset.ts
//
// Three panels:
//
//   1. the "Playback & completion" block around the new row — the whole point is where it
//      SITS, directly under "Remove finished entries after";
//   2. the month picker OPEN, because a shot of a closed trigger says nothing about a picker;
//   3. the hint in its LOUD form, with a TTL set on the queue. `remove_completed_after`
//      defeats this feature silently, so the warning is half the change.
//
// ⚠️ THE FIXTURE IS SYNTHETIC AND MUST STAY THAT WAY. This repo is public and these PNGs are
// committed under `docs/images/` forever; a PNG is opaque to every grep, so nobody notices a
// real queue name in one the way they notice one in a diff.
//
// Self-contained like `shot-promote-window.ts` — it boots the fake broker and the server
// itself, and every scratch path and both ports carry a suffix nothing else in the repo uses,
// because sibling agents run these harnesses at the same time.
import { promises as fs } from 'node:fs';

import { startFakeMqtt } from './fake-mqtt.js';
import { pickValue } from './pick.js';
import { chromium } from './playwright.js';
import { killServer, spawnServer, REPO_ROOT } from './stubs/server-process.mjs';

const TAG = process.env.SHOT_TAG || 'after';
const PORT = parseInt(process.env.WEB_PORT || '18981', 10);
const MQTT_PORT = parseInt(process.env.FAKE_MQTT_PORT || '11981', 10);
const BASE = `http://localhost:${PORT}`;
const OUT = '__screenshots__';
const QUEUES = '/tmp/qp-seasonal-reset.queues.yaml';
const SETS = '/tmp/qp-seasonal-reset.sets.yaml';

await fs.mkdir(OUT, { recursive: true });
await fs.copyFile(`${REPO_ROOT}/e2e/fixtures/queues.harness.yaml`, QUEUES);
await fs.copyFile(`${REPO_ROOT}/e2e/fixtures/sets.fixture.yaml`, SETS);
for (const p of [`${QUEUES}.lock`, `${SETS}.lock`]) await fs.rm(p, { recursive: true, force: true });
await fs.rm('/tmp/qp-seasonal-reset.sqlite', { force: true });

let failed = false;
const fake = await startFakeMqtt({ port: MQTT_PORT });
const srv = spawnServer({
  env: {
    ...process.env,
    QUEUES_PATH: QUEUES,
    SETS_PATH: SETS,
    HISTORY_PATH: '/tmp/qp-seasonal-reset.history.json',
    STORE_PATH: '/tmp/qp-seasonal-reset.sqlite',
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

/**
 * Open the Set editor on the fixture queue.
 *
 * Waits for the GRID, not for the ⚙ button. The button paints before `/api/sets` answers, and
 * `SetModal` seeds its fields ONCE from an effect keyed on the modal opening — open it in that
 * gap and every field prefills as if the queue were being created. That is what put a phantom
 * TTL in the first capture of `shot-promote-window`.
 */
async function openEditor(page: import('./playwright.js').Page): Promise<void> {
  await page.goto(`${BASE}/q/bob_anime`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#grid .tile .cap', { timeout: 30_000 });
  await page.click('#qconfigure');
  await page.waitForSelector('#setmodal', { timeout: 10_000 });
  await page.locator('#set-remove-after').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
}

try {
  await ready();

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1280, height: 1000 },
    colorScheme: 'dark',
  });

  // ── 1. The block the row lands in ───────────────────────────────────────────────────────
  // Clear the TTL first, so the hint is in its ordinary form and panel 3 is the only one
  // showing the warning. On the `before` build this PATCH is a no-op the old server accepts.
  await fetch(`${BASE}/api/sets/bob_anime`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ remove_completed_after: '' }),
  });
  await openEditor(page);
  await page.locator('#set-flags').screenshot({
    path: `${OUT}/seasonal-reset-editor-${TAG}.png`,
  });
  console.log(`wrote ${OUT}/seasonal-reset-editor-${TAG}.png`);
  const hasRow = await page.locator('#set-reset-watched').count();
  console.log(`set editor: seasonal-reset row ${hasRow ? 'PRESENT ✓' : 'absent ✗'}`);

  // ── 2. The month picker, OPEN, and then a date actually CHOSEN ──────────────────────────
  //
  // A Charcuterie picker panel portals to <body>, so panel 2 is a shot of the PAGE, not of the
  // modal — a `#setmodal` clip would cut the list off at the modal's edge.
  //
  // ⚠️ NEVER Escape out of an open picker here. The app's modals are a native <dialog>, so
  // Escape closes the DIALOG rather than the portalled listbox, and everything after it aims
  // at a control that is no longer on screen. `pick.ts` says the same thing at the top of its
  // `closeVia`. So the panel is closed by CHOOSING, which is what the next shot wants anyway.
  if (hasRow) {
    await page.click('[data-testid="set-reset-month"]');
    await page.waitForSelector('[role="listbox"] [role="option"]', { timeout: 10_000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/seasonal-reset-months-${TAG}.png` });
    console.log(`wrote ${OUT}/seasonal-reset-months-${TAG}.png`);

    // The default state is "Never", and a shot of a control nobody has touched says nothing
    // about what the setting looks like once it is ON. November the 1st is the Halloween
    // queue's own answer, and it is what the decision record is about.
    await page.click('[role="listbox"] [role="option"] [data-value="11"]');
    await pickValue(page, '[data-testid="set-reset-day"]', '1');
    await page.waitForTimeout(300);
    await page.locator('#set-reset-watched').screenshot({
      path: `${OUT}/seasonal-reset-chosen-${TAG}.png`,
    });
    console.log(`wrote ${OUT}/seasonal-reset-chosen-${TAG}.png`);

    // THE DAY LIST IS THE MONTH'S. November has thirty days and must not offer a 31st.
    await page.click('[data-testid="set-reset-day"]');
    await page.waitForSelector('[role="listbox"] [role="option"]', { timeout: 10_000 });
    const novemberDays = await page.locator('[role="listbox"] [role="option"]').count();
    await page.click('[role="listbox"] [role="option"] [data-value="30"]');
    console.log(`November offers ${novemberDays} days (want 30)`);

    // THE CLAMP. The day picker is keyed on the month because the month is its second writer:
    // a 31 chosen in January must be pulled back when February is chosen after it.
    await pickValue(page, '[data-testid="set-reset-month"]', '1');
    await pickValue(page, '[data-testid="set-reset-day"]', '31');
    await pickValue(page, '[data-testid="set-reset-month"]', '2');
    await page.waitForTimeout(300);
    const clamped = (await page.locator('[data-testid="set-reset-day"]').innerText()).trim();
    console.log(`February clamps 31 -> ${clamped} (want 29)`);
  } else {
    console.log('month picker: SKIPPED — the row does not exist on this build.');
  }

  // ── 3. The hint in its LOUD form ────────────────────────────────────────────────────────
  // `remove_completed_after` DELETES a finished entry rather than tagging it, so a seasonal
  // queue carrying one has nothing left to reset when the date arrives. The live Halloween
  // queue was found carrying `24h`, which is what produced the warning. `openEditor` navigates,
  // so the modal above closes with the page and nothing has to press Escape.
  await fetch(`${BASE}/api/sets/bob_anime`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ remove_completed_after: '24h' }),
  });
  await openEditor(page);
  const hint = page.locator('#set-reset-watched-hint');
  if (await hint.count()) {
    await hint.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await hint.screenshot({ path: `${OUT}/seasonal-reset-ttl-warning-${TAG}.png` });
    console.log(`wrote ${OUT}/seasonal-reset-ttl-warning-${TAG}.png`);
    console.log('hint says:', (await hint.innerText()).replace(/\n+/g, ' '));
  } else {
    console.log('TTL warning: SKIPPED — the hint does not exist on this build.');
  }

  await browser.close();
} catch (e) {
  // The `finally` below ends with `process.exit(0)`, which would otherwise swallow a thrown
  // shot whole: the harness prints the panels it managed and returns success.
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
