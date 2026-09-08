// The panel `shot-actions-menu.ts` cannot take: a queue with QUEUE-OWNED HISTORY and NO `done`
// flag (decision `2026-09-08-the-actions-menu-hides-on-what-each-row-can-do-not-on-the-done-flag`).
//
//   server/node_modules/.bin/tsx e2e/shot-actions-menu-history.ts
//
// This is the shape the superseded rule got wrong, and the only shape that shows the fix:
//
//   * `Mark all unwatched` is ENABLED, because the queue's own ledger holds completions.
//   * `Remove all completed` is DISABLED and says why, because no entry carries `done`.
//   * The menu is PRESENT at all, which under the old rule it was not.
//
// The sibling script's fixture is the opposite shape — two `done: true` entries and no ledger
// — so it photographs the menu with both rows live and can never reach this state.
//
// ⚠️ THE HISTORY IS SEEDED BEFORE THE SERVER STARTS, and it has to be. The rows live in
// `queue_entry_history` in the store, not in `queues.yaml`, so there is nothing to write into
// a fixture file. This process opens the scratch store, writes the rows and lets go; the
// server then opens the same file. Two writers at once would be the bug, so the order matters.
//
// ⚠️ THE FIXTURE IS SYNTHETIC AND MUST STAY THAT WAY. This repo is public and the PNG is
// committed under `docs/images/` forever; a PNG is opaque to every grep, so nobody notices a
// real queue name in one the way they notice one in a diff.
//
// Self-contained: its own port, its own /tmp paths, its own store — sibling agents run these
// harnesses at the same time, so nothing here is a shared name.
import { promises as fs } from 'node:fs';

import { chromium } from './playwright.js';
import { killServer, spawnServer, REPO_ROOT } from './stubs/server-process.mjs';

const PORT = parseInt(process.env.WEB_PORT || '18991', 10);
const BASE = `http://localhost:${PORT}`;
const OUT = '__screenshots__';
const SCRATCH = '/tmp/qp-shot-actions-menu-history';
const QUEUES = `${SCRATCH}.queues.yaml`;
const SETS = `${SCRATCH}.sets.yaml`;
const STORE = `${SCRATCH}.sqlite`;
const QUEUE = 'bob';
/**
 * PHOTOGRAPH THE SUPERSEDED RULE INSTEAD. `QP_SHOT_BEFORE=1` expects NO menu and writes the
 * `-toolbar-before` shot, which is the "before" half a visual pull request has to carry.
 *
 * It does NOT change the component — it only changes what this script expects. Build
 * `web/dist` from the superseded rule first (`if (doneCount === 0) return null`), run this
 * with the flag, then restore the component and rebuild before running it without the flag.
 */
const IS_BEFORE = process.env.QP_SHOT_BEFORE === '1';
// A line that is NOT done and never becomes done here. `entryKey()` answers `title:<title>`
// for an entry that carries neither an id nor a ratingKey.
const ENTRY = 'title:Jin-Roh: The Wolf Brigade (1999)';

await fs.mkdir(OUT, { recursive: true });

// 1. The fixtures, edited into the shape this panel needs.
//    `done: true` comes OFF every entry — the whole point is a queue with nothing flagged —
//    and the set gains `watch_history: queue`, because `/api/queues` only reports
//    `queue_history_completed_count` for a queue that owns its history.
const queues = (await fs.readFile(`${REPO_ROOT}/e2e/fixtures/queues.harness.yaml`, 'utf8'))
  .replaceAll(', done: true', '');
await fs.writeFile(QUEUES, queues);

const sets = (await fs.readFile(`${REPO_ROOT}/e2e/fixtures/sets.fixture.yaml`, 'utf8'))
  .replace('  - id: bob\n    label: Bob — Movies\n', '  - id: bob\n    label: Bob — Movies\n    watch_history: queue\n');
await fs.writeFile(SETS, sets);

for (const p of [`${QUEUES}.lock`, `${SETS}.lock`, STORE, `${SCRATCH}.history.json`]) {
  await fs.rm(p, { recursive: true, force: true });
}

// 2. The ledger rows, written before anything else opens the store.
process.env.QUEUES_PATH = QUEUES;
process.env.SETS_PATH = SETS;
process.env.STORE_PATH = STORE;
const queueEntryHistory = await import('../server/src/store/db/queueEntryHistory.js');
for (const leaf of ['9001', '9002', '9003']) {
  queueEntryHistory.markCompleted(QUEUE, ENTRY, leaf);
}
const seeded = queueEntryHistory.completedFor(QUEUE, ENTRY).size;
console.log(`seeded ${seeded} completions on ${ENTRY} — and NOTHING is flagged done`);
if (seeded !== 3) throw new Error(`expected 3 seeded completions, got ${seeded}`);

let failed = false;
const srv = spawnServer({
  env: {
    ...process.env,
    HISTORY_PATH: `${SCRATCH}.history.json`,
    MQTT_HOST: '',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    QUEUES_PATH: QUEUES,
    SETS_PATH: SETS,
    STORE_PATH: STORE,
    WEB_PORT: String(PORT),
  },
  stdio: 'ignore',
});

const ready = async (): Promise<void> => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/queues`);
      // Assert it is OUR server, not whatever else answered on this port.
      if (res.ok && (await res.clone().json())?.sets?.[QUEUE]) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server never came up');
    await new Promise((r) => setTimeout(r, 300));
  }
};

try {
  await ready();

  // The payload is the claim the picture illustrates, so read it before photographing it.
  const items = (await (await fetch(`${BASE}/api/queues`)).json()).sets[QUEUE].items as Array<{
    done?: boolean; queue_history_completed_count?: number; title?: string;
  }>;
  const doneCount = items.filter((i) => i.done).length;
  const historyCount = items.reduce((s, i) => s + (i.queue_history_completed_count ?? 0), 0);
  console.log(`done entries: ${doneCount}   ledger completions: ${historyCount}`);
  if (doneCount !== 0) throw new Error(`fixture is wrong: ${doneCount} entries are flagged done`);
  if (historyCount < 1) throw new Error('the ledger did not reach the API payload');

  const browser = await chromium.launch();
  const page = await browser.newPage({
    colorScheme: 'dark',
    viewport: { width: 1440, height: 1000 },
  });

  // Wait for the TILES, not the toolbar: `#qtoolbar` paints before `/api/queues` answers, and
  // the menu is a function of what that payload says.
  await page.goto(`${BASE}/q/${QUEUE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#grid li.tile', { timeout: 30_000 });
  await page.waitForTimeout(1500);

  // Read the payload AGAIN from inside the page. The Node-side check above proves the ledger
  // reached the API; this one proves it was still there when the app rendered.
  console.log(`browser sees: ${String(await page.evaluate(`fetch('/api/queues').then((r) => r.json()).then((j) => { const it = j.sets['${QUEUE}'].items; return JSON.stringify({ done: it.filter((x) => x.done).length, hist: it.reduce((s, x) => s + (x.queue_history_completed_count || 0), 0) }); })`))}`);

  // WAIT for the trigger, never sample it once. The toolbar paints before `/api/queues`
  // answers, so a single `count()` after a fixed pause reports the defect on a slow store
  // read — it did, twice, on a component that was already correct.
  const hasMenu = await page
    .waitForSelector('#qactions', { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  console.log(`Actions menu ${hasMenu ? 'PRESENT' : 'ABSENT'}`);

  if (IS_BEFORE) {
    // The BEFORE side stops here: there is no menu to open, and its absence IS the picture.
    if (hasMenu) throw new Error('the BEFORE build still shows the menu — is `web/dist` the superseded one?');
    await page.screenshot({ path: `${OUT}/actions-menu-history-toolbar-before.png` });
    console.log(`wrote ${OUT}/actions-menu-history-toolbar-before.png`);
    await browser.close();
    killServer(srv);
    process.exit(0);
  }

  if (!hasMenu) throw new Error('no Actions menu: the menu is still hiding on the done flag');

  // A PAGE shot, not an element clip — the panel portals to `<body>`.
  await page.click('#qactions');
  await page.waitForSelector('.qactionsmenu [role="menuitem"]', { timeout: 10_000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/actions-menu-history-open-after.png` });
  console.log(`wrote ${OUT}/actions-menu-history-open-after.png`);

  // The two row states ARE the claim, so assert them rather than only photographing them.
  // `nth()` over `count()`, not `all()`: the shim in `e2e/playwright.ts` exposes only the
  // handful of Locator methods this suite uses, and `all()` is not one of them.
  const rows = page.locator('.qactionsmenu [role="menuitem"]');
  const rowCount = await rows.count();
  const states = new Map<string, boolean>();
  for (let i = 0; i < rowCount; i += 1) {
    const row = rows.nth(i);
    const text = (await row.innerText()).trim();
    // `MenuAction` renders the NATIVE `disabled` attribute, not `aria-disabled` — a disabled
    // row stays in the DOM and stays announced, it just never registers with `RovingFocus`.
    const isDisabled = await row.isDisabled();
    states.set(text, isDisabled);
    console.log(`  ${isDisabled ? 'DISABLED' : 'enabled '}  ${text}`);
  }

  const resetRow = [...states].find(([t]) => t.startsWith('Mark all unwatched'));
  const removeRow = [...states].find(([t]) => t.startsWith('Remove all completed'));
  if (!resetRow || resetRow[1]) throw new Error('the reset row must be ENABLED: the ledger holds completions');
  if (!removeRow || !removeRow[1]) throw new Error('the remove row must be DISABLED: no entry carries `done`');

  // The confirm, with the count the ledger supplied rather than a flag count.
  await page
    .locator('.qactionsmenu [role="menuitem"]', { hasText: 'Mark all unwatched' })
    .click();
  await page.waitForSelector('#qactionsconfirm', { timeout: 10_000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/actions-menu-history-confirm-after.png` });
  console.log(`wrote ${OUT}/actions-menu-history-confirm-after.png`);
  console.log(
    `confirm says: ${String(
      await page.evaluate(`document.querySelector('[role="dialog"] h2, [role="dialog"] h3').textContent.trim()`),
    )}`,
  );

  // Cancel. The shot is the question, not the answer.
  await page.click('#qactionscancel');
  await page.waitForTimeout(300);
  await browser.close();
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  killServer(srv);
}

process.exit(failed ? 1 : 0);
