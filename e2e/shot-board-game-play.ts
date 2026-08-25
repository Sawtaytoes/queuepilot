// WP-8's before/after shots, driven to the states that actually changed.
//
// Self-contained: its own server, its own synthetic collection, its own confirmed people
// mapping, an unroutable Plex. `--tag=` names the output, so the same script shoots BEFORE
// on main and AFTER on the branch — except that on main there is no `/collection` and no
// `/result` at all, which is the point and which the BEFORE frames show.
//
// **Fixture data, never live.** Ada, Grace and Linus, four invented titles
// (decision `2026-08-19-pr-screenshots-are-fixture-data-never-live`).
//
//   PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers \
//     server/node_modules/.bin/tsx e2e/shot-board-game-play.ts --tag=after
import {
  startBoardGameServer,
  stopBoardGameServer,
} from './board-game-play-harness.js';
import { chromium } from './playwright.js';

const PORT = 18848;
const tagArg = process.argv.find((a) => a.startsWith('--tag='));
const TAG = tagArg ? tagArg.slice('--tag='.length) : 'after';

const server = await startBoardGameServer(PORT);
const browser = await chromium.launch();

try {
  // The owner's UI is dark, and the scheme persists to localStorage — so it is set before
  // the first paint rather than by clicking the toggle after it.
  const ctx = await browser.newContext({ viewport: { width: 1420, height: 1100 } });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('charcuterie-scheme', 'dark');
    } catch {
      /* private mode — the shot is light then, and says so */
    }
  });

  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

  const shot = async (name: string) => {
    await page.waitForTimeout(500);
    const path = `__screenshots__/wp8-${TAG}-${name}.png`;
    await page.screenshot({ fullPage: true, path });
    console.log('wrote', path);
  };

  const goto = async (path: string, selector: string) => {
    await page.goto(`${server.base}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(selector, { timeout: 30000 });
    await page.waitForTimeout(900);
  };

  // ── 1. The landing, and the way in ──────────────────────────────────────────────── //
  await goto('/', '#play:not([hidden])');
  await shot('landing');

  // ── 2. The shelf ────────────────────────────────────────────────────────────────── //
  await goto('/collection', '#collection:not([hidden]) #collection-grid');
  await shot('collection');

  // ── 3. Marking a game played, and choosing the people ───────────────────────────── //
  await page.click('#bg-harbour-lantern-played');
  await page.waitForSelector('#bg-harbour-lantern-people', { timeout: 10000 });
  await page.click('#bg-harbour-lantern-people input[value="ada"]');
  await page.click('#bg-harbour-lantern-people input[value="grace"]');
  await shot('who-played');

  // ── 4. Known-how marked by default, with Change and Undo ────────────────────────── //
  await page.click('#bg-harbour-lantern-log');
  await page.waitForSelector('#bg-harbour-lantern-result', { timeout: 15000 });
  await shot('known-how-default');

  // ── 5. The Narrow View of the shelf ─────────────────────────────────────────────── //
  await page.setViewportSize({ width: 390, height: 900 });
  await goto('/collection', '#collection:not([hidden]) #collection-grid');
  await shot('collection-narrow');
  await page.setViewportSize({ width: 1420, height: 1100 });

  // ── 6. Tonight, on Board Games, with a table ────────────────────────────────────── //
  await goto('/tonight', '#tonight:not([hidden]) .actgrid');
  await page.click('#tonight-activity [role="radio"]:has-text("Board Games")');
  await page.waitForTimeout(400);
  for (const id of ['ada', 'grace', 'linus']) {
    await page.click(`#tonight-roster input[value="${id}"]`);
  }
  await page.click('#tonight-filters [role="radio"]:has-text("Any")');
  await page.waitForTimeout(400);
  await shot('tonight-board-games');

  // ── 7. ONE card ─────────────────────────────────────────────────────────────────── //
  await page.click('#tonight-go');
  await page.waitForSelector('#result:not([hidden]) #result-card', { timeout: 20000 });
  await page.waitForTimeout(700);
  await shot('result-one-card');

  // ── 8. The shortlist, behind its control ────────────────────────────────────────── //
  await page.click('#result-shortlist-toggle');
  await page.waitForSelector('#result-shortlist', { timeout: 10000 });
  await shot('result-shortlist');

  // ── 9. A queue arrival — the same card with NO reroll ───────────────────────────── //
  await goto('/result/tidewright', '#result:not([hidden]) #result-card');
  await shot('result-queue-arrival');

  // ── 10. The result in the Narrow View ───────────────────────────────────────────── //
  await page.setViewportSize({ width: 390, height: 900 });
  await goto('/result/tidewright', '#result:not([hidden]) #result-card');
  await shot('result-narrow');
} finally {
  await browser.close();
  stopBoardGameServer(server);
}
