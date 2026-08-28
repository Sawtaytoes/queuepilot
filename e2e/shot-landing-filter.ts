// Before/after for "the Admin landing filters by people, and the group chips go".
//
// Three frames, and each one is a claim the PR makes:
//
//   1. `bar`       `/admin` at 1420px. On main the top row is a chip per GROUP — All, Bob,
//                  Demo, Older Kids, Younger Kids — each a single-select link to `/g/<id>`.
//                  On the branch it is a chip per PERSON, multi-select, with Anyone at the
//                  head and the ⚙ Edit people control at the tail.
//   2. `filtered`  `/admin?people=linus`. On main the query is ignored and every card shows
//                  — that IS the before state, and the frame documents it. On the branch the
//                  grid narrows to the queues Linus is on, including the ones he reaches
//                  through the Younger Kids group's "at least one of them" rule.
//   3. `narrow`    the bar at 390px. A dozen chips must wrap, not pan.
//
// **Fixture data, never live.** Ada, Grace, Linus and the anonymized landing cast
// (decision `2026-08-19-pr-screenshots-are-fixture-data-never-live`).
//
//   PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers-queuepilot \
//     server/node_modules/.bin/tsx e2e/shot-landing-filter.ts --tag=before
import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';

import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const PORT = 18796;
const tagArg = process.argv.find((a) => a.startsWith('--tag='));
const TAG = tagArg ? tagArg.slice('--tag='.length) : 'after';

const env = {
  ...process.env,
  CACHE_PATH: '/tmp/cache-shotlandingfilter.sqlite',
  GROUPS_PATH: '/tmp/groups-shotlandingfilter.yaml',
  HISTORY_PATH: '/tmp/history-shotlandingfilter.json',
  // The shell in this workspace carries real MQTT_* values, and a harness that does not blank
  // them dials the household broker and retries forever.
  MQTT_HOST: '',
  MQTT_PASS: '',
  MQTT_PORT: '',
  MQTT_USER: '',
  NODE_TLS_REJECT_UNAUTHORIZED: '0',
  PLEX_API_SERVER_URL: 'https://127.0.0.1:1',
  PLEX_TOKEN: '',
  QUEUES_PATH: '/tmp/queues-shotlandingfilter.yaml',
  SETS_PATH: '/tmp/sets-shotlandingfilter.yaml',
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
for (const stale of [
  '/tmp/queues-shotlandingfilter.queuepilot.sqlite',
  '/tmp/cache-shotlandingfilter.sqlite',
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

const cards = (page: { $$eval: (s: string, f: (n: Element[]) => number) => Promise<number> }) =>
  page.$$eval('.playcard', (nodes) => nodes.length);

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

  // ── 1. the bar ─────────────────────────────────────────────────────────────────────── //

  await page.goto(`http://localhost:${PORT}/admin`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.playcard', { timeout: 30000 });
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `__screenshots__/landingfilter-${TAG}-bar.png` });

  const groupChips = await page.$$eval('#groupchips a', (nodes) => nodes.length);
  const peopleChips = await page.$$eval('#peoplechips a', (nodes) => nodes.length);
  console.log(
    peopleChips === 0
      ? `${groupChips} GROUP chips and no people chips — the BEFORE state`
      : `${peopleChips} people chips (Anyone + the roster) and ${groupChips} group chips`,
  );

  const unfiltered = await cards(page);

  // ── 2. one person ticked ───────────────────────────────────────────────────────────── //

  await page.goto(`http://localhost:${PORT}/admin?people=linus`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('.playcard', { timeout: 30000 });
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `__screenshots__/landingfilter-${TAG}-filtered.png` });

  const filtered = await cards(page);
  console.log(
    filtered === unfiltered
      ? `?people=linus changes nothing — ${filtered} cards either way, the BEFORE state`
      : `?people=linus narrows ${unfiltered} cards to ${filtered}`,
  );

  await ctx.close();

  // ── 3. the Narrow View ─────────────────────────────────────────────────────────────── //
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
  await narrow.goto(`http://localhost:${PORT}/admin`, { waitUntil: 'domcontentloaded' });
  await narrow.waitForSelector('.playcard', { timeout: 30000 });
  await narrow.waitForTimeout(1500);
  await narrow.screenshot({ path: `__screenshots__/landingfilter-${TAG}-narrow.png` });

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
