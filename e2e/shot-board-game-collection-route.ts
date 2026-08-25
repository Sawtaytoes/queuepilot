// The route rename's shots: the shelf on its NEW address, that address surviving a reload,
// and the LEGACY address rewriting itself.
//
// A route change is invisible in a normal screenshot — the page looks identical and the URL
// is browser chrome Playwright does not capture. So each frame carries a caption strip that
// is read out of `location.href` at the moment of the shot. The strip is injected into the
// page, never typed by hand, so it cannot claim an address the browser is not on. It sits at
// the BOTTOM of the viewport, where it covers empty background rather than the header.
//
// Reuses `board-game-play-harness.ts`, so these images and the WP-8 gate stand on the SAME
// synthetic data: Ada, Grace and Linus, and four invented titles. **Fixture data, never
// live** (decision `2026-08-19-pr-screenshots-are-fixture-data-never-live`).
//
//   PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers \
//     server/node_modules/.bin/tsx e2e/shot-board-game-collection-route.ts
import {
  startBoardGameServer,
  stopBoardGameServer,
} from './board-game-play-harness.js';
import { chromium } from './playwright.js';

const PORT = 18849;

const server = await startBoardGameServer(PORT);
const browser = await chromium.launch();

try {
  // The owner's UI is dark, and the scheme persists to localStorage — so it is set before
  // the first paint rather than by clicking the toggle after it.
  const ctx = await browser.newContext({ viewport: { width: 1420, height: 1000 } });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('charcuterie-scheme', 'dark');
    } catch {
      /* private mode — the shot is light then, and says so */
    }
  });

  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

  /** Stamp the LIVE address onto the page, then shoot it. */
  const shot = async (name: string, note: string) => {
    await page.waitForTimeout(600);
    await page.evaluate((n) => {
      document.getElementById('shot-url-strip')?.remove();
      const strip = document.createElement('div');
      strip.id = 'shot-url-strip';
      strip.textContent = `${location.href}          ${n}`;
      strip.style.cssText = [
        'position:fixed', 'inset:auto 0 0 0', 'z-index:99999',
        'font:600 16px/2.4 ui-monospace,SFMono-Regular,Menlo,monospace',
        'padding:0 16px', 'background:#0b3d2e', 'color:#d7ffe9',
        'border-top:2px solid #16a06a', 'letter-spacing:0.02em',
      ].join(';');
      document.body.append(strip);
    }, note);
    const path = `__screenshots__/board-game-collection-route-${name}.png`;
    await page.screenshot({ path });
    console.log('wrote', path, '—', await page.evaluate(() => location.pathname));
  };

  const openShelf = async (path: string) => {
    await page.goto(`${server.base}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#collection:not([hidden]) #collection-grid', { timeout: 30000 });
    await page.waitForTimeout(700);
  };

  // 1. The new address, opened cold.
  await openShelf('/board-game-collection');
  await shot('new-path', 'the shelf on its new address');

  // 2. The same address, RELOADED — the half a client-side router cannot answer on its own.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#collection:not([hidden]) #collection-grid', { timeout: 30000 });
  await shot('reload', 'after a full reload — the SPA fallback answered it');

  // 3. The legacy address. It renders the shelf and rewrites itself.
  await openShelf('/collection');
  await page.waitForFunction(() => location.pathname === '/board-game-collection', undefined, { timeout: 30000 });
  await shot('legacy-redirect', 'opened /collection — redirected, no blank page');
} finally {
  await browser.close();
  stopBoardGameServer(server);
}
