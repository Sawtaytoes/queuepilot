// WP-7's before/after shots — Pick, driven to a real answer for each activity it connects.
//
// Self-contained: its own server, its own temp copies of `fixtures/tonight.*`, an unroutable
// Plex. `--tag=` names the output, so the same script shoots BEFORE on `main` and AFTER on the
// branch and the two are comparable frame for frame.
//
// On `main` the pick never happens — Go is disabled and the form says the engine is not built —
// so this script SHOOTS THAT and stops rather than failing. The "before" of the result frames
// is that the screen did not exist, and the PR says so in words.
//
// **Fixture data, never live.** This screen renders people and queue labels, and both of those
// are the household. The cast here is the repo's own — Ada, Grace and Linus
// (decision `2026-08-19-pr-screenshots-are-fixture-data-never-live`).
//
//   PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers \
//     server/node_modules/.bin/tsx e2e/shot-tonight-pick.ts --tag=after
import { chromium } from './playwright.js';
import { startTonightServer, stopTonightServer } from './tonight-harness.js';

const PORT = 18848;
const tagArg = process.argv.find((a) => a.startsWith('--tag='));
const TAG = tagArg ? tagArg.slice('--tag='.length) : 'after';

const server = await startTonightServer(PORT);
const browser = await chromium.launch();

try {
  // The owner's UI is dark, and the scheme persists to localStorage — so it is set before the
  // first paint rather than by clicking the toggle after it.
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
    const path = `__screenshots__/tonight-pick-${TAG}-${name}.png`;
    await page.screenshot({ fullPage: true, path });
    console.log('wrote', path);
  };

  const open = async (path = '/tonight') => {
    await page.goto(`${server.base}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#tonight:not([hidden])', { timeout: 30000 });
    await page.waitForTimeout(1200);
  };

  const tile = (label: string) => `#tonight-activity [role="radio"]:has-text("${label}")`;
  const mode = (label: string) => `#tonight-mode [role="radio"]:has-text("${label}")`;

  /** Choose an activity, force the segment onto Pick, and press Go. */
  const pick = async (label: string): Promise<boolean> => {
    await open();
    await page.click(tile(label));
    await page.click(mode('Pick'));
    await page.waitForTimeout(400);
    if (await page.$eval('#tonight-go', (el) => el.hasAttribute('disabled'))) return false;
    await page.click('#tonight-go');
    try {
      await page.waitForSelector('#result-queue', { timeout: 12000 });
      return true;
    } catch {
      return false;
    }
  };

  // ── 1. THE FRAME THAT CHANGED. Go, on Pick, for an activity that is not board games ── //
  // On `main` this is a disabled button under "Board games are connected; the other
  // activities are not yet". On the branch it is a live Go.
  await open();
  await page.click(tile('Shows'));
  await page.click(mode('Pick'));
  await page.waitForTimeout(400);
  await shot('go-on-pick');

  const isConnected = await pick('Shows');
  if (!isConnected) {
    console.log('Pick is not connected in this build — the before frames are the whole set.');
  } else {
    // ── 2. THE RESULT. One queue, what it would come up with next, and how to start it ── //
    // Shows has a rotation channel AND a curated queue in the fixture, and which one comes up
    // is a real draw. The interesting frame is the curated one, because it names its head — so
    // this DRAWS AGAIN from the form until it lands on that.
    //
    // Not by pressing Reroll: a reroll remembers what it turned down, so a few of them empty
    // the activity and the frame ends up showing the "nothing else tonight" state instead. A
    // fresh pass through the form is a fresh evening.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const line = await page.$eval('#result-upnext', (el) => el.textContent ?? '');
      if (line.startsWith('Up next')) break;
      await pick('Shows');
    }
    await shot('result-shows');

    // ── 3. THE SHORTLIST. Two queues serve Shows in the fixture, both on Plex ────────── //
    const toggle = await page.$('#result-shortlist-toggle');
    if (toggle) {
      await toggle.click();
      await page.waitForSelector('#result-shortlist', { timeout: 5000 });
      await shot('result-shortlist');
    }

    // ── 4. A FILTER THAT GOES NOWHERE YET SAYS SO ───────────────────────────────────── //
    // Video Games collects "Knows how to play" and there is no video-game known-how table.
    // The card says that out loud rather than dropping the answer.
    if (await pick('Video Games')) await shot('result-video-games');

    // ── 5. READING — a PULL queue, so Go is the stable `/go/<id>` launcher ───────────── //
    if (await pick('Reading')) await shot('result-reading');

    // ── 6. THE NARROW VIEW ──────────────────────────────────────────────────────────── //
    // Not "mobile": the trigger is the WIDTH. Same markup, one column.
    await page.setViewportSize({ width: 390, height: 1400 });
    if (await pick('Shows')) await shot('result-narrow');
  }
} finally {
  await browser.close();
  stopTonightServer(server);
}
