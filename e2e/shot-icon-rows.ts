// Before/after shots for the icon-row pass — the controls that painted a transparent
// glyph button by hand, plus the search row's Add-to.
//
//   shelfhead  — a shelf heading, HOVERED, so its four controls are revealed
//   groupmove  — the Groups editor's ▲ / ▼ reorder pair (the ELEMENT selector that died)
//   countback  — the count picker in Custom mode, beside its back-to-presets control
//   resultsadd — a header search result row and its Add-to trigger
//
// EVERY byte on screen is FIXTURE data: queues and labels come from
// `e2e/fixtures/*.yaml`, which are synthetic, and Plex is unroutable here. The repo is
// public and a PNG is opaque to every grep.
// (decision `2026-08-19-pr-screenshots-are-fixture-data-never-live` in the agentic root repo)
//
// Runs against ANY vintage of the app — it shoots both sides of the change — so a frame
// whose control is missing logs SKIP rather than failing the run.
//
// Usage: `server/node_modules/.bin/tsx e2e/shot-icon-rows.ts [before|after]`
// Writes `__screenshots__/iconrow-<slug>-<stage>.png`.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = process.argv[2] === 'after' ? 'after' : 'before';
const PORT = parseInt(process.env.WEB_PORT || '18905', 10);
const BASE = `http://localhost:${PORT}`;
const OUT = `${ROOT}/__screenshots__`;

const waitReady = async (url: string, ms = 30000) => {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > end) throw new Error(`not ready: ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
};

await fs.mkdir(OUT, { recursive: true });
await fs.copyFile(`${ROOT}/e2e/fixtures/queues.harness.yaml`, '/tmp/queues-iconrow.yaml');
await fs.copyFile(`${ROOT}/e2e/fixtures/sets.fixture.yaml`, '/tmp/sets-iconrow.yaml');
// The Groups editor only has a trigger when groups exist — `GroupBar` renders nothing
// otherwise, which is why the borrowed-class audit has never reached that modal either.
await fs.copyFile(`${ROOT}/e2e/fixtures/landing.groups.yaml`, '/tmp/groups-iconrow.yaml');
for (const lock of ['/tmp/queues-iconrow.yaml.lock', '/tmp/sets-iconrow.yaml.lock', '/tmp/groups-iconrow.yaml.lock']) {
  await fs.rm(lock, { force: true });
}

const srv = spawnServer({
  env: {
    ...process.env,
    GROUPS_PATH: '/tmp/groups-iconrow.yaml',
    HISTORY_PATH: '/tmp/.history-iconrow.json',
    MQTT_HOST: '',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    QUEUES_PATH: '/tmp/queues-iconrow.yaml',
    SETS_PATH: '/tmp/sets-iconrow.yaml',
    WEB_PORT: String(PORT),
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});

try {
  await waitReady(`${BASE}/api/queues`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.route('**/api/thumb/**', (route) => route.fulfill({ body: '', status: 404 }));
  // Plex is unroutable here, so the two things that need it are fulfilled from constants:
  // the header search, and one RESOLVED entry (the entry sheet's fields only render for a
  // resolved item). Invented, never captured — the repo is public.
  await page.route('**/api/search*', (route) =>
    route.fulfill({
      body: JSON.stringify({ results: [
        { hasThumb: false, ratingKey: 's1', sectionId: 1, title: 'Metropolis', type: 'movie', year: 1927 },
        { hasThumb: false, ratingKey: 's2', sectionId: 1, title: 'The Kid', type: 'movie', year: 1921 },
      ] }),
      contentType: 'application/json',
    }));
  await page.route('**/api/queues*', async (route) => {
    const res = await route.fetch();
    const json = (await res.json()) as { sets?: Record<string, { items: unknown[] }> };
    const target = json.sets?.bob_anime;
    if (target) {
      target.items = [{
        batch_stops_at: null, childCount: 12, done: false, duration: 0, editionTitle: null,
        episodes: 1, isNextEpFailed: false, key: 'title:A Synthetic Show', nextEp: null,
        partiallyWatched: false, raw: 'A Synthetic Show', ratingKey: '900001', resolved: true,
        start: null, title: 'A Synthetic Show', type: 'show', viewOffset: 0, year: 2020,
      }];
    }
    await route.fulfill({ body: JSON.stringify(json), contentType: 'application/json' });
  });

  const shot = async (slug: string, selector: string) => {
    const target = page.locator(selector).first();
    if (!(await page.locator(selector).count())) {
      console.log(`SKIPPED ${slug} — no ${selector} at this commit`);
      return;
    }
    const box = await target.boundingBox();
    await target.screenshot({ path: `${OUT}/iconrow-${slug}-${STAGE}.png` });
    console.log(`shot: iconrow-${slug}-${STAGE}  ${box ? `${Math.round(box.width)}x${Math.round(box.height)}` : '?'}`);
  };

  // 1 — a shelf heading. The four controls are `opacity: 0` until the `h2` is hovered, so
  // the hover IS the frame: shooting it cold would photograph an empty row on both sides.
  await page.goto(`${BASE}/queues`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.shelf h2', { timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.locator('.shelf h2').first().hover();
  await page.waitForTimeout(500);
  await shot('shelfhead', '.shelf h2');

  // 2 — the Groups editor's reorder pair. `GroupBar` mounts on the PLAY landing only.
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#heading', { timeout: 30000 });
  await page.waitForTimeout(1800);
  if (await page.locator('#groupsedit').count()) {
    await page.click('#groupsedit');
    await page.waitForSelector('#groupsmodal', { timeout: 15000 });
    await page.waitForTimeout(900);
    await shot('groupmove', '.grouplist li');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  } else {
    console.log('SKIPPED groupmove — no #groupsedit (no groups in this fixture)');
  }

  // 3 — the search row's Add-to trigger, in the header's own results list.
  await page.goto(`${BASE}/queues`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#gsearch', { timeout: 30000 });
  await page.waitForTimeout(1200);
  // Two characters minimum, then a debounce — `SearchDropdown` returns early below that.
  await page.fill('#gsearch', 'met');
  await page.waitForTimeout(3000);
  if (await page.locator('#gresults li').count()) {
    await shot('resultsadd', '#gresults li');
  } else {
    console.log('SKIPPED resultsadd — search returned no rows (Plex is unroutable)');
  }

  // 4 — the count picker, in the entry sheet, switched to Custom where the
  // back-to-presets control lives.
  await page.goto(`${BASE}/q/bob_anime`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#grid .tile', { timeout: 30000 });
  await page.waitForTimeout(1800);
  const editChip = page.locator('#grid .tile .editbtn').first();
  if (await editChip.count()) {
    await editChip.click();
    await page.waitForSelector('#entrymodal', { timeout: 15000 });
    await page.waitForTimeout(900);
    // `.countpick` exists only in CUSTOM mode — the preset state is a `SelectListbox`, and
    // the back-to-presets control is what leaves it. So the frame has to be driven there.
    const trigger = page.locator('#entrymodal [role="combobox"], #entrymodal [aria-haspopup="listbox"]').first();
    try {
      await trigger.click();
      await page.waitForTimeout(500);
      await page.getByRole('option', { name: /custom/i }).first().click();
      await page.waitForTimeout(800);
    } catch {
      console.log('note: could not reach Custom… through the picker');
    }
    await shot('countback', '.countpick');
  } else {
    console.log('SKIPPED countback — no resolved entry to open the sheet on');
  }

  await browser.close();
} finally {
  killServer(srv);
}
