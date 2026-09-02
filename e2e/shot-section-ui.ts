// SHOTS of the section editor in the states the gate does not drive.
//
// `section-ui-test.ts` already captures the tag, the panel row and the modal empty, typed,
// refused, without a runtime, and with the capability withdrawn. This covers the rest of what
// a person can do to it: the DRAGGED bar, a mark CAPTURED from the player, the "Add another"
// door, both colour schemes, and the Narrow View.
//
//   server/node_modules/.bin/tsx e2e/shot-section-ui.ts
//
// Same synthetic library as the gate. This repo is public, so every title here is invented and
// no shot may ever show a real library
// (decision `2026-08-19-pr-screenshots-are-fixture-data-and-pinned-to-the-merge`).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type Page } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = parseInt(process.env.WEB_PORT || '18993', 10);
const BASE = `http://localhost:${PORT}`;
const OUT = `${ROOT}/__screenshots__`;
const scratch = '/tmp/queuepilot-shot-section-ui';
const queuesPath = `${scratch}/queues.yaml`;
const setsPath = `${scratch}/sets.yaml`;

const WIDE = { width: 1280, height: 1000 };
const NARROW = { width: 390, height: 844 }; // The reported CSS width of a modern phone.

await fs.rm(scratch, { recursive: true, force: true });
await fs.mkdir(scratch, { recursive: true });
await fs.mkdir(OUT, { recursive: true });
await fs.copyFile(`${ROOT}/e2e/fixtures/queues.harness.yaml`, queuesPath);
await fs.copyFile(`${ROOT}/e2e/fixtures/sets.fixture.yaml`, setsPath);

const server = spawnServer({
  env: {
    ...process.env,
    CACHE_PATH: `${scratch}/cache.sqlite`,
    HISTORY_PATH: `${scratch}/.history.json`,
    MQTT_HOST: '',
    PLEX_TOKEN: '',
    QUEUES_PATH: queuesPath,
    SETS_PATH: setsPath,
    STORE_PATH: `${scratch}/queuepilot.sqlite`,
    WEB_PORT: String(PORT),
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});

async function waitReady(): Promise<void> {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    try {
      if ((await fetch(`${BASE}/api/shelves`)).ok) return;
    } catch {
      // Still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('QueuePilot did not start');
}

/** One invented film, resolved, with a runtime the modal can bound its fields by. */
const film = (
  key: string,
  ratingKey: string,
  title: string,
  duration: number,
  start: null | Record<string, number>,
  end: null | Record<string, number>,
) => ({
  batch_stops_at: null,
  done: false,
  duration,
  end,
  episodes: null,
  isFinished: false,
  isRevived: false,
  item_order: null,
  key,
  lead: null,
  nextEp: null,
  placement: null,
  promote_window: null,
  ratingKey,
  raw: title,
  resolved: true,
  start,
  title,
  type: 'movie',
  volumes: null,
  weight: 1,
  year: 2019,
});

let wrote = 0;
const shot = async (page: Page, name: string, selector?: string) => {
  const file = `${OUT}/${name}.png`;
  if (selector) await page.locator(selector).screenshot({ path: file });
  else await page.screenshot({ path: file });
  wrote += 1;
  console.log('wrote', file);
};

try {
  await waitReady();

  // Keyed `rk:<ratingKey>` — the identity `keyOfHit` derives — so the search box can
  // recognise its own hit as already queued. That refusal is the whole point of scenario 3:
  // "Add another" is the door in it.
  const [windowKey, openEndKey, openStartKey, plainKey, unknownKey] = [
    'rk:900101', 'rk:900102', 'rk:900103', 'rk:900104', 'rk:900105',
  ];

  const queuePayload = (await fetch(`${BASE}/api/queues`).then((r) => r.json())) as {
    sets?: Record<string, { items: unknown[] }>;
  };

  const items = [
    film(windowKey, '900101', 'A Reel Sampler', 7_200_000,
      { position_ms: 3_660_000 }, { position_ms: 3_960_000 }),
    film(openEndKey, '900102', 'An Open Ending', 5_400_000,
      { position_ms: 4_500_000 }, null),
    film(openStartKey, '900103', 'A Cold Open', 1_440_000,
      null, { position_ms: 90_000 }),
    film(plainKey, '900104', 'The Whole Feature', 6_000_000, null, null),
    film(unknownKey, '900105', 'A Runtime Nobody Knows', 0, null, null),
  ];

  /** What `/api/now` reports. Off until the capture scenario turns it on. */
  let playing: null | { position: number; ratingKey: string; title: string } = null;

  const browser = await chromium.launch();

  /**
   * One page per scenario, because the scheme is fixed at context creation and the Narrow
   * View is a different viewport. Every route stub is re-attached per context.
   */
  const openPage = async (scheme: 'dark' | 'light', viewport: typeof WIDE) => {
    const context = await browser.newContext({ colorScheme: scheme, viewport });
    await context.addInitScript((value) => {
      try {
        localStorage.setItem('charcuterie-scheme', value as string);
      } catch {
        // A private-mode browser has no store; the colorScheme flag still applies.
      }
    }, scheme);
    const page = await context.newPage();

    await page.route('**/api/providers', (route) =>
      route.fulfill({
        body: JSON.stringify({
          providers: [{
            base_url: '',
            configured: true,
            delivery: 'push',
            id: 'plex',
            kind: 'plex',
            label: 'Plex',
            plays_sections: true,
            supported: true,
            vocabulary: {
              done: 'watched',
              member: 'show',
              name: 'Plex',
              startIcon: '▶',
              unit: 'episode',
              unitShort: 'eps',
              units: 'episodes',
              verb: 'Play',
            },
          }],
        }),
        contentType: 'application/json',
        status: 200,
      }));

    await page.route('**/api/now', (route) =>
      route.fulfill({
        body: JSON.stringify({
          now: playing
            ? {
              duration: 7_200,
              position: playing.position,
              positionAt: Math.floor(Date.now() / 1_000),
              ratingKey: playing.ratingKey,
              state: 'playing',
              title: playing.title,
            }
            : null,
          set: playing ? 'bob' : null,
        }),
        contentType: 'application/json',
        status: 200,
      }));

    // A queued hit, so the "Add another" door is the one thing this row offers.
    await page.route('**/api/search*', (route) =>
      route.fulfill({
        body: JSON.stringify({
          results: [{
            hasThumb: false,
            ratingKey: '900101',
            sectionId: 1,
            title: 'A Reel Sampler',
            type: 'movie',
            year: 2019,
          }],
        }),
        contentType: 'application/json',
        status: 200,
      }));

    const serveQueues = async (route: Parameters<Parameters<Page['route']>[1]>[0],
      request: { method: () => string }) => {
      if (request.method() !== 'GET') {
        await route.continue();
        return;
      }
      if (queuePayload.sets?.bob) queuePayload.sets.bob.items = items.map((i) => ({ ...i }));
      await route.fulfill({
        body: JSON.stringify(queuePayload),
        contentType: 'application/json',
        status: 200,
      });
    };

    await page.route('**/api/queues?*', serveQueues);
    await page.route(`${BASE}/api/queues`, serveQueues);
    await page.route('**/api/thumb/**', (route) => route.fulfill({ body: '', status: 404 }));

    await page.goto(`${BASE}/q/bob`, { waitUntil: 'domcontentloaded' });
    await page.locator('#grid .tile .cap', { hasText: 'A Reel Sampler' }).first()
      .waitFor({ timeout: 30_000 });
    await page.waitForTimeout(700);

    // `Page` in this repo's hand-written Playwright slice has no `context()`, so the caller
    // gets the context back and closes that — closing the page alone would leak the context.
    return { context, page };
  };

  const openModal = async (page: Page, key: string) => {
    await page.locator(`#grid li.tile[data-key=${JSON.stringify(key)}] .editbtn`).click();
    await page.locator('#entrymodal').waitFor({ timeout: 15_000 });
    await page.locator('#entry-sectionopen').click();
    await page.locator('#sectionmodal').waitFor({ timeout: 15_000 });
    await page.waitForTimeout(400);
  };

  // ── 1. THE DRAGGED BAR ─────────────────────────────────────────────────────────────────
  // A real pointer drag, not a seeded value: `onChange` paints each movement and
  // `onChangeEnd` is what the modal reads, so a set value would prove neither.
  {
    const { context, page } = await openPage('dark', WIDE);
    await openModal(page, plainKey);

    const bar = (await page.locator('#section-dragbox').boundingBox())!;
    const thumbs = page.locator('#section-dragbox [role="slider"]');
    const dragTo = async (index: number, fraction: number) => {
      const thumb = (await thumbs.nth(index).boundingBox())!;
      await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
      await page.mouse.down();
      await page.mouse.move(bar.x + bar.width * fraction, thumb.y + thumb.height / 2,
        { steps: 24 });
      await page.mouse.up();
      await page.waitForTimeout(300);
    };

    await dragTo(0, 0.25);
    await dragTo(1, 0.7);
    console.log('dragged to', (await page.locator('#section-summary').innerText()).trim());
    await shot(page, 'section-modal-dragged', '#sectionmodal');
    await context.close();
  }

  // ── 2. CAPTURED FROM THE PLAYER ────────────────────────────────────────────────────────
  // The buttons are live only while THIS entry is what is on screen, so the shot has to be
  // taken with something playing — the state the note under them otherwise explains away.
  {
    playing = { position: 2_730, ratingKey: '900101', title: 'A Reel Sampler' };
    const { context, page } = await openPage('dark', WIDE);
    await openModal(page, windowKey);
    await page.locator('#section-capture-start').click();
    await page.waitForTimeout(400);
    console.log('captured', (await page.locator('#section-capturenote').innerText()).trim());
    await shot(page, 'section-modal-captured', '#sectionmodal');
    await context.close();
    playing = null;
  }

  // ── 3. THE DUPLICATE DOOR ──────────────────────────────────────────────────────────────
  // "In this queue" is the right refusal for the ordinary case. A second SECTION of one film
  // is the case where a second line is the point, so the refusal keeps a door in it.
  {
    const { context, page } = await openPage('dark', WIDE);
    await page.locator('#search').fill('Reel');
    await page.locator('.addanother').first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(400);
    await shot(page, 'section-add-another-row');

    await page.locator('.addanother').first().click();
    await page.locator('#entrymodal').waitFor({ timeout: 15_000 });
    await page.waitForTimeout(600);
    console.log('second line opened onto',
      (await page.locator('#entrymodal').innerText()).split('\n')[0]);
    await shot(page, 'section-add-another-panel', '#entrymodal');
    await context.close();
  }

  // ── 4. THE LIGHT SCHEME ────────────────────────────────────────────────────────────────
  {
    const { context, page } = await openPage('light', WIDE);
    await shot(page, 'section-tags-light');
    await page.locator(`#grid li.tile[data-key=${JSON.stringify(windowKey)}] .editbtn`).click();
    await page.locator('#entrymodal').waitFor({ timeout: 15_000 });
    await page.waitForTimeout(300);
    await shot(page, 'section-panel-row-light', '#entrymodal');
    await page.locator('#entry-sectionopen').click();
    await page.locator('#sectionmodal').waitFor({ timeout: 15_000 });
    await page.waitForTimeout(400);
    await shot(page, 'section-modal-light', '#sectionmodal');
    await context.close();
  }

  // ── 5. THE NARROW VIEW ─────────────────────────────────────────────────────────────────
  // Named for the WIDTH, which is what the media query actually asks about.
  {
    const { context, page } = await openPage('dark', NARROW);
    // The add box and the filters own the top of a narrow page, so the tiles — and the tags
    // this shot is about — start below the fold.
    await page.locator('#grid li.tile').first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await shot(page, 'section-tags-narrow');
    await openModal(page, windowKey);
    await shot(page, 'section-modal-narrow');
    await context.close();
  }

  await browser.close();
} finally {
  await killServer(server);
  await fs.rm(scratch, { recursive: true, force: true });
}

console.log(`shot-section-ui wrote ${wrote} screenshots`);
