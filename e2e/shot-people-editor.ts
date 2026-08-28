// Before/after for the roster editor.
//
// Three frames, and each one is a claim the PR makes:
//
//   1. `bar`     the people filter row, with "⚙ Edit people" as its editor entry point.
//   2. `modal`   the people editor itself — the roster and the add field.
//   3. `confirm` the delete confirmation, open. It is the frame worth having because it is the
//                one that says what a removal takes with it, which is invisible from the row.
//
// The BEFORE run finds no "Edit people" button and says so on stdout rather than failing —
// that is the state it is documenting.
//
// **Fixture data, never live.** This repo is public and a PNG is opaque to every grep, so the
// cast is the landing fixture's Bob, Alice and Carol
// (decision `2026-08-19-pr-screenshots-are-fixture-data-never-live`).
//
//   PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers-queuepilot \
//     server/node_modules/.bin/tsx e2e/shot-people-editor.ts --tag=before
import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';

import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const PORT = 18799;
const tagArg = process.argv.find((a) => a.startsWith('--tag='));
const TAG = tagArg ? tagArg.slice('--tag='.length) : 'after';

const env = {
  ...process.env,
  CACHE_PATH: '/tmp/cache-shotpeopleeditor.sqlite',
  GROUPS_PATH: '/tmp/groups-shotpeopleeditor.yaml',
  HISTORY_PATH: '/tmp/history-shotpeopleeditor.json',
  MQTT_HOST: '',
  MQTT_PASS: '',
  MQTT_PORT: '',
  MQTT_USER: '',
  NODE_TLS_REJECT_UNAUTHORIZED: '0',
  PLEX_API_SERVER_URL: 'https://127.0.0.1:1',
  PLEX_TOKEN: '',
  QUEUES_PATH: '/tmp/queues-shotpeopleeditor.yaml',
  SETS_PATH: '/tmp/sets-shotpeopleeditor.yaml',
  WEB_PORT: String(PORT),
};

for (const [src, dest] of [
  ['e2e/fixtures/landing.sets.yaml', env.SETS_PATH],
  ['e2e/fixtures/landing.queues.yaml', env.QUEUES_PATH],
  ['e2e/fixtures/landing.groups.yaml', env.GROUPS_PATH],
  ['e2e/fixtures/landing.people-mapping.yaml', '/tmp/people-mapping-proposal.yaml'],
] as const) {
  await fs.copyFile(src, dest);
  await fs.rm(`${dest}.lock`, { force: true, recursive: true });
}
for (const stale of [
  '/tmp/queues-shotpeopleeditor.queuepilot.sqlite',
  '/tmp/cache-shotpeopleeditor.sqlite',
]) {
  await fs.rm(stale, { force: true });
}

await fs.mkdir('__screenshots__', { recursive: true });

let server: ChildProcess | undefined;
const browser = await chromium.launch();

try {
  server = spawnServer({ env, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) {
    try {
      await fetch(`http://localhost:${PORT}/api/sets`).then((r) => r.json());
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('charcuterie-scheme', 'dark');
    } catch {
      /* light then */
    }
  });
  const page = await ctx.newPage();

  await page.goto(`http://localhost:${PORT}/admin`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#peoplechips', { timeout: 30000 });
  await page.waitForTimeout(1200);

  const bar = await page.$('#peoplechips');
  await bar?.screenshot({ path: `__screenshots__/peopleeditor-${TAG}-bar.png` });

  const entry = await page.$('#peopleedit');
  if (!entry) {
    console.log('no "Edit people" button — the BEFORE state');
  } else {
    await entry.click();
    await page.waitForSelector('#peoplemodal', { timeout: 15000 });
    await page.waitForTimeout(900);
    await page.screenshot({ path: `__screenshots__/peopleeditor-${TAG}-modal.png` });

    const rows = await page.$$eval('#peoplemodal .peoplerow', (n) => n.length);
    const faces = await page.$$eval('#peoplemodal .pface', (n) => n.length);
    console.log(`${rows} editable name rows, ${faces} faces — the AFTER state`);

    // THE CONFIRMATION. It is the one control here that cannot be inferred from a still of the
    // list, because it is the only place the app says what a removal takes with it.
    const remove = await page.$('#peoplemodal .peoplerow .peoplerowmain button[aria-label^="Remove"]');
    if (remove) {
      await remove.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `__screenshots__/peopleeditor-${TAG}-confirm.png` });
      const said = await page.$eval('#peoplemodal .peopleconfirm', (n) => n.textContent ?? '');
      console.log(`the confirmation says: ${JSON.stringify(said.replace(/\s+/g, ' ').trim())}`);
      // Put it back — the next frame is the list, not a half-open confirmation.
      const cancel = await page.$('#peoplemodal .peopleconfirm button:last-of-type');
      await cancel?.click();
      await page.waitForTimeout(400);
    } else {
      console.log('no remove control found');
    }

    // ── the write, end to end ──────────────────────────────────────────────────────────
    //
    // The API gate covers the routes; this is the half it cannot see — that the button is
    // wired, that it is disabled until the row is dirty, and that the list repaints from the
    // server's answer rather than from the field somebody typed in.
    // Element handles rather than `Locator`s: this repo's `playwright.js` re-exports a narrowed
    // surface, and `Locator.isDisabled` is not on it.
    const ROW = '#peoplemodal .peoplerow:first-of-type';
    const isSaveDisabled = () =>
      page.$eval(`${ROW} .peoplerowmain button`, (n) => (n as HTMLButtonElement).disabled);

    console.log(
      (await isSaveDisabled())
        ? 'Save is disabled on a clean row'
        : '⚠️ Save is enabled on a clean row',
    );
    const field = await page.$(`${ROW} input.peoplename`);
    await field?.fill('Ada Lovelace');
    console.log(
      (await isSaveDisabled())
        ? '⚠️ Save is still disabled after typing'
        : 'Save enables once the row is dirty',
    );
    const save = await page.$(`${ROW} .peoplerowmain button`);
    await save?.click();
    await page.waitForTimeout(1200);
    const names = await page.$$eval('#peoplemodal .peoplerow input.peoplename', (n) =>
      (n as HTMLInputElement[]).map((i) => i.value),
    );
    console.log(
      names.includes('Ada Lovelace')
        ? `the rename round-tripped — the list now reads ${JSON.stringify(names.slice(0, 3))}`
        : `⚠️ the rename did not stick — ${JSON.stringify(names.slice(0, 3))}`,
    );
  }
  await ctx.close();

  // ── the Narrow View ──────────────────────────────────────────────────────────────────
  //
  // NARROW VIEW, named for the WIDTH. `isMobile` is Playwright's own name and is kept as-is.
  // The row is a face, a field and two buttons, and 390px is where that either wraps or
  // pushes the buttons off the end of the modal.
  const narrowCtx = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { height: 844, width: 390 },
  });
  await narrowCtx.addInitScript(() => {
    try {
      localStorage.setItem('charcuterie-scheme', 'dark');
    } catch {
      /* light then */
    }
  });
  const narrow = await narrowCtx.newPage();
  await narrow.goto(`http://localhost:${PORT}/admin`, { waitUntil: 'domcontentloaded' });
  await narrow.waitForSelector('#peoplechips', { timeout: 30000 });
  await narrow.waitForTimeout(1200);
  const narrowEntry = await narrow.$('#peopleedit');
  if (narrowEntry) {
    await narrowEntry.click();
    await narrow.waitForSelector('#peoplemodal', { timeout: 15000 });
    await narrow.waitForTimeout(900);
  }
  await narrow.screenshot({ path: `__screenshots__/peopleeditor-${TAG}-narrow.png` });
  const overflow = await narrow.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  console.log(
    overflow > 1
      ? `⚠️ the Narrow View scrolls horizontally by ${overflow}px`
      : 'the Narrow View does not scroll horizontally',
  );
  await narrowCtx.close();
} finally {
  await browser.close();
  killServer(server);
}
