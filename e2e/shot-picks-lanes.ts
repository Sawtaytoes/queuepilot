// Before/after for "a Picks queue lives on the Picks screen, whichever lane it defaults to".
//
// Four frames, and each one is a claim the PR makes:
//
//   1. `queues`   the Picks page. On main it lists only the priority-lane queues; on the
//                 branch it lists EVERY Picks queue, and a shelf says which lane each poster
//                 is in — a count clause in the heading and a divider inside the strip.
//   2. `rules`    the Rules page's picker, OPEN. On main it appends five Picks queues under a
//                 `q:` prefix; on the branch it is rules queues and nothing else.
//   3. `moveto`   the selection bar's Move-to picker, open. Every row is called after its
//                 ACTIVITY now, so the chip beside each one is who the queue is for.
//   4. `narrow`   the Picks page at 390px. The lane clause wraps under the name rather than
//                 pushing the shelf into a horizontal scroll.
//
// **Fixture data, never live.** This repo is public and a PNG is opaque to every grep, so the
// people here are the landing fixture's anonymized cast — Ada, Grace, Linus and queues named
// for Bob, Alice, Carol and Dave (decision `2026-08-19-pr-screenshots-are-fixture-data-never-live`).
//
//   PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers-queuepilot \
//     server/node_modules/.bin/tsx e2e/shot-picks-lanes.ts --tag=before
import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';

import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const PORT = 18799;
const tagArg = process.argv.find((a) => a.startsWith('--tag='));
const TAG = tagArg ? tagArg.slice('--tag='.length) : 'after';

const env = {
  ...process.env,
  CACHE_PATH: '/tmp/cache-shotpickslanes.sqlite',
  GROUPS_PATH: '/tmp/groups-shotpickslanes.yaml',
  HISTORY_PATH: '/tmp/history-shotpickslanes.json',
  // The shell in this workspace carries real MQTT_* values, and a harness that does not blank
  // them dials the household broker and retries forever.
  MQTT_HOST: '',
  MQTT_PASS: '',
  MQTT_PORT: '',
  MQTT_USER: '',
  NODE_TLS_REJECT_UNAUTHORIZED: '0',
  PLEX_API_SERVER_URL: 'https://127.0.0.1:1',
  PLEX_TOKEN: '',
  QUEUES_PATH: '/tmp/queues-shotpickslanes.yaml',
  SETS_PATH: '/tmp/sets-shotpickslanes.yaml',
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
  '/tmp/queues-shotpickslanes.queuepilot.sqlite',
  '/tmp/cache-shotpickslanes.sqlite',
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

  // THE MIXED QUEUE. Nothing in the fixture carries a `placement`, so every shelf would draw
  // one lane and the divider — the thing this PR adds — would never appear. Promoting two
  // entries through the app's own endpoint is the state a person reaches by pressing the
  // tile's ⬆, so the frame shows a real arrangement rather than a hand-built one.
  //
  // It runs on BOTH tags on purpose. `main` accepts the same PATCH (the placement route
  // landed with the queue page's two lanes) and simply has nowhere on this page to show the
  // result, which is exactly what the before/after pair is claiming.
  const mixed = await fetch(`http://localhost:${PORT}/api/queues`)
    .then((r) => r.json() as Promise<{ sets: Record<string, { items: { key: string }[] }> }>)
    .catch(() => null);
  for (const [setId, lane, count] of [
    ['bob_anime', 'priority', 2],
    ['family', 'random', 2],
  ] as const) {
    for (const item of (mixed?.sets[setId]?.items ?? []).slice(0, count)) {
      await fetch(
        `http://localhost:${PORT}/api/queues/${setId}/items/${encodeURIComponent(item.key)}/placement`,
        {
          body: JSON.stringify({ placement: lane }),
          headers: { 'content-type': 'application/json' },
          method: 'PATCH',
        },
      ).catch(() => {});
    }
  }

  // The owner's UI is dark, and the scheme persists to localStorage — set it before first
  // paint rather than clicking the toggle after it.
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
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

  // ── 1. the Picks page ──────────────────────────────────────────────────────────────── //

  await page.goto(`http://localhost:${PORT}/queues`, { waitUntil: 'domcontentloaded' });
  await settle('.shelf');
  await page.screenshot({ path: `__screenshots__/pickslanes-${TAG}-queues.png`, fullPage: true });

  const shelves = await page.$$eval('.shelf', (nodes) =>
    nodes.map((n) => (n as HTMLElement).dataset.set ?? ''),
  );
  const clauses = await page.$$eval('.shelf h2 .lanes-sec', (nodes) =>
    nodes.map((n) => n.textContent ?? ''),
  );
  console.log(`${shelves.length} shelves: ${JSON.stringify(shelves)}`);
  console.log(
    clauses.length === 0
      ? 'no lane clause on any shelf — the BEFORE state'
      : `lane clauses: ${JSON.stringify(clauses)}`,
  );
  console.log(`lane dividers in the strips: ${(await page.$$('.lanesplit')).length}`);

  // ── 2. the Rules picker, open ──────────────────────────────────────────────────────── //

  await page.goto(`http://localhost:${PORT}/channels`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="chchannel"]', { timeout: 30000 });
  await page.click('[data-testid="chchannel"]');
  await page.waitForSelector('[role="option"]', { timeout: 15000 });
  await page.waitForTimeout(600);
  const options = await page.$$eval('[role="option"]', (nodes) =>
    nodes.map((n) => (n.textContent ?? '').trim()),
  );
  console.log(`rules picker (${options.length}): ${JSON.stringify(options)}`);
  await page.screenshot({ path: `__screenshots__/pickslanes-${TAG}-rules.png` });
  await page.keyboard.press('Escape');

  // ── 3. the Move-to picker, open ────────────────────────────────────────────────────── //
  //
  // Select one tile on a queue page and the selection bar appears with "Move to". Its options
  // are every OTHER Picks queue — both lanes since this PR — and each one wears the people
  // chip, because "Movies & Shows 2" on its own names nothing.
  //
  // This picker and not one of the two Add-to menus, only because Plex is unreachable here:
  // both of those list the queues that hold the searched item's LIBRARY, and the search
  // returns nothing offline. They carry the same chip, from the same helper.
  await page.goto(`http://localhost:${PORT}/q/bob_anime`, { waitUntil: 'domcontentloaded' });
  await settle('#queue li.tile');
  const check = await page.$('#queue li.tile .check');
  if (check) {
    await check.click();
    await page.waitForSelector('[data-testid="movetarget"]', { timeout: 15000 });
    await page.click('[data-testid="movetarget"]');
    await page.waitForSelector('[role="option"]', { timeout: 15000 });
    await page.waitForTimeout(600);
    const rows = await page.$$eval('[role="option"]', (nodes) =>
      nodes.map((n) => (n.textContent ?? '').trim()),
    );
    console.log(`move-to rows (${rows.length}): ${JSON.stringify(rows)}`);
    await page.screenshot({ path: `__screenshots__/pickslanes-${TAG}-moveto.png` });
    await page.keyboard.press('Escape');
  } else {
    console.log('no selectable tile on the queue page — check the fixture');
  }
  await ctx.close();

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
  await narrow.screenshot({ path: `__screenshots__/pickslanes-${TAG}-narrow.png` });

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
