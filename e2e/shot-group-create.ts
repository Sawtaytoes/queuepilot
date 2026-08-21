// Before/after for "a queue created on a group page joins that group".
//
// It DRIVES the create rather than posing it: open `/g/bob`, press `＋ New queue`, name it,
// Save, then shoot the same group page. The one difference between the two frames is whether
// the new card is there, which is the whole claim
// (owner, 2026-08-21: *"It should join wherever I added it."*).
//
// Self-contained: its own server, its own temp copies of `fixtures/landing.*.yaml`, an
// unroutable Plex. `--tag=` names the output, so the same script shoots BEFORE on main and
// AFTER on the branch and the two frames are comparable. The BEFORE run is expected to end
// with the card ABSENT — it says so on stdout rather than failing, because that is the state
// it is documenting.
//
// **Fixture data, never live.** This repo is public, and this frame renders both set names
// and GROUP names — the household's own are its family's, and a PNG is opaque to every grep.
// Every name here comes from `e2e/fixtures/landing.*.yaml`, the repo's anonymized cast
// (decision `2026-08-19-pr-screenshots-are-fixture-data-never-live`).
//
//   server/node_modules/.bin/tsx e2e/shot-group-create.ts --tag=before
import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';

import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const PORT = 18794;
const tagArg = process.argv.find((a) => a.startsWith('--tag='));
const TAG = tagArg ? tagArg.slice('--tag='.length) : 'after';

/** Anonymized, and deliberately not a name any fixture already uses — the point of the pair
 *  is that the reader can find this one card and only this one. */
const NEW_QUEUE = 'Weekend Movies';

const env = {
  ...process.env,
  WEB_PORT: String(PORT),
  QUEUES_PATH: '/tmp/queues-shotgroupcreate.yaml',
  SETS_PATH: '/tmp/sets-shotgroupcreate.yaml',
  GROUPS_PATH: '/tmp/groups-shotgroupcreate.yaml',
  HISTORY_PATH: '/tmp/history-shotgroupcreate.json',
  CACHE_PATH: '/tmp/cache-shotgroupcreate.sqlite',
  PLEX_API_SERVER_URL: 'https://127.0.0.1:1',
  PLEX_TOKEN: '',
  MQTT_HOST: '',
  NODE_TLS_REJECT_UNAUTHORIZED: '0',
};

// Fresh copies every run: the create below WRITES to these, so a second run against a dirty
// temp file would shoot two "Weekend Movies" cards.
for (const [src, dest] of [
  ['e2e/fixtures/landing.sets.yaml', env.SETS_PATH],
  ['e2e/fixtures/landing.queues.yaml', env.QUEUES_PATH],
  ['e2e/fixtures/landing.groups.yaml', env.GROUPS_PATH],
] as const) {
  await fs.copyFile(src, dest);
  await fs.rm(`${dest}.lock`, { force: true, recursive: true });
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

  // The owner's UI is dark; the scheme persists to localStorage, so set it before first paint
  // rather than clicking the toggle after it.
  const ctx = await browser.newContext({ viewport: { width: 1420, height: 940 } });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('charcuterie-scheme', 'dark');
    } catch {
      /* private mode — the shot is just light then, and says so */
    }
  });

  const page = await ctx.newPage();
  const settle = async () => {
    await page.waitForSelector('.playcard', { timeout: 30000 });
    await page.waitForTimeout(1200);
  };

  // 1. Create it, from Bob's page. Exactly the gesture that was reported.
  await page.goto(`http://localhost:${PORT}/g/bob`, { waitUntil: 'domcontentloaded' });
  await settle();
  await page.click('#playnewqueue');
  await page.waitForSelector('#setmodal', { timeout: 15000 });
  await page.waitForTimeout(600);
  await page.fill('#set-label', NEW_QUEUE);

  // 1b. AFTER only: the modal saying where it will land, before the save. There is no BEFORE
  //     twin — the line does not exist on main, and an empty frame documents nothing the
  //     paired grid shots do not already say.
  if (await page.$('#set-groupnote')) {
    await page.screenshot({ path: `__screenshots__/groupcreate-${TAG}-modal.png` });
  } else {
    console.log('no #set-groupnote on this build — no modal frame (this is the BEFORE state)');
  }

  await page.click('#set-save');
  await page
    .waitForSelector('#setmodal', { state: 'detached', timeout: 20000 })
    .catch(() => page.waitForTimeout(3000));
  await page.waitForTimeout(1200);

  // 2. THE FRAME. Bob's page, reloaded, with the queue that was just made from it — present
  //    on the branch, absent on main. Not `fullPage`: the claim is one card in one grid, and
  //    a full page shrinks it to an unreadable band in the PR.
  await page.goto(`http://localhost:${PORT}/g/bob`, { waitUntil: 'domcontentloaded' });
  await settle();
  await page.screenshot({ path: `__screenshots__/groupcreate-${TAG}-group.png` });

  const labels = await page.$$eval('.playcard', (cards) => cards.map((c) => c.textContent ?? ''));
  const isThere = labels.some((t) => t.includes(NEW_QUEUE));
  console.log(
    isThere
      ? `“${NEW_QUEUE}” IS on Bob's page — the AFTER state`
      : `“${NEW_QUEUE}” is NOT on Bob's page — the BEFORE state (it went to All)`,
  );

  // 3. The everything view, so the BEFORE frame can prove the queue was really created and
  //    merely filed nowhere. Without it, "the card is missing" reads as a failed save.
  await page.goto(`http://localhost:${PORT}/g/all`, { waitUntil: 'domcontentloaded' });
  await settle();
  await page.screenshot({ path: `__screenshots__/groupcreate-${TAG}-all.png` });

  console.log(`shot: __screenshots__/groupcreate-${TAG}-{group,all,modal}.png`);
} finally {
  await browser.close();
  if (server) killServer(server);
}
