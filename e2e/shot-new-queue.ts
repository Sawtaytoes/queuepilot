// Before/after for the Play landing's CREATE affordance — the "＋ New queue" button that
// the landing had no version of until 2026-08-21.
//
// Self-contained: its own server, its own temp copies of `fixtures/landing.*.yaml`, an
// unroutable Plex. `--tag=` names the output, so the same script shoots BEFORE on main and
// AFTER on the branch and the two frames are comparable.
//
// **Fixture data, never live.** This repo is public, and the landing renders set NAMES and
// group names — the household's own would say something about the owner's life in a PNG
// that no grep will ever find again. Every name in the frame comes from
// `e2e/fixtures/landing.*.yaml`, which is the repo's anonymized cast
// (decision `2026-08-19-pr-screenshots-are-fixture-data-never-live`).
//
// The BEFORE run finds no trigger and says so instead of failing — "there is nothing to
// click" is exactly the state it is documenting.
//
//   server/node_modules/.bin/tsx e2e/shot-new-queue.ts --tag=before
import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const PORT = 18793;
const tagArg = process.argv.find((a) => a.startsWith('--tag='));
const TAG = tagArg ? tagArg.slice('--tag='.length) : 'after';
const TRIGGER = '#playnewqueue';

const env = {
  ...process.env,
  WEB_PORT: String(PORT),
  QUEUES_PATH: '/tmp/queues-shotnewqueue.yaml',
  SETS_PATH: '/tmp/sets-shotnewqueue.yaml',
  GROUPS_PATH: '/tmp/groups-shotnewqueue.yaml',
  HISTORY_PATH: '/tmp/history-shotnewqueue.json',
  CACHE_PATH: '/tmp/cache-shotnewqueue.sqlite',
  PLEX_API_SERVER_URL: 'https://127.0.0.1:1',
  PLEX_TOKEN: '',
  MQTT_HOST: '',
  NODE_TLS_REJECT_UNAUTHORIZED: '0',
};

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

  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`http://localhost:${PORT}/api/sets`).then((r) => r.json());
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // The owner's UI is dark; the scheme persists to localStorage, so set it before first
  // paint rather than clicking the toggle after it.
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
    await page.waitForTimeout(1500);
  };

  // 1. The landing, wide. NOT `fullPage`: the claim is about the link row near the top,
  //    and a 17-set full page shrinks that row to an unreadable band in the PR.
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await settle();
  await page.screenshot({ path: `__screenshots__/newqueue-${TAG}-wide.png` });

  // 2. A group page — the owner reported the gap from one of these ("Even here, I can't add
  //    a new queue"), and it is the frame where the grid is a filtered slice.
  await page.goto(`http://localhost:${PORT}/g/bob`, { waitUntil: 'domcontentloaded' });
  await settle();
  await page.screenshot({ path: `__screenshots__/newqueue-${TAG}-group.png` });

  // 3. The Narrow View, where the toolbar this button replaces never mounted at all.
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await settle();
  await page.screenshot({ path: `__screenshots__/newqueue-${TAG}-narrow.png` });

  // 4. What the button opens. Skipped, loudly, when there is no button — which is the whole
  //    point of the BEFORE frame.
  await page.setViewportSize({ width: 1420, height: 940 });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await settle();

  const hasTrigger = await page
    .waitForSelector(TRIGGER, { timeout: 3000 })
    .then(() => true)
    .catch(() => false);

  if (hasTrigger) {
    await page.click(TRIGGER);
    await page.waitForSelector('#setmodal', { timeout: 15000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: `__screenshots__/newqueue-${TAG}-modal.png` });
  } else {
    console.log(`no ${TRIGGER} on this build — no modal frame (this is the BEFORE state)`);
  }

  console.log(`shot: __screenshots__/newqueue-${TAG}-{wide,group,narrow,modal}.png`);
} finally {
  await browser.close();
  if (server) killServer(server);
}
