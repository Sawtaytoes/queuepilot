// Before/after for WP-5 — "a queue is people plus an activity".
//
// Four frames, and each one is a claim the PR makes:
//
//   1. `queues`        the Ordered Queues page. A shelf is the ACTIVITY (or its explicit name)
//                      with avatar badges and audience names beside it. The provider label is
//                      omitted, but the shared face marker remains part of the audience row.
//   2. `editor`        the queue editor's vertical audience list, with people and groups in
//                      Must, Nice, and Everyone else sections.
//   3. `move`          a row's audience choices, open in the screenshot after a move. Every
//                      row has the three choices visible, so there is no hidden move menu.
//   4. `narrow`        the Narrow View at 390px: each row stacks its choices below its name.
//                      No horizontal scroll at any width.
//
// The BEFORE run is expected to find no faces and no audience names. The current run is
// expected to find both avatar badges and audience names. The script says so on stdout rather
// than failing because it is documenting the render states.
//
// **Fixture data, never live.** This repo is public and a PNG is opaque to every grep, so the
// people in these frames are Ada, Grace and Linus and the queues are the landing fixture's
// anonymized cast (decision `2026-08-19-pr-screenshots-are-fixture-data-never-live`).
//
//   PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers \
//     server/node_modules/.bin/tsx e2e/shot-queue-people.ts --tag=before
import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';

import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const PORT = 18797;
const tagArg = process.argv.find((a) => a.startsWith('--tag='));
const TAG = tagArg ? tagArg.slice('--tag='.length) : 'after';

const env = {
  ...process.env,
  CACHE_PATH: '/tmp/cache-shotqueuepeople.sqlite',
  GROUPS_PATH: '/tmp/groups-shotqueuepeople.yaml',
  HISTORY_PATH: '/tmp/history-shotqueuepeople.json',
  // The shell in this workspace carries real MQTT_* values, and a harness that does not blank
  // them dials the household broker and retries forever (WP-3 lost eleven minutes to it).
  MQTT_HOST: '',
  MQTT_PASS: '',
  MQTT_PORT: '',
  MQTT_USER: '',
  NODE_TLS_REJECT_UNAUTHORIZED: '0',
  PLEX_API_SERVER_URL: 'https://127.0.0.1:1',
  PLEX_TOKEN: '',
  QUEUES_PATH: '/tmp/queues-shotqueuepeople.yaml',
  SETS_PATH: '/tmp/sets-shotqueuepeople.yaml',
  WEB_PORT: String(PORT),
};

// Fresh copies every run — the editor WRITES trays, so a second run over a dirty temp store
// would shoot the previous run's arrangement.
for (const [src, dest] of [
  ['e2e/fixtures/landing.sets.yaml', env.SETS_PATH],
  ['e2e/fixtures/landing.queues.yaml', env.QUEUES_PATH],
  ['e2e/fixtures/landing.groups.yaml', env.GROUPS_PATH],
  // The proposal filename, not a confirmed one — the importer looks for exactly this.
  ['e2e/fixtures/landing.people-mapping.yaml', '/tmp/people-mapping-proposal.yaml'],
] as const) {
  await fs.copyFile(src, dest);
  await fs.rm(`${dest}.lock`, { force: true, recursive: true });
}
// The store derives its own path from the queues path, so a stale one from a previous run
// would keep the previous run's rows AND its "already seeded" marker.
for (const stale of [
  '/tmp/queues-shotqueuepeople.queuepilot.sqlite',
  '/tmp/cache-shotqueuepeople.sqlite',
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

  // The owner's UI is dark, and the scheme persists to localStorage — set it before first
  // paint rather than clicking the toggle after it.
  const ctx = await browser.newContext({ viewport: { width: 1420, height: 1000 } });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('charcuterie-scheme', 'dark');
    } catch {
      /* private mode — the shot is light then, and says so */
    }
  });

  const page = await ctx.newPage();
  const settle = async (selector: string) => {
    await page.waitForSelector(selector, { timeout: 30000 });
    await page.waitForTimeout(1500);
  };

  // ── 1. the queue list ──────────────────────────────────────────────────────────────── //

  await page.goto(`http://localhost:${PORT}/queues`, { waitUntil: 'domcontentloaded' });
  await settle('.shelf');
  await page.screenshot({ path: `__screenshots__/queuepeople-${TAG}-queues.png` });

  const faces = await page.$$eval('.shelf h2 .pface', (nodes) => nodes.length);
  const names = await page.$$eval('.shelf h2 .qpname', (nodes) => nodes.length);
  const titles = await page.$$eval('.shelf h2 .lbl', (nodes) =>
    nodes.slice(0, 4).map((n) => n.textContent ?? ''),
  );
  console.log(
    faces > 0 && names > 0
      ? `${faces} avatar badges and ${names} audience names on the shelves — controls aligned with names`
      : `${faces} avatar badges and ${names} audience names on the shelves — unexpected state`,
  );
  console.log(`first four shelf titles: ${JSON.stringify(titles)}`);

  // ── 2. the editor, and 3. one audience move ────────────────────────────────────────── //

  // `family` is a Movies queue that `bob-others` claims, so it opens with a group already in
  // Must be here — the migration's own output, rather than a pose.
  const gear = await page.$('.shelf[data-set="family"] .shelfedit');
  if (gear) {
    await gear.click();
    await page.waitForSelector('#setmodal', { timeout: 15000 });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `__screenshots__/queuepeople-${TAG}-editor.png` });

    const audience = await page.$('#set-people .audiencerow');
    if (audience) {
      // THE ONE-TAP MOVE. The row's segmented control says exactly which section it will use.
      const nice = page.locator('#set-people .audiencerow').first().locator('[role="radio"]').nth(1);
      await nice.click();
      await page.waitForTimeout(700);
      await page.screenshot({ path: `__screenshots__/queuepeople-${TAG}-move.png` });
      console.log('the first audience row moved with its visible Nice action');
    } else {
      console.log('no audience rows in the editor — the BEFORE state');
    }
    await page.click('#setmodal .modalx');
    await page.waitForTimeout(600);
  } else {
    console.log('no `family` shelf — check the fixture');
  }

  // ── 4. the Narrow View ─────────────────────────────────────────────────────────────── //
  //
  // NARROW VIEW, named for the WIDTH. `isMobile` is Playwright's own name and is kept as-is —
  // third-party API surface is not renamed to match the house vocabulary — and it is what
  // makes Chromium honour the viewport meta and widen the LAYOUT viewport on overflow, which
  // a bare 390px `viewport` does not.
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
  await narrow.goto(`http://localhost:${PORT}/queues`, { waitUntil: 'domcontentloaded' });
  await narrow.waitForSelector('.shelf', { timeout: 30000 });
  await narrow.waitForTimeout(1500);

  const narrowGear = await narrow.$('.shelf[data-set="family"] .shelfedit');
  if (narrowGear) {
    await narrowGear.click();
    await narrow.waitForSelector('#setmodal', { timeout: 15000 });
    await narrow.waitForTimeout(1500);
  }
  await narrow.screenshot({ path: `__screenshots__/queuepeople-${TAG}-narrow.png` });

  // The one thing the Narrow View must never do, asserted rather than eyeballed.
  const overflow = await narrow.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  console.log(
    overflow > 1
      ? `⚠️ the Narrow View scrolls horizontally by ${overflow}px`
      : 'the Narrow View does not scroll horizontally',
  );
  await narrowCtx.close();

  console.log(`shot: __screenshots__/queuepeople-${TAG}-{queues,editor,move,narrow}.png`);
} finally {
  await browser.close();
  if (server) killServer(server);
}
