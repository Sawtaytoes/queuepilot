// A SHELF TILE CAN BE REMOVED.
//
// Reported 2026-08-21: "From the Ordered Queues view, I can't remove items either." The
// Ordered Queues page renders the same `PosterTile` as the queue grid, but passed neither
// `onRemove` nor `onContextMenu` — so the one page that can drag a title into a different
// queue was the one page that could not take it out of this one. The only route to a removal
// was to open `/q/<id>` first.
//
// Two things had to be true at once for that to happen, and this suite pins BOTH, because
// either one alone puts the bug straight back:
//
//   1. the shelf passes `onRemove`, so the button is in the DOM at all; and
//   2. the ✕'s CSS no longer hangs off an `.editable` ancestor the shelf's `<main>` does not
//      carry — with the prop alone the button renders and is `display: none`, which every
//      behavioural assertion in this file would still fail on, but silently and confusingly.
//
// So the ✕'s COMPUTED style is asserted, not just its presence. That is the same reason
// `narrow-scroll-test` measures geometry: a control that exists and cannot be seen passes
// every test that looks it up by selector.
//
// Self-contained and NO PLEX: its own server, its own temp files, an unroutable Plex. Entries
// render unresolved but they render, and every claim here — the tile count, the shelf's own
// count, the YAML on disk, the undo stack — is true on the degraded path.
//
//   server/node_modules/.bin/tsx e2e/shelf-remove-test.ts
import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const PORT = 18792;
const QUEUES = '/tmp/queues-shelfremove.yaml';
const env = {
  ...process.env,
  WEB_PORT: String(PORT),
  QUEUES_PATH: QUEUES,
  SETS_PATH: '/tmp/sets-shelfremove.yaml',
  GROUPS_PATH: '/tmp/groups-shelfremove.yaml',
  HISTORY_PATH: '/tmp/history-shelfremove.json',
  CACHE_PATH: '/tmp/cache-shelfremove.sqlite',
  PLEX_API_SERVER_URL: 'https://127.0.0.1:1',
  PLEX_TOKEN: '',
  MQTT_HOST: '',
  NODE_TLS_REJECT_UNAUTHORIZED: '0',
};

const ok = (name: string, isPass: boolean) => {
  console.log(`${isPass ? 'PASS' : 'FAIL'} ${name}`);
  if (!isPass) process.exitCode = 1;
};

// Two ordered queues, because "remove" and "move to the other shelf" share a gesture surface
// and a fixture with one shelf cannot tell them apart.
const SETS_SEED = `sets:
- id: q_shelf
  label: Shelf Queue
  kind: movies
  source: queue
  sections: [ 1 ]
- id: q_other
  label: Other Queue
  kind: movies
  source: queue
  sections: [ 1 ]
`;
const QUEUES_SEED = `q_shelf:
- {title: Duel (1971)}
- {title: Cowboy Bebop}
- {title: The Iron Giant (1999)}
q_other:
- {title: Steamboy (2004)}
`;

/**
 * The entries `queues.yaml` actually holds for a set — the write, not the optimistic DOM.
 *
 * Stops at the NEXT top-level key rather than reading to end of file. Without that stop this
 * counts the other queue's entries too, which makes "the file lost one" true for the wrong
 * reason and, worse, makes it FALSE when the right thing happened.
 */
const fileEntries = async (setId: string): Promise<string[]> => {
  const lines = (await fs.readFile(QUEUES, 'utf8')).split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${setId}:`));
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    // A list item is at column 0 too, so "next top-level key" is a non-space that is not
    // the `- ` bullet — not simply a non-space.
    if (/^[^\s-]/.test(line)) break;
    const m = /^- (.+)$/.exec(line);
    if (m) out.push((m[1] as string).trim());
  }
  return out;
};

let server: ChildProcess | undefined;
const browser = await chromium.launch();

try {
  await fs.writeFile(QUEUES, QUEUES_SEED);
  await fs.writeFile(env.SETS_PATH, SETS_SEED);
  for (const p of [QUEUES, env.SETS_PATH, env.HISTORY_PATH]) {
    await fs.rm(`${p}.lock`, { force: true, recursive: true });
  }
  await fs.rm(env.HISTORY_PATH, { force: true });
  server = spawnServer({ env, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`http://localhost:${PORT}/api/sets`).then((r) => r.json());
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

  const shelf = '.shelf[data-set="q_shelf"]';
  const tiles = () => page.$$eval(`${shelf} li.tile`, (els) => els.length);
  const count = () => page.textContent(`${shelf} .sec`);
  const away = () => page.mouse.move(0, 0);

  await page.goto(`http://localhost:${PORT}/queues`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`${shelf} li.tile`, { timeout: 30000 });

  ok('the shelf renders its three entries', (await tiles()) === 3);
  ok('the shelf header counts three', (await count()) === '3');

  // ---- 1. the control is THERE, and it can be SEEN ----
  ok('every shelf tile carries a ✕',
    (await page.$$eval(`${shelf} li.tile .remove`, (els) => els.length)) === 3);
  // The bug's second half. `.tile .check/.remove { display: none }` used to be undone only
  // under `.editable`, which is on the queue page's <main> and not on this one.
  // `.every()` over an EMPTY list is `true`, so both of these carry their own length check.
  // Without it the two assertions that exist to catch "the button is invisible" pass loudest
  // in the one case where there is no button at all.
  ok('the ✕ is not display:none on the shelf',
    await page.$$eval(`${shelf} li.tile .remove`,
      (els) => els.length === 3 && els.every((e) => getComputedStyle(e).display !== 'none')));
  ok('the ✕ has a real hit box',
    await page.$$eval(`${shelf} li.tile .remove`, (els) =>
      els.length === 3 && els.every((e) => e.getBoundingClientRect().width >= 20)));

  // Quiet until asked for — the same rule the queue grid follows. A wall of posters must not
  // become a wall of buttons (decision 2026-08-15-tile-controls-are-quiet-and-sit-beside-the-poster).
  await away();
  await page.waitForTimeout(400);
  const firstRemove = page.locator(`${shelf} li.tile .remove`).first();
  ok('the ✕ is invisible at rest',
    (await firstRemove.evaluate((e) => getComputedStyle(e).opacity)) === '0');
  await page.locator(`${shelf} li.tile`).first().hover();
  await page.waitForTimeout(400);
  ok('the ✕ appears on hover',
    (await firstRemove.evaluate((e) => getComputedStyle(e).opacity)) === '1');

  // What must NOT have been switched on with it. The shelf has no multi-select and no
  // per-tile ▶ — turning the whole `.editable` chrome on here would have brought both, and
  // the point of the change is one control, not a mode.
  ok('the shelf gains no ✓ multi-select',
    (await page.$$eval(`${shelf} li.tile .check`, (els) => els.length)) === 0);
  ok('the shelf gains no per-tile ▶',
    (await page.$$eval(`${shelf} li.tile .tileplay`, (els) => els.length)) === 0);

  // ---- 2. clicking it removes the entry, and the file agrees ----
  const removedTitle = await page.textContent(`${shelf} li.tile .title`);
  await firstRemove.click();
  await page.waitForFunction(
    () => document.querySelectorAll('.shelf[data-set="q_shelf"] li.tile').length === 2,
    undefined, { timeout: 15000 });
  ok('the tile goes immediately (optimistic)', (await tiles()) === 2);
  ok('the shelf header re-counts', (await count()) === '2');

  let onDisk: string[] = [];
  for (let i = 0; i < 40; i++) {
    onDisk = await fileEntries('q_shelf');
    if (onDisk.length === 2) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  ok('queues.yaml lost exactly that entry',
    onDisk.length === 2 && !onDisk.some((e) => e.includes('Duel')));
  ok('the OTHER queue is untouched', (await fileEntries('q_other')).length === 1);
  ok('the removed tile was the one clicked', (removedTitle ?? '').includes('Duel'));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`${shelf} li.tile`, { timeout: 30000 });
  ok('the removal survives a reload', (await tiles()) === 2);

  // ---- 3. UNDO. A shelf removal is a write like any other, so it is on the stack ----
  //
  // Nothing in the client does this: `undoSnapshot` middleware snapshots the YAML before every
  // mutating request, so the ✕ joins undo by being a DELETE. Asserting it here is what stops a
  // future "optimistic-only" shortcut that skips the request from looking correct on screen.
  await page.waitForFunction(() => {
    const undo = document.querySelector<HTMLButtonElement>('#undo');
    return undo !== null && !undo.disabled;
  }, undefined, { timeout: 20000 });
  await page.click('#undo');
  await page.waitForFunction(
    () => document.querySelectorAll('.shelf[data-set="q_shelf"] li.tile').length === 3,
    undefined, { timeout: 30000 });
  ok('undo puts the shelf tile back', (await tiles()) === 3);
  ok('undo puts it back in the FILE too', (await fileEntries('q_shelf')).length === 3);

  // ---- 4. the per-entry menu, which the shelf also never had ----
  //
  // `useHomeDrags` already suppressed the browser's native menu over a shelf poster (a touch
  // long-press arms a drag there), so before this change a right-click on a shelf poster did
  // nothing whatsoever.
  const poster = page.locator(`${shelf} li.tile .thumb`).first();
  await poster.click({ button: 'right' });
  await page.waitForSelector('#tilemenu:not([hidden])', { timeout: 15000 });
  ok('right-click opens the per-entry menu', true);
  const menuRemove = page.locator('#tilemenu button.danger');
  ok('the menu offers a scoped Remove',
    ((await menuRemove.textContent()) ?? '').includes('Remove from this queue'));
  await menuRemove.click();
  await page.waitForFunction(
    () => document.querySelectorAll('.shelf[data-set="q_shelf"] li.tile').length === 2,
    undefined, { timeout: 15000 });
  ok('the menu removes too', (await tiles()) === 2);

  // ---- 5. the queue page still removes, after the lift ----
  //
  // `removeTile` moved out of QueueView into `state/queueEntry`. The page it came from is the
  // one that had this working, so it is the one a bad lift would break.
  await page.goto(`http://localhost:${PORT}/q/q_shelf`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#grid li.tile', { timeout: 30000 });
  const gridBefore = await page.$$eval('#grid li.tile', (els) => els.length);
  await page.locator('#grid li.tile .remove').first().click();
  await page.waitForFunction(
    (n) => document.querySelectorAll('#grid li.tile').length === n - 1,
    gridBefore, { timeout: 15000 });
  ok('the queue grid still removes after the lift', true);
} finally {
  await browser.close();
  if (server) killServer(server);
}
