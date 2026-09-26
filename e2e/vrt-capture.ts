// VRT capture: every main screen, in the Wide View and the Narrow View, in both color schemes,
// written as PNGs into `$VRT_ACTUAL_DIR` for the shared `shared-vrt.yml` workflow to compare
// against its baseline (decision `2026-09-25-vrt-shoots-the-main-screens-from-the-e2e-harness`).
//
//   yarn workspace queuepilot-web run build     # the server serves web/dist
//   PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers-queuepilot \
//     VRT_ACTUAL_DIR=$PWD/.vrt-actual server/node_modules/.bin/tsx e2e/vrt-capture.ts
//
// This repo has no Storybook, so the shots come from the same place the PR screenshots and the
// browser gates already come from: the real server over the committed fixtures. Four servers,
// because four fixtures already exist and each one is the right data for its screens:
//
//   * the LANDING fixture (17 sets, six groups, Ada/Grace/Linus) — the task home, the queues,
//     people, pending, the collection picker, one Picks grid and one Rules queue;
//   * the CALENDAR fixture — every combination of a season window and a reset date;
//   * the TONIGHT harness — What to Watch/Play, with its queues filed to people;
//   * the BOARD-GAME harness — the board-game shelf and one result card.
//
// **Fixture data only.** This repo is public and a PNG is opaque to every grep. Every name on
// every shot is the repo's invented cast. Plex is a closed port and every other provider an
// `.invalid` host, so nothing here reaches anything real.
//
// **Deterministic, or it is worse than no shot.** A baseline taken today must match a run next
// month on the same code:
//
//   * the SERVER's clock starts at a fixed instant and its `Math.random` is seeded
//     (`stubs/fixed-clock.mjs`, loaded through NODE_OPTIONS), because the season window, the
//     seasonal reset and "finished" are all computed from `new Date()` on a read;
//   * the BROWSER's `Date` is pinned to the same instant, its `Math.random` is seeded, and the
//     time zone and locale are fixed;
//   * motion is reduced, CSS animations are finished before the shot, the caret is hidden, and
//     each shot waits for its view's own ready marker, the fonts and every image to settle.
//
// Each shot waits for a marker that proves ITS view painted with data. A marker that never
// appears FAILS the run: a shot of a spinner would become the baseline and hide the break.
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { startBoardGameServer, stopBoardGameServer } from './board-game-play-harness.js';
import { chromium, type Browser, type Page, type Request } from './playwright.js';
import { killServer, REPO_ROOT, spawnServer } from './stubs/server-process.mjs';
import { startTonightServer, stopTonightServer } from './tonight-harness.js';

const FIXED_NOW = '2026-06-15T18:00:00.000Z';
const RANDOM_SEED = 20260615;

const OUT = path.resolve(process.env.VRT_ACTUAL_DIR || path.join(REPO_ROOT, '.vrt-actual'));

// Private ports, away from every other harness's.
const LANDING_PORT = 18951;
const TONIGHT_PORT = 18952;
const BOARD_GAME_PORT = 18953;
const CALENDAR_PORT = 18954;

const VIEWS = {
  // The Wide View: the width the landing fixture was drawn for.
  wide: { hasTouch: false, isMobile: false, viewport: { height: 1000, width: 1400 } },
  // The Narrow View: 390px is the reported phone width `narrow-scroll-test` also walks.
  // `isMobile` is what makes Chromium honor `<meta name="viewport">`, so this is the layout a
  // phone really gets rather than a narrow desktop window.
  narrow: { hasTouch: true, isMobile: true, viewport: { height: 844, width: 390 } },
} as const;

const SCHEMES = ['light', 'dark'] as const;

interface Screen {
  /** The file-name stem. Keep it stable: a renamed shot is a deleted shot plus a new one. */
  name: string;
  path: string;
  /** The view's own marker. It must prove the DATA painted, not just the shell. */
  ready: string;
}

// Every harness spreads `process.env` into its server's env, so these reach all four servers.
process.env.TZ = 'UTC';
process.env.VRT_FIXED_NOW = FIXED_NOW;
process.env.VRT_RANDOM_SEED = String(RANDOM_SEED);
process.env.NODE_OPTIONS = [
  process.env.NODE_OPTIONS,
  `--import=${pathToFileURL(path.join(REPO_ROOT, 'e2e', 'stubs', 'fixed-clock.mjs')).href}`,
]
  .filter(Boolean)
  .join(' ');

interface FixtureFiles {
  groups?: string;
  /** Copied under the proposal FILENAME, which is the one the importer reads. */
  people?: string;
  queues: string;
  sets: string;
}

/** Committed fixtures in a private config directory, and a server over them. */
async function startFixtureServer(port: number, files: FixtureFiles) {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'qp-vrt-'));
  const fixture = (name: string) => path.join(REPO_ROOT, 'e2e', 'fixtures', name);

  await fs.copyFile(fixture(files.sets), path.join(dir, 'sets.yaml'));
  await fs.copyFile(fixture(files.queues), path.join(dir, 'queues.yaml'));
  if (files.groups) {
    await fs.copyFile(fixture(files.groups), path.join(dir, 'groups.yaml'));
  } else {
    await fs.writeFile(path.join(dir, 'groups.yaml'), 'groups: []\n');
  }
  if (files.people) {
    await fs.copyFile(fixture(files.people), path.join(dir, 'people-mapping-proposal.yaml'));
  }
  await fs.writeFile(path.join(dir, 'pending.yaml'), 'seen_through: 0\n');

  const child = spawnServer({
    env: {
      ...process.env,
      CACHE_PATH: path.join(dir, 'cache.sqlite'),
      GROUPS_PATH: path.join(dir, 'groups.yaml'),
      HISTORY_PATH: path.join(dir, '.history.json'),
      // The agent shell carries real MQTT_* values; a harness that keeps them dials the
      // household broker.
      MQTT_HOST: '',
      MQTT_PASS: '',
      MQTT_PORT: '',
      MQTT_USER: '',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      PENDING_PATH: path.join(dir, 'pending.yaml'),
      PLEX_API_SERVER_URL: 'https://127.0.0.1:1',
      PLEX_TOKEN: '',
      PROVIDERS_PATH: path.join(dir, 'providers.yaml'),
      PROVIDERS_SECRETS_PATH: path.join(dir, 'providers.secrets.yaml'),
      QUEUES_PATH: path.join(dir, 'queues.yaml'),
      SETS_PATH: path.join(dir, 'sets.yaml'),
      STORE_BACKEND: 'sqlite',
      WEB_PORT: String(port),
    },
    stdio: 'ignore',
  });

  const base = `http://localhost:${port}`;
  await waitReady(`${base}/api/people`);
  return { base, child, dir };
}

async function waitReady(url: string) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`vrt-capture: the server never answered ${url}`);
}

/**
 * The page is at rest when the store's load has FINISHED and its toast has gone. Each step is
 * a separate state a shot could otherwise land in, at a moment that depends on the machine:
 *
 *   1. the first `/api/queues` answers after about eleven seconds on the no-Plex path, where
 *      every Plex read retries against a closed port before it gives up;
 *   2. the revalidation pass behind it (`/api/queues?fresh=1`) paints `#revalidating` until it
 *      answers too;
 *   3. a work page's "Ready" toast in `#status` clears itself four seconds later.
 *
 * The task home draws no header, so it has no `#status` to read — which is why steps 1 and 2
 * are read off the NETWORK rather than the DOM. `/api/events` is the live subscription and
 * never finishes, so it is not counted.
 */
const hasToastCleared = () => {
  const status = document.querySelector('#status');
  return (!status || (status.textContent ?? '') === '') && !document.querySelector('#revalidating');
};

function trackApi(page: Page) {
  const inFlight = new Set<unknown>();
  let hasRevalidated = false;
  let lastChange = Date.now();
  const isCounted = (url: string) => url.includes('/api/') && !url.includes('/api/events');
  const done = (request: Request) => {
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

  return {
    reset() {
      inFlight.clear();
      hasRevalidated = false;
      lastChange = Date.now();
    },
    async settle(label: string) {
      const deadline = Date.now() + 90000;
      while (!(hasRevalidated && inFlight.size === 0 && Date.now() - lastChange > 750)) {
        if (Date.now() > deadline) {
          throw new Error(`vrt-capture: ${label} never settled (revalidated=${hasRevalidated}, in flight=${inFlight.size})`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await page.waitForFunction(hasToastCleared, undefined, { timeout: 30000 });
    },
  };
}

async function shootOne(
  browser: Browser,
  base: string,
  screens: Screen[],
  viewName: keyof typeof VIEWS,
  scheme: (typeof SCHEMES)[number],
) {
  const context = await browser.newContext({
    ...VIEWS[viewName],
    colorScheme: scheme,
    deviceScaleFactor: 1,
    locale: 'en-US',
    reducedMotion: 'reduce',
    timezoneId: 'UTC',
  });
  await context.clock.setFixedTime(FIXED_NOW);
  await context.addInitScript(
    ({ scheme: chosen, seed: initial }) => {
      try {
        localStorage.setItem('charcuterie-scheme', chosen);
      } catch {
        /* no storage — the context's colorScheme still carries it */
      }
      let seed = initial >>> 0;
      Math.random = () => {
        seed = (seed + 0x6d2b79f5) >>> 0;
        let t = seed;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    },
    { scheme, seed: RANDOM_SEED },
  );
  const page = await context.newPage();
  const api = trackApi(page);

  try {
    for (const screen of screens) {
      api.reset();
      await page.goto(`${base}${screen.path}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(screen.ready, { state: 'visible', timeout: 30000 });
      await api.settle(`${screen.name}--${viewName}--${scheme}`);
      // Fonts, then every image to a final state. A poster whose request fails is `complete`
      // too, and that is the settled state here: Plex is a closed port.
      await page.evaluate(
        'Promise.all([document.fonts.ready, ...[...document.images].map((i) => i.complete ? null : new Promise((r) => { i.addEventListener("load", r, { once: true }); i.addEventListener("error", r, { once: true }); }))])',
      );
      // The header's ResizeObserver and the view swap settle in the frames after the marker.
      await page.waitForTimeout(500);
      const file = path.join(OUT, `${screen.name}--${viewName}--${scheme}.png`);
      await page.screenshot({ animations: 'disabled', caret: 'hide', path: file });
      console.log('wrote', path.basename(file));
    }
  } finally {
    await context.close();
  }
}

/**
 * All four view/scheme pairs at once, each in its own context. The store's first load costs
 * about eleven seconds on every page, so running them one after another would take four times
 * as long for the same pictures. The server is read-only for every screen here.
 */
async function shoot(browser: Browser, base: string, screens: Screen[]) {
  const views = Object.keys(VIEWS) as (keyof typeof VIEWS)[];
  await Promise.all(
    views.flatMap((viewName) =>
      SCHEMES.map((scheme) => shootOne(browser, base, screens, viewName, scheme)),
    ),
  );
}

await fs.rm(OUT, { force: true, recursive: true });
await fs.mkdir(OUT, { recursive: true });

const stops: (() => void)[] = [];
const browser = await chromium.launch();

try {
  const landing = await startFixtureServer(LANDING_PORT, {
    groups: 'landing.groups.yaml',
    people: 'landing.people-mapping.yaml',
    queues: 'landing.queues.yaml',
    sets: 'landing.sets.yaml',
  });
  stops.push(() => killServer(landing.child));
  await shoot(browser, landing.base, [
    {
      name: 'home',
      path: '/',
      ready: '#mode-landing:not([hidden]) [role="group"][aria-label="Start something"]',
    },
    { name: 'overview', path: '/overview', ready: '#play:not([hidden]) .playcard' },
    { name: 'queues', path: '/queues', ready: '.shelf' },
    { name: 'people', path: '/people', ready: '#people' },
    { name: 'pending', path: '/pending', ready: '#pending:not([hidden])' },
    { name: 'collection', path: '/collection', ready: '#collection-picker:not([hidden])' },
    { name: 'queue-family', path: '/q/family', ready: '#queue:not([hidden]) li.tile' },
    { name: 'rules-younger', path: '/channels/younger', ready: '#chbody' },
  ]);
  stops.pop()?.();

  // The calendar needs a registry holding every combination of the two date settings, which
  // only its own fixture has. Its dates are literal, so the fixed clock decides what is in
  // season.
  const calendar = await startFixtureServer(CALENDAR_PORT, {
    queues: 'queues.harness.yaml',
    sets: 'calendar.sets.yaml',
  });
  stops.push(() => killServer(calendar.child));
  await shoot(browser, calendar.base, [
    { name: 'calendar', path: '/calendar', ready: '#calendar-rows > li' },
  ]);
  stops.pop()?.();

  const tonight = await startTonightServer(TONIGHT_PORT);
  stops.push(() => stopTonightServer(tonight));
  await shoot(browser, tonight.base, [
    {
      name: 'what-to-watch-play',
      path: '/what-to-watch-play',
      ready: '#tonight:not([hidden]) #tonight-activity [role="radiogroup"]',
    },
  ]);
  stops.pop()?.();

  const boardGames = await startBoardGameServer(BOARD_GAME_PORT);
  stops.push(() => stopBoardGameServer(boardGames));
  await shoot(browser, boardGames.base, [
    {
      name: 'board-games',
      path: '/collection/board-games',
      ready: '#collection:not([hidden]) #collection-grid',
    },
    {
      name: 'result-tidewright',
      path: '/result/tidewright',
      ready: '#result:not([hidden]) #result-card',
    },
  ]);
} finally {
  await browser.close();
  for (const stop of stops) stop();
}
