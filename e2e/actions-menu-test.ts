// A DESTRUCTIVE QUEUE ACTION LIVES IN AN ACTIONS MENU, BEHIND A CONFIRM.
//
// decision `2026-09-08-a-destructive-queue-action-lives-in-an-actions-menu-behind-a-confirm`
// decision `2026-09-08-the-reset-is-exposed-on-the-api-and-mqtt-without-a-home-assistant-automation`
//
// What it pins, and why each one needs a BROWSER rather than a unit test:
//
//   1. THE TOOLBAR LOST A BUTTON. `#qremovedone` is gone and `#qactions` is there. The
//      record's own reason for the change is that the row shrinks — a version that COPIED
//      the action into the menu satisfies every other assertion here.
//   2. THE ROWS ARE `menuitem`s IN A PORTAL. A `Menu` panel is a child of `<body>`, so a
//      selector scoped under the VIEW finds nothing; both halves are asserted, because the
//      scoped one is what a later suite would reach for and it fails silently by matching
//      zero elements.
//   3. THE CONFIRM NAMES THE NUMBER AND THE QUEUE — "Clear 2 completions in Bob — Movies?",
//      never "Are you sure?".
//   4. CHOOSING A ROW WRITES NOTHING. Only the confirm's own button writes, and Cancel
//      leaves the queue exactly as it was. This is the whole protection the feature has:
//      neither action can be undone from this screen.
//   5. EACH ROW CALLS ITS OWN ROUTE, and `Mark all unwatched` calls the reset that already
//      exists — `POST /api/queues/:set/reset-watched`. There is no second clear.
//   6. THE MENU IS ABSENT WITH NOTHING TO ACT ON, and the flag it reads is `done`, not
//      `isCompleted` (§7 is a source grep, because the difference is a few seconds of live
//      reconcile that a fixture cannot stage).
//
// Browser, but NO PLEX — like `tile-menu-test`, so it runs on every PR. It spawns its own
// server over /tmp copies of the harness fixtures, and every scratch path and the port carry
// a suffix nothing else in the repo uses: sibling agents run these harnesses at the same time.
//
// Usage: `server/node_modules/.bin/tsx e2e/actions-menu-test.ts`  (spawns its own server)
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = parseInt(process.env.WEB_PORT || '18987', 10);
const BASE = `http://localhost:${PORT}`;
// `bob` carries TWO `done: true` entries in the harness fixture, and a typed label — so the
// confirm can be asserted on a plural count AND on the queue's own name.
const TWO_DONE = 'bob';
// `bob_anime` carries ONE, which is the singular branch of the same sentence.
const ONE_DONE = 'bob_anime';
// `bob_alice` carries none. The menu must not be there at all.
const NONE_DONE = 'bob_alice';

const QUEUES = '/tmp/qp-actions-menu.queues.yaml';
const SETS = '/tmp/qp-actions-menu.sets.yaml';

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

await fs.copyFile(`${ROOT}/e2e/fixtures/queues.harness.yaml`, QUEUES);
await fs.copyFile(`${ROOT}/e2e/fixtures/sets.fixture.yaml`, SETS);
for (const p of [`${QUEUES}.lock`, `${SETS}.lock`]) await fs.rm(p, { recursive: true, force: true });
await fs.rm('/tmp/qp-actions-menu.sqlite', { force: true });
await fs.rm('/tmp/qp-actions-menu.history.json', { force: true });

const srv = spawnServer({
  env: {
    ...process.env,
    HISTORY_PATH: '/tmp/qp-actions-menu.history.json',
    MQTT_HOST: '',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    QUEUES_PATH: QUEUES,
    SETS_PATH: SETS,
    STORE_PATH: '/tmp/qp-actions-menu.sqlite',
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
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

  /** Every non-GET this page makes, so a menu row can be asserted on what it did NOT do. */
  const writes: { method: string; url: string }[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && request.url().includes('/api/')) {
      writes.push({ method: request.method(), url: request.url() });
    }
  });

  /** What the toolbar and the (portalled) menu look like right now. */
  const shape = async () => JSON.parse(String(await page.evaluate(
    `JSON.stringify({`
    + ` actions: !!document.querySelector('#qactions'),`
    + ` removeDone: !!document.querySelector('#qremovedone'),`
    // Scoped under the VIEW, which is the ancestor the trigger really has. `#qtoolbar` is
    // the filter row below and would answer zero either way, so it cannot tell a portal
    // from a panel rendered in place.
    + ` scopedRows: document.querySelectorAll('#queue .qactionsmenu [role="menuitem"]').length,`
    + ` rows: [...document.querySelectorAll('.qactionsmenu [role="menuitem"]')]`
    + `   .map((r) => r.textContent.trim()),`
    + ` heading: document.querySelector('[role="dialog"] h3, [role="dialog"] h2')?.textContent.trim() || '',`
    + ` dialog: !!document.querySelector('#qactionsconfirm'),`
    + `})`,
  ))) as {
    actions: boolean;
    dialog: boolean;
    heading: string;
    removeDone: boolean;
    rows: string[];
    scopedRows: number;
  };

  const openQueue = async (setId: string) => {
    await page.goto(`${BASE}/q/${setId}`, { waitUntil: 'domcontentloaded' });
    // The TILES, not the toolbar: `#qtoolbar` paints before `/api/queues` lands, and the
    // Actions menu is a function of what that payload says is `done`. Waiting on the toolbar
    // reads the page one beat too early and reports the menu missing on a queue that has one.
    await page.waitForSelector('#grid li.tile', { timeout: 30000 });
    await page.waitForTimeout(1200);
  };

  const openMenu = async () => {
    await page.click('#qactions');
    await page.waitForTimeout(400);
  };

  // ── 1: the toolbar LOST a button and gained a menu ───────────────────────────────────────
  await openQueue(TWO_DONE);

  const toolbar = await shape();
  check('the toolbar carries an Actions menu', toolbar.actions, 'no #qactions');
  check(
    'and NO Remove all completed button — it MOVED, it was not copied',
    !toolbar.removeDone,
    '#qremovedone is still on the toolbar',
  );

  // ── 2: two `menuitem` rows, in a panel portalled to <body> ───────────────────────────────
  await openMenu();

  const open = await shape();
  check(
    'the menu holds both destructive actions as menuitems',
    open.rows.length === 2
      && open.rows.includes('Mark all unwatched')
      && open.rows.includes('Remove all completed'),
    `rows: ${JSON.stringify(open.rows)}`,
  );
  check(
    'the panel is a PORTAL — a selector scoped under the view finds none of it',
    open.scopedRows === 0,
    'the panel rendered inside #queue, so the document-wide selector is not required',
  );

  // ── 3 + 4: the confirm names the number, and choosing the row writes nothing ─────────────
  writes.length = 0;
  await page.locator('.qactionsmenu [role="menuitem"]', { hasText: 'Mark all unwatched' }).click();
  await page.waitForTimeout(500);

  const confirming = await shape();
  check(
    'the confirm names the COUNT and the QUEUE, never "Are you sure?"',
    confirming.heading === 'Clear 2 completions in Bob — Movies?',
    `heading was ${JSON.stringify(confirming.heading)}`,
  );
  check(
    'choosing the row has written NOTHING yet',
    writes.length === 0,
    `wrote: ${JSON.stringify(writes)}`,
  );

  await page.click('#qactionscancel');
  await page.waitForTimeout(400);

  const cancelled = await shape();
  check(
    'Cancel closes the confirm and still writes nothing',
    !cancelled.dialog && writes.length === 0,
    `dialog=${cancelled.dialog} wrote: ${JSON.stringify(writes)}`,
  );

  // ── 5a: Mark all unwatched calls the reset that already exists ───────────────────────────
  writes.length = 0;
  await openMenu();
  await page.locator('.qactionsmenu [role="menuitem"]', { hasText: 'Mark all unwatched' }).click();
  await page.waitForTimeout(400);
  await page.click('#qactionsgo');
  await page.waitForTimeout(2000);

  check(
    'confirming POSTs /api/queues/bob/reset-watched — the one implementation, not a second clear',
    writes.some((w) => w.method === 'POST' && w.url.endsWith(`/api/queues/${TWO_DONE}/reset-watched`)),
    `wrote: ${JSON.stringify(writes)}`,
  );

  const afterReset = JSON.parse(String(await page.evaluate(
    `fetch('/api/queues').then((r) => r.json()).then((d) => JSON.stringify({`
    + ` done: d.sets['${TWO_DONE}'].items.filter((i) => i.done).length,`
    + ` items: d.sets['${TWO_DONE}'].items.length,`
    + `}))`,
  ))) as { done: number; items: number };
  check(
    'the reset CLEARS the flags and keeps every entry',
    afterReset.done === 0 && afterReset.items === 11,
    `done=${afterReset.done} items=${afterReset.items}`,
  );

  const emptied = await shape();
  check(
    'and with nothing left flagged the menu is gone from the toolbar',
    !emptied.actions,
    'the Actions button stayed with nothing to act on',
  );

  // ── 5b: Remove all completed calls its own route, and the singular sentence ──────────────
  await openQueue(ONE_DONE);
  writes.length = 0;
  await openMenu();
  await page.locator('.qactionsmenu [role="menuitem"]', { hasText: 'Remove all completed' }).click();
  await page.waitForTimeout(500);

  const removing = await shape();
  check(
    'one completion reads in the singular',
    removing.heading === 'Remove 1 completed entry from Bob — Anime?',
    `heading was ${JSON.stringify(removing.heading)}`,
  );

  await page.click('#qactionsgo');
  await page.waitForTimeout(2000);

  check(
    'confirming POSTs /api/queues/bob_anime/remove-completed',
    writes.some((w) => w.method === 'POST' && w.url.endsWith(`/api/queues/${ONE_DONE}/remove-completed`)),
    `wrote: ${JSON.stringify(writes)}`,
  );

  const afterRemove = JSON.parse(String(await page.evaluate(
    `fetch('/api/queues').then((r) => r.json()).then((d) => JSON.stringify({`
    + ` done: d.sets['${ONE_DONE}'].items.filter((i) => i.done).length,`
    + ` items: d.sets['${ONE_DONE}'].items.length,`
    + `}))`,
  ))) as { done: number; items: number };
  check(
    'the completed entry LEAVES the queue',
    afterRemove.done === 0 && afterRemove.items === 5,
    `done=${afterRemove.done} items=${afterRemove.items}`,
  );

  // ── 6: a queue with nothing flagged offers no menu at all ────────────────────────────────
  await openQueue(NONE_DONE);
  const clean = await shape();
  check(
    'a queue with no completion offers no Actions menu, rather than two disabled rows',
    !clean.actions && clean.rows.length === 0,
    `actions=${clean.actions} rows=${JSON.stringify(clean.rows)}`,
  );

  await browser.close();
} finally {
  killServer(srv);
}

// ── 7: the SOURCE rules nothing in a browser can see ───────────────────────────────────────
//
// Two of them, and both are invisible to every other check here.
const menuSource = await fs.readFile(
  `${ROOT}/web/src/components/QueueActionsMenu.tsx`,
  'utf8',
);
check(
  'the menu keys on `done`, never on `isCompleted`',
  /\.done\b/.test(menuSource) && !/\bisCompleted\b/.test(menuSource.replace(/⚠[^\n]*/g, '')),
  'a live-finished entry gets its flag from the next reconcile — acting on it earlier does nothing',
);

// THERE IS ONE CLEAR. The browser half above proves the menu calls the route; this half
// proves nothing else in the app clears a queue's watched state on its own.
const webFiles: string[] = [];
const walk = async (dir: string) => {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (/\.tsx?$/.test(entry.name)) webFiles.push(full);
  }
};
await walk(`${ROOT}/web/src`);

const resetCallers: string[] = [];
for (const file of webFiles) {
  if ((await fs.readFile(file, 'utf8')).includes('/reset-watched')) resetCallers.push(file);
}
check(
  'exactly one place in the web app calls the reset route',
  resetCallers.length === 1 && resetCallers[0]!.endsWith('QueueActionsMenu.tsx'),
  `callers: ${JSON.stringify(resetCallers.map((f) => path.relative(ROOT, f)))}`,
);

console.log(failed ? `\n${failed} FAILURE(S)` : '\nALL PASS');
process.exit(failed ? 1 : 0);
