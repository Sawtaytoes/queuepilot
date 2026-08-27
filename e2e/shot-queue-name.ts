// Before/after for "a queue's name is optional, and the ACTIVITY fills in".
//
// Two frames, and each one is a claim the PR makes:
//
//   1. `shelves`  `/queues` at 1420px. Before, every shelf heading is the ACTIVITY and
//                 nothing else: the fixture's seven queues read "Movies & Shows",
//                 "Movies & Shows 2", "Movies & Shows 3", "Movies & Shows 4",
//                 "Movies & Shows", "Movies & Shows" and "Movies & Shows 2" — which is what
//                 the owner reported, and note that the numbering does not even make them
//                 distinguishable. After, each heading is the queue's own name, and the
//                 activity fills in only where there is none.
//   2. `editor`   the picks editor open on a named queue. On main the Name field is
//                 `required` and its hint says the list shows the activity instead. On the
//                 branch it is optional and the hint says what an empty one does.
//
// **Fixture data, never live.** The landing fixture's anonymized cast
// (decision `2026-08-19-pr-screenshots-are-fixture-data-never-live`).
//
//   PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers-queuepilot \
//     server/node_modules/.bin/tsx e2e/shot-queue-name.ts --tag=before
import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';

import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const PORT = 18794;
const tagArg = process.argv.find((a) => a.startsWith('--tag='));
const TAG = tagArg ? tagArg.slice('--tag='.length) : 'after';

const env = {
  ...process.env,
  CACHE_PATH: '/tmp/cache-shotqueuename.sqlite',
  GROUPS_PATH: '/tmp/groups-shotqueuename.yaml',
  HISTORY_PATH: '/tmp/history-shotqueuename.json',
  // The shell in this workspace carries real MQTT_* values, and a harness that does not blank
  // them dials the household broker and retries forever.
  MQTT_HOST: '',
  MQTT_PASS: '',
  MQTT_PORT: '',
  MQTT_USER: '',
  NODE_TLS_REJECT_UNAUTHORIZED: '0',
  PLEX_API_SERVER_URL: 'https://127.0.0.1:1',
  PLEX_TOKEN: '',
  QUEUES_PATH: '/tmp/queues-shotqueuename.yaml',
  SETS_PATH: '/tmp/sets-shotqueuename.yaml',
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
  '/tmp/queues-shotqueuename.queuepilot.sqlite',
  '/tmp/cache-shotqueuename.sqlite',
]) {
  await fs.rm(stale, { force: true });
}

await fs.mkdir('__screenshots__', { recursive: true });

let server: ChildProcess | undefined;
const browser = await chromium.launch();

const darkInit = () => {
  try {
    localStorage.setItem('charcuterie-scheme', 'dark');
  } catch {
    /* private mode — the shot is light then, and says so */
  }
};

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

  const ctx = await browser.newContext({ viewport: { height: 1000, width: 1420 } });
  await ctx.addInitScript(darkInit);
  const page = await ctx.newPage();

  // ── 1. the shelf headings ──────────────────────────────────────────────────────────── //

  await page.goto(`http://localhost:${PORT}/queues`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.shelf h2', { timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `__screenshots__/queuename-${TAG}-shelves.png` });

  // The TITLE only. A shelf `h2` also carries the collapse caret, the count, the faces, the
  // provider badge and the icon row, so `textContent` on the whole heading is a wall of
  // chrome with the one word this shot is about buried in it.
  const headings = await page.$$eval('.shelf h2 .lbl', (nodes) =>
    nodes.map((n) => (n.textContent ?? '').trim()),
  );
  const activityNamed = headings.filter((h) => h.includes('Movies & Shows')).length;
  console.log(`shelf headings: ${headings.join(' | ')}`);
  console.log(
    activityNamed
      ? `⚠️ ${activityNamed} of ${headings.length} shelves are called "Movies & Shows…" — the BEFORE state`
      : `all ${headings.length} shelves wear their own name`,
  );

  // ── 2. the editor's Name field ─────────────────────────────────────────────────────── //
  //
  // Opened from a shelf's own Edit control rather than by URL: the picks editor is a modal
  // with no address of its own.
  const edit = page.locator('.shelf .shelfedit').first();
  if (await edit.count()) {
    await edit.click();
    await page.waitForSelector('#set-label', { timeout: 15000 });
    await page.waitForTimeout(900);
    await page.screenshot({ path: `__screenshots__/queuename-${TAG}-editor.png` });

    const isRequired = await page.$eval('#set-label', (n) => n.hasAttribute('required'));
    console.log(
      isRequired ? 'the Name field is REQUIRED — the BEFORE state' : 'the Name field is optional',
    );
  } else {
    console.log('⚠️ no shelf Edit control found — the editor frame was not shot');
  }

  await ctx.close();
} finally {
  await browser.close();
  killServer(server);
}
