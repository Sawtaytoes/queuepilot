// A PRESET CARD's before/after shots, driven to the states that actually changed.
//
// The BEFORE frame is the honest one and it is why this script takes a `--tag=`: on `main`
// there is no `/tonight/go` at all, so the address falls through `parsePath`'s unknown-path
// rule and lands on the Tonight FORM — which is exactly the thing the absorb decision's §5
// says a preset card must not do. Shoot it on `main`, shoot the same three states on the
// branch, and the pair says what changed frame for frame.
//
// **Fixture data, never live.** This screen renders PEOPLE and queue labels, and both of
// those are the household. The cast is the repo's own — Ada, Grace and Linus
// (decision `2026-08-19-pr-screenshots-are-fixture-data-never-live`).
//
// ⚠️ The card in frame 1 says `guests=2` rather than naming a person, and that is the
// FIXTURE's constraint rather than the feature's: none of the Tonight fixture's queues
// carries a roster, so ticking a name filters every queue out. Guests are the other half of
// "who's here" and satisfy the same rule.
//
//   PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers \
//     server/node_modules/.bin/tsx e2e/shot-tonight-preset.ts --tag=after
import { chromium } from './playwright.js';
import { startTonightServer, stopTonightServer } from './tonight-harness.js';

const PORT = 18849;
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

  const shot = async (name: string): Promise<void> => {
    await page.waitForTimeout(600);
    const path = `__screenshots__/tonight-preset-${TAG}-${name}.png`;
    await page.screenshot({ fullPage: true, path });
    console.log('wrote', path, '←', page.url());
  };

  /** Tap a card's address and wait for the app to finish deciding where it lands. */
  const tap = async (href: string): Promise<void> => {
    await page.goto(`${server.base}${href}`, { waitUntil: 'domcontentloaded' });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!new URL(page.url()).pathname.startsWith('/tonight/go')) break;
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(1400);
  };

  // ── 1. A VALID PRESET CARD ──────────────────────────────────────────────────────── //
  // BEFORE: the Who's-here form, because the address means nothing yet.
  // AFTER:  the result card, with the queue that was drawn and a reroll.
  await tap('/tonight/go?activity=movies&guests=2');
  await shot('valid-card');

  // ── 2. A CARD THAT NAMES NOBODY ─────────────────────────────────────────────────── //
  // BEFORE: the form, indistinguishable from frame 1 — which is the whole complaint.
  // AFTER:  the form again, but carrying the reason and the activity the card asked for.
  await tap('/tonight/go?activity=board-games&light=on');
  await shot('names-nobody');

  // ── 3. A CARD NAMING SOMETHING THAT IS NOT A TILE ───────────────────────────────── //
  // A card is written once and read for years, so a typo has to say what it said.
  await tap('/tonight/go?activity=retro-games&people=ada');
  await shot('unknown-activity');
} finally {
  await browser.close();
  stopTonightServer(server);
}
