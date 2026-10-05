import {
  expectNoHorizontalOverflow,
  expectNoSplitWords,
} from '@charcuterie/playwright-config/responsive.js';
import { expect, type Page, test } from '@playwright/test';

import { SMOKE_FIXED_NOW, smokeServers } from './ports.js';

// The browser smoke. Every top-level route, in each of the fleet's four windows (one Playwright
// project per window — see `../playwright.config.ts`): the route paints its own data, throws
// nothing, and nothing overflows the window sideways. A full-page screenshot per route and
// window goes into the HTML report as an ATTACHMENT for a person to look at; it is compared
// against nothing — the pixel comparison is the `vrt` job's work (`vrt-capture.ts`).
//
// The routes are `web/src/lib/routePaths.ts` minus the LEGACY addresses, which only paint the
// page they moved to (`routing-test.ts` pins those), plus one unknown path for the fallback.
// Each waits for the same ready marker VRT waits for: a marker that proves the DATA painted,
// not just the shell. Everything on screen is the repo's invented cast.

interface RouteCase {
  name: string;
  path: string;
  server: keyof typeof smokeServers;
  /** The view's own marker. It must prove the data painted, not just the shell. */
  ready: string;
}

const LANDING_READY = '#mode-landing:not([hidden]) [role="group"][aria-label="Start something"]';

const routes: RouteCase[] = [
  { name: 'home', path: '/', ready: LANDING_READY, server: 'landing' },
  { name: 'overview', path: '/overview', ready: '#play:not([hidden]) .playcard', server: 'landing' },
  { name: 'people', path: '/people', ready: '#people', server: 'landing' },
  { name: 'pending', path: '/pending', ready: '#pending:not([hidden])', server: 'landing' },
  { name: 'collection', path: '/collection', ready: '#collection-picker:not([hidden])', server: 'landing' },
  { name: 'queues', path: '/queues', ready: '.shelf', server: 'landing' },
  { name: 'picks queue', path: '/q/family', ready: '#queue:not([hidden]) li.tile', server: 'landing' },
  { name: 'rules queue', path: '/channels/younger', ready: '#chbody', server: 'landing' },
  // The fallback: an unknown path paints the task home and keeps its address.
  { name: 'unknown path', path: '/no/such/route', ready: LANDING_READY, server: 'landing' },
  { name: 'calendar', path: '/calendar', ready: '#calendar-rows > li', server: 'calendar' },
  {
    name: 'what to watch/play',
    path: '/what-to-watch-play',
    ready: '#tonight:not([hidden]) #tonight-activity [role="radiogroup"]',
    server: 'tonight',
  },
  {
    name: 'board games',
    path: '/collection/board-games',
    ready: '#collection:not([hidden]) #collection-grid',
    server: 'boardGames',
  },
  { name: 'result', path: '/result/tidewright', ready: '#result:not([hidden]) #result-card', server: 'boardGames' },
];

/**
 * The page is at rest when the store's load has FINISHED and its toast has gone — the same
 * three states `vrt-capture.ts` waits out: the first `/api/queues` (about eleven seconds on the
 * no-Plex path), the revalidation behind it (`/api/queues?fresh=1`, which paints
 * `#revalidating`), and the "Ready" toast in `#status`. A layout measured before that measures
 * a page without its data. `/api/events` is the live subscription and never finishes, so it is
 * not counted.
 */
const trackApi = (page: Page) => {
  const inFlight = new Set<unknown>();
  let hasRevalidated = false;
  let lastChange = Date.now();
  const isCounted = (url: string) => url.includes('/api/') && !url.includes('/api/events');
  const done = (request: { url(): string }) => {
    if (!isCounted(request.url())) return;
    inFlight.delete(request);
    lastChange = Date.now();
    if (request.url().includes('/api/queues?fresh=1')) hasRevalidated = true;
  };
  page.on('request', (request) => {
    if (!isCounted(request.url())) return;
    inFlight.add(request);
    lastChange = Date.now();
  });
  page.on('requestfinished', done);
  page.on('requestfailed', done);

  return async () => {
    await expect
      .poll(() => hasRevalidated && inFlight.size === 0 && Date.now() - lastChange > 750, {
        message: 'the store load and its revalidation finish',
        timeout: 75_000,
      })
      .toBe(true);
    await page.waitForFunction(() => {
      const status = document.querySelector('#status');
      return (!status || (status.textContent ?? '') === '') && !document.querySelector('#revalidating');
    });
  };
};

/**
 * No box that SCROLLS sideways is wider inside than it is outside.
 *
 * The clipping half of this rule is `expectNoHorizontalOverflow`'s own since
 * `@charcuterie/playwright-config` 2.1.0: it asks every `overflow-x: hidden | clip` box, which
 * is what catches a box cut off under `<main>`'s `overflow-x: hidden` (a 600px box injected into
 * the board-game grid at 384px measured `scrollWidth` 384 on the document while `<main>` held 617
 * inside 384). It deliberately leaves `auto`/`scroll` alone, because a fleet table scrolls on
 * purpose. This app has exactly ONE deliberate sideways scroller — `.strip`, the Plex-style
 * poster shelf, a carousel that is supposed to run off the edge — so here every OTHER inline
 * scroller is a mistake: `.chfilters-scroll`'s `overflow-y: auto` once computed `overflow-x` to
 * `auto` too and shipped a horizontal scrollbar at every width. `narrow-scroll-test.ts` holds
 * that rule at 390 and 320 only, over one fixture that leaves the board-game routes empty; this
 * holds it on every route, with its data painted, in all four windows.
 */
const expectNoStrayInlineScroller = async (page: Page) => {
  const offenders = await page.evaluate(() =>
    [...document.querySelectorAll('*')]
      .filter((element) => {
        if (element.closest('.strip')) return false;
        if (!/auto|scroll/.test(getComputedStyle(element).overflowX)) return false;
        return element.scrollWidth > element.clientWidth + 1;
      })
      .map((element) => {
        const classes =
          typeof element.className === 'string' && element.className
            ? `.${element.className.trim().split(/\s+/).slice(0, 2).join('.')}`
            : '';
        return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${classes} (${getComputedStyle(element).overflowX}) is ${element.scrollWidth}px inside ${element.clientWidth}px`;
      })
      .slice(0, 6),
  );
  expect(offenders, 'no box other than the poster strip scrolls on the inline axis').toEqual([]);
};

test.use({ locale: 'en-US', timezoneId: 'UTC' });

for (const route of routes) {
  test(`${route.name} renders without overflowing the window`, async ({ page }, testInfo) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => {
      pageErrors.push(String(error));
    });
    await page.clock.setFixedTime(SMOKE_FIXED_NOW);
    const settle = trackApi(page);

    await page.goto(`${smokeServers[route.server]}${route.path}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator(route.ready).first()).toBeVisible({ timeout: 60_000 });
    await settle();
    // Fonts, then every image to a final state. A poster whose request fails is `complete`
    // too, and that is the settled state here: Plex is a closed port.
    await page.evaluate(() =>
      Promise.all([
        document.fonts.ready,
        ...[...document.images].map((image) =>
          image.complete
            ? null
            : new Promise((resolve) => {
                image.addEventListener('load', resolve, { once: true });
                image.addEventListener('error', resolve, { once: true });
              }),
        ),
      ]),
    );

    expect(new URL(page.url()).pathname).toBe(route.path);

    // The document, and every box that CLIPS (`hidden`/`clip`) — `<main>` is one, so a box cut
    // off at the screen edge fails here rather than measuring clean. No `ignore`: `.strip`
    // scrolls (`overflow-x: auto`), which this helper never flags. A single-line `ellipsis`
    // box (`#sub`, the header's subtitle) is skipped by the helper itself.
    await expectNoHorizontalOverflow(page);
    // A heading that breaks a word in the middle is a squeezed layout that `wrap-anywhere` hid.
    await expectNoSplitWords(page);
    await expectNoStrayInlineScroller(page);

    // The layout viewport is the window. Under `isMobile` (the `narrow` window), Chromium
    // honors `<meta name="viewport">` and WIDENS the layout viewport to fit content that
    // overflows, and then `scrollWidth` and `clientWidth` agree with each other at the wider
    // figure — the 2026-08-16 Narrow View report, where every fixed overlay hung off the right
    // edge of the screen while the document reported no overflow. `innerWidth` is the number
    // that moves (`narrow-scroll-test.ts` §7).
    const windowWidth = testInfo.project.use.viewport?.width;
    expect(await page.evaluate(() => window.innerWidth), 'the layout viewport is the window').toBe(
      windowWidth,
    );

    await testInfo.attach(`${route.name} (${testInfo.project.name})`, {
      body: await page.screenshot({ animations: 'disabled', caret: 'hide', fullPage: true }),
      contentType: 'image/png',
    });

    expect(pageErrors).toEqual([]);
  });
}
