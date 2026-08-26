// The before/after for "a game title paints over the page header".
//
// `app.css` styled the bare `header` ELEMENT, and Charcuterie's `Card` renders its heading in
// one — so every board-game card's title inherited the page header's `position: sticky;
// top: 0; z-index: 10` (plus its background, padding and hairline) and stuck to the VIEWPORT
// top. Same z-index and later in the DOM, so the card title won and painted over the real
// header. Scoping every rule to `#apphead` is the fix.
//
// The shot must be a VIEWPORT capture at a SHORT height: `fullPage: true` unsticks everything
// and shows nothing, and at 1100px the four-game fixture does not scroll at all.
//
// **Fixture data, never live.** Four invented titles from the shared harness
// (decision `2026-08-19-pr-screenshots-are-fixture-data-never-live`).
//
//   PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers-queuepilot \
//     server/node_modules/.bin/tsx e2e/shot-header-overlap.ts --tag=after
import {
  startBoardGameServer,
  stopBoardGameServer,
} from './board-game-play-harness.js';
import { chromium } from './playwright.js';

const PORT = 18871;
const tagArg = process.argv.find((a) => a.startsWith('--tag='));
const TAG = tagArg ? tagArg.slice('--tag='.length) : 'after';

const server = await startBoardGameServer(PORT);
const browser = await chromium.launch();

try {
  const ctx = await browser.newContext({ viewport: { width: 1420, height: 620 } });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('charcuterie-scheme', 'dark');
    } catch {
      /* private mode — the shot is light then, and says so */
    }
  });

  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

  await page.goto(`${server.base}/board-game-collection`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#collection:not([hidden]) #collection-grid', { timeout: 30000 });
  await page.waitForTimeout(900);

  // Scroll far enough that the first row's card titles are above the page header's bottom
  // edge. That is the state the bug lives in; unscrolled, both look identical.
  await page.mouse.wheel(0, 420);
  await page.waitForTimeout(600);

  const path = `__screenshots__/header-overlap-${TAG}.png`;
  await page.screenshot({ path });
  console.log('wrote', path);

  // The measurement behind the picture: a card heading that is `sticky` at the viewport top
  // is the defect, whatever the pixels look like.
  const probe = await page.evaluate(() => {
    const head = document.querySelector('#collection-grid header');
    const cs = head ? getComputedStyle(head) : null;
    return {
      cardHeaderPosition: cs?.position ?? '(no card header)',
      cardHeaderZIndex: cs?.zIndex ?? '(none)',
      pageHeaderIsScoped: Boolean(document.querySelector('#apphead')),
    };
  });
  console.log(TAG, JSON.stringify(probe));
} finally {
  await browser.close();
  stopBoardGameServer(server);
}
