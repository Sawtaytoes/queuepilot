// The Tonight surface's before/after shots, driven to the states that actually changed.
//
// Self-contained: its own server, its own temp copies of `fixtures/tonight.*`, an
// unroutable Plex. `--tag=` names the output, so the same script shoots BEFORE on main and
// AFTER on the branch and the two are comparable frame for frame — except that on main
// there is no `/tonight` at all, which is the point and which the BEFORE frame shows.
//
// **Fixture data, never live.** This screen renders PEOPLE and queue labels, and both of
// those are the household. The cast here is the repo's own — Ada, Grace and Linus
// (decision `2026-08-19-pr-screenshots-are-fixture-data-never-live`).
//
//   PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers \
//     server/node_modules/.bin/tsx e2e/shot-tonight.ts --tag=after
import { chromium } from './playwright.js';
import { startTonightServer, stopTonightServer } from './tonight-harness.js';

const PORT = 18842;
const tagArg = process.argv.find((a) => a.startsWith('--tag='));
const TAG = tagArg ? tagArg.slice('--tag='.length) : 'after';

const server = await startTonightServer(PORT);
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
    const path = `__screenshots__/tonight-${TAG}-${name}.png`;
    await page.screenshot({ fullPage: true, path });
    console.log('wrote', path);
  };

  const open = async (path = '/tonight') => {
    await page.goto(`${server.base}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#tonight:not([hidden])', { timeout: 30000 });
    // The queues come from `/api/sets`, which the landing loads on boot.
    await page.waitForTimeout(1200);
  };

  const tile = (label: string) => `#tonight-activity [role="radio"]:has-text("${label}")`;
  const mode = (label: string) => `#tonight-mode [role="radio"]:has-text("${label}")`;

  // ── 1. The form as it opens ─────────────────────────────────────────────────────── //
  // Video Games is lit because the control selects its first option and this component
  // agrees with it rather than arguing. Pick is its default, so the filters are on screen.
  await open();
  await shot('open');

  // ── 2. A PICK default, with people ticked ───────────────────────────────────────── //
  // Board games start on Pick — one of the three defaults the decision fixes.
  await page.click('input[value="ada"]');
  await page.click('input[value="grace"]');
  await page.click('#guests-up');
  await page.click(tile('Board Games'));
  await page.waitForSelector('#tonight-filters', { timeout: 10000 });
  await shot('pick-board-games');

  // ── 3. A QUEUES default, with TWO matches ───────────────────────────────────────── //
  // Reading starts on Queues — the second of the three fixed defaults — and the fixture
  // holds two reading queues, so the host has to choose.
  await page.click(tile('Reading'));
  await page.waitForSelector('#tonight-queue [role="radiogroup"]', { timeout: 10000 });
  await shot('queues-two-matches');

  // ── 4. ONE match, implied rather than asked ─────────────────────────────────────── //
  // Movies has a single queue in the fixture, so there is no question to put.
  await page.click(tile('Movies'));
  await page.click(mode('Queues'));
  await page.waitForSelector('#tonight-queue-only', { timeout: 10000 });
  await shot('queues-one-implied');

  // ── 5. Video Games on Queues — the provider badge ───────────────────────────────── //
  // Two backends serve ONE activity here, which is the only condition under which a
  // provider brand is allowed on this screen at all.
  await page.click(tile('Video Games'));
  await page.click(mode('Queues'));
  await page.waitForSelector('#tonight-queue [role="radiogroup"]', { timeout: 10000 });
  await shot('queues-provider-badge');

  // ── 6. Surprise Me's narrowing step ─────────────────────────────────────────────── //
  await page.click(tile('Surprise Me'));
  await page.waitForSelector('#tonight-surprise', { timeout: 10000 });
  await shot('surprise-step');

  // ── 7. The Narrow View ──────────────────────────────────────────────────────────── //
  // Not "mobile": the trigger is the WIDTH. Every grid on this page takes its columns from
  // its CONTAINER, so this is the same markup at one column rather than a second layout.
  await page.setViewportSize({ width: 390, height: 1400 });
  await open();
  await page.click('input[value="ada"]');
  await page.click(tile('Reading'));
  await page.waitForSelector('#tonight-queue', { timeout: 10000 });
  await shot('narrow');
} finally {
  await browser.close();
  stopTonightServer(server);
}
