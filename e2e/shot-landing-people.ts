// Before/after for "the landing card says who its queue is for".
//
// Two frames, and each one is a claim the PR makes:
//
//   1. `landing`  the Admin landing (`/overview`) at 1420px. On main a Picks card is a name, a count and a
//                 start button; on the branch it carries the same row of faces the Picks page
//                 draws in a shelf heading. A card nobody is filed on says "Anybody" — which
//                 is the state, not a blank.
//   2. `narrow`   the same page at 390px. The faces wrap inside the card and the page does not
//                 scroll horizontally, which is the one thing the Narrow View must never do.
//
// The BEFORE run is expected to find no faces. It says so on stdout rather than failing —
// that is the state it is documenting.
//
// **Fixture data, never live.** This repo is public and a PNG is opaque to every grep, so this
// reuses `shot-queue-people.ts`'s cast — Ada, Grace and Linus over the landing fixture's
// anonymized queues (decision `2026-08-19-pr-screenshots-are-fixture-data-never-live`).
//
//   PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers-queuepilot \
//     server/node_modules/.bin/tsx e2e/shot-landing-people.ts --tag=before
import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';

import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

// Its own port and its own temp files. A harness that shared them with `shot-queue-people.ts`
// could not be run beside it, and the two are run back to back.
const PORT = 18798;
const tagArg = process.argv.find((a) => a.startsWith('--tag='));
const TAG = tagArg ? tagArg.slice('--tag='.length) : 'after';

const env = {
  ...process.env,
  CACHE_PATH: '/tmp/cache-shotlandingpeople.sqlite',
  GROUPS_PATH: '/tmp/groups-shotlandingpeople.yaml',
  HISTORY_PATH: '/tmp/history-shotlandingpeople.json',
  // The shell in this workspace carries real MQTT_* values, and a harness that does not blank
  // them dials the household broker and retries forever.
  MQTT_HOST: '',
  MQTT_PASS: '',
  MQTT_PORT: '',
  MQTT_USER: '',
  NODE_TLS_REJECT_UNAUTHORIZED: '0',
  PLEX_API_SERVER_URL: 'https://127.0.0.1:1',
  PLEX_TOKEN: '',
  QUEUES_PATH: '/tmp/queues-shotlandingpeople.yaml',
  SETS_PATH: '/tmp/sets-shotlandingpeople.yaml',
  WEB_PORT: String(PORT),
};

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
  '/tmp/queues-shotlandingpeople.queuepilot.sqlite',
  '/tmp/cache-shotlandingpeople.sqlite',
]) {
  await fs.rm(stale, { force: true });
}

await fs.mkdir('__screenshots__', { recursive: true });

let server: ChildProcess | undefined;
const browser = await chromium.launch();

// The owner's UI is dark, and the scheme persists to localStorage — set it before first paint
// rather than clicking the toggle after it.
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

  // ── 1. the landing ─────────────────────────────────────────────────────────────────── //

  const ctx = await browser.newContext({ viewport: { width: 1420, height: 1000 } });
  await ctx.addInitScript(darkInit);
  const page = await ctx.newPage();

  await page.goto(`http://localhost:${PORT}/overview`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.playcard', { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `__screenshots__/landingpeople-${TAG}-landing.png` });

  const faces = await page.$$eval('#play .pface', (nodes) => nodes.length);
  const anybody = await page.$$eval('#play .qpeople.none', (nodes) => nodes.length);
  console.log(
    faces === 0
      ? 'no faces on any landing card — the BEFORE state'
      : `${faces} faces across the landing cards, and ${anybody} card(s) saying "Anybody"`,
  );

  // A Rules card carries a people row TOO, since 2026-08-26. This line used to assert the
  // opposite and warn when one appeared: the argument was that a filtered pool is bound to one
  // provider account and its meta line already says so. The owner reported the other half —
  // there was no way to put a person on Shorts or Movies at all — and the rows were in
  // `queue_people` the whole time (decision `2026-08-26-a-rules-queue-carries-people-too`).
  // `shot-rules-people.ts` is this change's own before/after.
  const onRules = await page.$$eval(
    '.playcard[data-kind="rules"] .qpeople',
    (nodes) => nodes.length,
  );
  console.log(
    onRules === 0
      ? '⚠️ no people row on any Rules card'
      : `${onRules} Rules card(s) carry a people row`,
  );

  await ctx.close();

  // ── 2. the Narrow View ─────────────────────────────────────────────────────────────── //
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
  await narrowCtx.addInitScript(darkInit);
  const narrow = await narrowCtx.newPage();
  await narrow.goto(`http://localhost:${PORT}/overview`, { waitUntil: 'domcontentloaded' });
  await narrow.waitForSelector('.playcard', { timeout: 30000 });
  await narrow.waitForTimeout(1500);
  // SCROLL TO A PICKS CARD FIRST. The fixture's Rules cards sort ahead of the Picks ones and
  // fill a 390px viewport on their own, so an unscrolled frame shows only the kind this change
  // does not touch — before and after came out byte-identical, which reads as "no effect in
  // the Narrow View" rather than "the wrong part of the page".
  await narrow
    .locator('.playcard[data-kind="picks"]')
    .first()
    .scrollIntoViewIfNeeded();
  await narrow.waitForTimeout(600);
  await narrow.screenshot({ path: `__screenshots__/landingpeople-${TAG}-narrow.png` });

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
