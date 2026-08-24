// The Narrow View, seven scenarios, against a STUBBED Plex — the reproducible replacement for
// the ad-hoc live captures that documented PR #119.
//
// Why a stub rather than the real server: the shots #119 needed are of the MODALS, and what
// made those modals overflow was the length of real option labels — library names, profile
// names, pool names. Shooting them against the household's Plex is what put a real person's
// named video library into a public repo. The stub below serves the same SHAPES (a long library name, a
// long pool label) with none of the household in them, so the geometry the shots are about
// still reproduces.
// (decision `2026-08-19-pr-screenshots-are-fixture-data-never-live` in the agentic root repo)
//
// Runs against ANY vintage of the app — it is used to re-shoot a merged PR's before/after — so
// every scenario is independent, selector-tolerant, and reports what it actually got:
//
//   server/node_modules/.bin/tsx e2e/shot-narrow.ts --tag=before
//
// A scenario that finds nothing to click logs SKIP rather than failing the run: "this control
// did not exist at this commit" is a real answer when shooting history.
import type { ChildProcess } from 'node:child_process';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import { chromium, type Page } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const PORT = 18791;
const tagArg = process.argv.find((a) => a.startsWith('--tag='));
const TAG = tagArg ? tagArg.slice('--tag='.length) : 'after';
const NARROW = { width: 390, height: 844 }; // iPhone 14/15 CSS width — the reported viewport

// Library names in the SHAPES that broke the layout: one very long, several ordinary. A
// `<fieldset>`'s UA `min-inline-size: min-content` sized to the longest of these.
const SECTIONS = [
  { key: '1', title: 'Movies', type: 'movie' },
  { key: '5', title: 'Shows', type: 'show' },
  { key: '11', title: 'Anime', type: 'show' },
  { key: '14', title: 'Documentaries and Other Long-Named Things', type: 'movie' },
  { key: '15', title: 'Shorts', type: 'movie' },
  { key: '2', title: 'Demos', type: 'movie' },
];

const plexStub = http.createServer((req, res) => {
  const url = req.url || '';
  res.setHeader('Content-Type', 'application/json');

  if (/\/library\/sections(\?|$)/.test(url))
    return res.end(JSON.stringify({ MediaContainer: { Directory: SECTIONS } }));

  if (/\/library\/sections\/\d+\/collections/.test(url))
    return res.end(JSON.stringify({ MediaContainer: { Metadata: [] } }));

  if (/\/library\/sections\/\d+\/all\?/.test(url))
    return res.end(JSON.stringify({ MediaContainer: { Metadata: [
      { ratingKey: '5001', type: 'movie', title: 'A Fixture Film', year: 2020, thumb: '/t.jpg', duration: 1000 },
    ] } }));

  if (/\/library\/metadata\/\d+\/allLeaves/.test(url))
    return res.end(JSON.stringify({ MediaContainer: { updatedAt: 100, leafCount: 1, viewedLeafCount: 0, Metadata: [
      { ratingKey: '5002', type: 'episode', parentIndex: 1, index: 1, title: 'Ep 1', duration: 1000, viewCount: 0 },
    ] } }));

  res.end(JSON.stringify({ MediaContainer: {} }));
});

await new Promise<void>((r) => plexStub.listen(0, () => r()));

const addr = plexStub.address();

if (addr === null || typeof addr === 'string') throw new Error('the stub Plex did not bind a TCP port');

const env = {
  ...process.env,
  WEB_PORT: String(PORT),
  QUEUES_PATH: '/tmp/queues-shotnarrow.yaml',
  SETS_PATH: '/tmp/sets-shotnarrow.yaml',
  GROUPS_PATH: '/tmp/groups-shotnarrow.yaml',
  HISTORY_PATH: '/tmp/history-shotnarrow.json',
  CACHE_PATH: '/tmp/cache-shotnarrow.sqlite',
  PLEX_API_SERVER_URL: `http://localhost:${addr.port}`,
  PLEX_TOKEN: 'stub',
  MQTT_HOST: '',
  NODE_TLS_REJECT_UNAUTHORIZED: '0',
};

for (const [src, dest] of [
  ['e2e/fixtures/landing.sets.yaml', env.SETS_PATH],
  ['e2e/fixtures/landing.queues.yaml', env.QUEUES_PATH],
  ['e2e/fixtures/landing.groups.yaml', env.GROUPS_PATH],
] as const) {
  await fs.copyFile(src, dest);
  await fs.rm(`${dest}.lock`, { force: true, recursive: true });
}

let server: ChildProcess | undefined;
const browser = await chromium.launch();
const got: string[] = [];
const missed: string[] = [];

/** The landing card, whatever it is called at this commit. */
const ANY_CARD = '.playcard, .playrow';

async function scene(page: Page, name: string, drive: () => Promise<void>) {
  try {
    await drive();
    await page.screenshot({ path: `__screenshots__/narrow-${TAG}-${name}.png` });
    got.push(name);
    console.log(`shot  ${name}`);
  } catch (e) {
    missed.push(name);
    console.log(`SKIP  ${name} — ${(e as Error).message.split('\n')[0]}`);
  }
}

/** Click the first selector that exists, or throw naming all of them. */
async function clickAny(page: Page, selectors: string[]) {
  for (const s of selectors) {
    const el = await page.$(s);

    if (el) {
      await el.click();

      return s;
    }
  }

  throw new Error(`none of these exist: ${selectors.join(' | ')}`);
}

try {
  server = spawnServer({ env, stdio: 'ignore' });

  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`http://localhost:${PORT}/api/sets`).then((r) => r.json());
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // **Device emulation, not merely a narrow window**, and that distinction is the whole
  // subject of the headline shot. Chrome answers an overflowing page by widening the LAYOUT
  // viewport to fit it — so every `position: fixed` overlay then centres itself on 485 instead
  // of 390 and renders off the right edge of the screen. A desktop-shaped Chromium at a narrow
  // viewport scrolls sideways instead and the modal stays put, which is exactly how
  // `narrow-scroll-test` passed while all of this was live.
  const ctx = await browser.newContext({
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    viewport: NARROW,
  });

  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('charcuterie-scheme', 'dark');
    } catch {
      /* the shot is light then, and says so */
    }
  });

  const page = await ctx.newPage();
  const base = `http://localhost:${PORT}`;

  await scene(page, '1-landing', async () => {
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(ANY_CARD, { timeout: 30000 });
    await page.waitForTimeout(1500);
  });

  await scene(page, '2-configure-pool', async () => {
    await page.goto(`${base}/channels`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#chbody, #chfilters', { timeout: 30000 });
    await page.waitForTimeout(1200);
    await clickAny(page, ['#chconfigure', '#chedit', '[data-testid="chconfigure"]']);
    await page.waitForTimeout(1200);
  });

  await scene(page, '3-queue-add-bar', async () => {
    await page.goto(`${base}/q/bob`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#queue:not([hidden]) .add', { timeout: 30000 });
    await page.waitForTimeout(1500);
  });

  await scene(page, '4-entry-sheet', async () => {
    await page.goto(`${base}/q/bob`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#queue:not([hidden]) .tile', { timeout: 30000 });
    await page.waitForTimeout(1200);
    // The poster tap. Before #119 it did nothing — that is the point of the pair, so the shot
    // is taken either way and the BEFORE simply shows the grid it left alone.
    await page.locator('#queue:not([hidden]) .tile .thumb, #queue:not([hidden]) .tile').first().click();
    await page.waitForTimeout(1200);
  });

  await scene(page, '5-new-queue-modal', async () => {
    await page.goto(`${base}/queues`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#newqueue, .shelf', { timeout: 30000 });
    await page.waitForTimeout(1200);
    await clickAny(page, ['#newqueue', '#addqueue']);
    await page.waitForTimeout(1200);
  });

  await scene(page, '6-new-pool-modal', async () => {
    await page.goto(`${base}/channels`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#chbody, #chfilters', { timeout: 30000 });
    await page.waitForTimeout(1200);
    await clickAny(page, ['#newchannel', '#newdyn', '#addchannel']);
    await page.waitForTimeout(1200);
  });

  // The filters panel's horizontal scrollbar was at EVERY width, desktop included — so this
  // one is deliberately not narrow.
  await scene(page, '7-pool-filters-1280', async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${base}/channels/younger`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#chfilters', { timeout: 30000 });
    await page.waitForTimeout(1500);
  });

  console.log(`\n${TAG}: ${got.length} shot, ${missed.length} skipped${missed.length ? ` (${missed.join(', ')})` : ''}`);
} finally {
  await browser.close();
  if (server) killServer(server);
  plexStub.close();
}
