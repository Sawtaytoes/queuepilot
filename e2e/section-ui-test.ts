// BROWSER CONTRACT FOR THE SECTION EDITOR — the tag, the panel row, the modal and the write.
//
// `start.position_ms` / `end.position_ms` have been stored, served and PLAYED since #302 and
// #304. This pins the part a person touches, and every assertion is one of the four
// optionality states or one of the two ways `null` gets confused with `0`
// (decision `2026-09-01-a-start-point-carries-a-position-and-end-is-its-mirror`).
//
// What it pins:
//
//   1. THE TAG READS DIFFERENTLY IN EACH STATE, and shows nothing when there is no section.
//   2. THE PANEL ROW IS GATED ON THE PROVIDER. A backend that cannot play a section offers no
//      control rather than a disabled one — so the row is ABSENT, not `disabled`.
//   3. THE MODAL CARRIES ALL THREE INPUT ROUTES, and the bar disappears when the runtime is
//      unknown rather than clamping every mark to zero.
//   4. THE WRITE LANDS ON DISK as `position_ms` under `start:` and under `end:`.
//   5. CLEARING IS REACHABLE, and clearing the SECTION does not take the start point with it.
//
// The tiles are SYNTHETIC — this repo is public, so a screenshot and a gate both show invented
// data and never the live library. The PATCHes are real: they `route.continue()` to the server
// this harness spawned, so what lands in the YAML is what the app actually wrote.
//
// Browser, but NO PLEX — like `tile-menu-test`, so it runs on every PR.
//
// Usage: `server/node_modules/.bin/tsx e2e/section-ui-test.ts`  (spawns its own server)
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = parseInt(process.env.WEB_PORT || '18994', 10);
const BASE = `http://localhost:${PORT}`;
const scratch = '/tmp/queuepilot-section-ui';
const queuesPath = `${scratch}/queues.yaml`;
const setsPath = `${scratch}/sets.yaml`;

await fs.rm(scratch, { recursive: true, force: true });
await fs.mkdir(scratch, { recursive: true });
await fs.mkdir(`${ROOT}/__screenshots__`, { recursive: true });
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

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${condition ? '' : ` — ${detail}`}`);
  if (!condition) failures += 1;
}

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

try {
  await waitReady();

  const shelves = await fetch(`${BASE}/api/shelves`).then((r) => r.json()) as {
    sets: Record<string, { items: { key: string }[] }>;
  };
  const keys = (shelves.sets.bob?.items ?? []).map((entry) => entry.key);
  if (keys.length < 5) throw new Error('fixture must have five bob entries');
  const [windowKey, openEndKey, openStartKey, plainKey, unknownKey] = keys as [
    string, string, string, string, string,
  ];

  const queuePayload = await fetch(`${BASE}/api/queues`).then((r) => r.json()) as {
    sets?: Record<string, { items: unknown[] }>;
  };

  // The five states, one entry each. A WINDOW, an open end, an open start, no section at all,
  // and one whose runtime nothing knows — which is the case that would otherwise clamp every
  // typed mark to zero.
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
  const itemFor = (key: string) => items.find((entry) => entry.key === key)!;

  const browser = await chromium.launch();
  const page = await browser.newPage({
    colorScheme: 'dark',
    viewport: { width: 1280, height: 1000 },
  });
  page.on('pageerror', (error) => {
    console.log(`PAGEERROR ${error.message}`);
    failures += 1;
  });

  /** What `/api/providers` reports. Flipped mid-run to prove the capability gate. */
  let isSectionsPlayed = true;
  await page.route('**/api/providers', async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        providers: [{
          base_url: '',
          configured: true,
          delivery: 'push',
          id: 'plex',
          kind: 'plex',
          label: 'Plex',
          plays_sections: isSectionsPlayed,
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
    });
  });

  // The PATCHes go THROUGH to the real server, so the YAML is the record of what the app
  // wrote — and the synthetic copy is updated from the same body, because the faked GET below
  // is what the page re-reads afterwards.
  await page.route('**/api/queues/**', async (route, request) => {
    if (request.method() === 'PATCH') {
      const url = request.url();
      const body = JSON.parse(request.postData() ?? '{}') as {
        end?: { position_ms?: number } | null;
        start?: { position_ms?: number } | null;
      };
      const key = decodeURIComponent(url.split('/items/')[1]?.split('/')[0] ?? '');
      const hit = items.find((entry) => entry.key === key);
      if (hit && url.endsWith('/start')) hit.start = body.start ?? null;
      if (hit && url.endsWith('/end')) hit.end = body.end ?? null;
    }
    await route.continue();
  });

  await page.route('**/api/queues?*', async (route, request) => {
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
  });
  await page.route(`${BASE}/api/queues`, async (route, request) => {
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
  });
  await page.route('**/api/thumb/**', (route) => route.fulfill({ body: '', status: 404 }));

  const openPanel = async (key: string) => {
    await page.locator(`#grid li.tile[data-key=${JSON.stringify(key)}] .editbtn`).click();
    await page.locator('#entrymodal').waitFor({ timeout: 15_000 });
  };
  const closePanel = async () => {
    await page.locator('#entrymodal .modalbtns button').click();
    await page.locator('#entrymodal').waitFor({ state: 'detached', timeout: 15_000 });
  };
  const tagText = async (key: string) => (
    await page.locator(`#grid li.tile[data-key=${JSON.stringify(key)}] .sectiontag`)
      .allInnerTexts()
  ).join('|');

  await page.goto(`${BASE}/q/bob`, { waitUntil: 'domcontentloaded' });
  await page.locator('#grid .tile .cap', { hasText: 'A Reel Sampler' }).first()
    .waitFor({ timeout: 30_000 });
  await page.waitForTimeout(600);

  // ── 1: the tag ──────────────────────────────────────────────────────────────────────────
  check('a WINDOW names both marks', await tagText(windowKey) === 'Section 01:01:00–01:06:00',
    await tagText(windowKey));
  check('an OPEN END says where it begins and nothing else',
    await tagText(openEndKey) === 'Section from 01:15:00', await tagText(openEndKey));
  check('an OPEN START says where it stops and nothing else',
    await tagText(openStartKey) === 'Section to 01:30', await tagText(openStartKey));
  check('an entry with no section wears no tag at all',
    await page.locator(`#grid li.tile[data-key=${JSON.stringify(plainKey)}] .sectiontag`)
      .count() === 0);

  await page.screenshot({ path: `${ROOT}/__screenshots__/section-tags-dark.png` });

  // ── 2: the panel row, and the capability gate ───────────────────────────────────────────
  await openPanel(windowKey);
  check('the entry sheet carries a Section row',
    await page.locator('#entry-sectionfield').count() === 1);
  check('…which summarises the window against the runtime',
    (await page.locator('#entry-sectionsummary').innerText())
      .trim() === '01:01:00 to 01:06:00 of 02:00:00',
    await page.locator('#entry-sectionsummary').innerText());
  check('…and offers the clear right there in the row',
    await page.locator('#entry-sectionclear').count() === 1);
  await page.locator('#entrymodal').screenshot({
    path: `${ROOT}/__screenshots__/section-panel-row.png`,
  });
  await closePanel();

  // ── 3: the modal ────────────────────────────────────────────────────────────────────────
  await openPanel(plainKey);
  await page.locator('#entry-sectionopen').click();
  await page.locator('#sectionmodal').waitFor({ timeout: 15_000 });
  check('the panel closes when the modal opens — never two dialogs over one entry',
    await page.locator('#entrymodal').count() === 0);
  check('the modal offers the TYPED route',
    await page.getByRole('textbox', { name: 'Section start' }).count() === 1);
  check('…the DRAGGED route',
    await page.locator('#section-dragbox [role="slider"]').count() === 2);
  check('…and the CAPTURE route',
    await page.locator('#section-capture-start').count() === 1);
  check('the capture buttons are OFF with nothing playing, and say why',
    (await page.locator('#section-capturenote').innerText()).includes('Nothing is playing'),
    await page.locator('#section-capturenote').innerText());
  await page.locator('#sectionmodal').screenshot({
    path: `${ROOT}/__screenshots__/section-modal-empty.png`,
  });

  // Type a window and save it. `01:00` is a bare minute-and-second pair; the grammar reads the
  // largest field present as unbounded and every smaller one as 0–59.
  await page.getByRole('textbox', { name: 'Section start' }).fill('2:30');
  await page.getByRole('textbox', { name: 'Section start' }).press('Enter');
  await page.getByRole('textbox', { name: 'Section end' }).fill('4:00');
  await page.getByRole('textbox', { name: 'Section end' }).press('Enter');
  await page.waitForTimeout(200);
  check('the typed window is echoed back in full',
    (await page.locator('#section-summary').innerText()).includes('02:30 to 04:00'),
    await page.locator('#section-summary').innerText());
  await page.locator('#sectionmodal').screenshot({
    path: `${ROOT}/__screenshots__/section-modal-typed.png`,
  });
  await page.locator('#section-save').click();
  await page.locator('#sectionmodal').waitFor({ state: 'detached', timeout: 15_000 });
  await page.waitForTimeout(1_200);

  const yaml = await fs.readFile(queuesPath, 'utf8');
  check('the START mark landed on disk', /start:\s*\n?\s*.*position_ms:\s*150000/.test(yaml)
    || yaml.includes('position_ms: 150000'), yaml.slice(0, 400));
  check('the END mark landed on disk', yaml.includes('position_ms: 240000'));
  check('the tile now wears the window it was given',
    await tagText(plainKey) === 'Section 02:30–04:00', await tagText(plainKey));

  // ── 4: a refused value stays exactly as typed ───────────────────────────────────────────
  await openPanel(plainKey);
  await page.locator('#entry-sectionopen').click();
  await page.locator('#sectionmodal').waitFor({ timeout: 15_000 });
  await page.getByRole('textbox', { name: 'Section start' }).fill('1:90');
  await page.getByRole('textbox', { name: 'Section start' }).press('Enter');
  await page.waitForTimeout(200);
  check('an overflow is refused BY NAME rather than carried',
    (await page.locator('#sectionmodal [role="status"]').first().innerText())
      .includes('60 seconds'),
    await page.locator('#sectionmodal [role="status"]').first().innerText());
  check('…and the text stays exactly as typed',
    await page.getByRole('textbox', { name: 'Section start' }).inputValue() === '1:90');
  await page.locator('#sectionmodal').screenshot({
    path: `${ROOT}/__screenshots__/section-modal-refused.png`,
  });
  await page.locator('#section-cancel').click();
  await page.locator('#sectionmodal').waitFor({ state: 'detached', timeout: 15_000 });

  // ── 5: clearing, and what a clear must NOT take with it ─────────────────────────────────
  await openPanel(plainKey);
  await page.locator('#entry-sectionclear').click();
  await page.waitForTimeout(2_000);
  await closePanel();
  await page.waitForTimeout(600);
  check('the section clears back to the whole item',
    await page.locator(
      `#grid li.tile[data-key=${JSON.stringify(plainKey)}] .sectiontag`,
    ).count() === 0,
    `start=${JSON.stringify(itemFor(plainKey).start)} end=${JSON.stringify(itemFor(plainKey).end)}`);
  check('…and the entry is left with no start mapping at all, never an empty one',
    itemFor(plainKey).start === null, JSON.stringify(itemFor(plainKey).start));
  check('…and no end mapping either',
    itemFor(plainKey).end === null, JSON.stringify(itemFor(plainKey).end));

  // ── 6: an unknown runtime drops the bar rather than clamping to zero ────────────────────
  await openPanel(unknownKey);
  await page.locator('#entry-sectionopen').click();
  await page.locator('#sectionmodal').waitFor({ timeout: 15_000 });
  check('no runtime, no bar', await page.locator('#section-dragbox').count() === 0);
  check('…and the modal says why rather than leaving a gap',
    (await page.locator('#section-noduration').innerText()).includes('runtime'),
    await page.locator('#section-noduration').innerText());
  await page.getByRole('textbox', { name: 'Section end' }).fill('1:20:00');
  await page.getByRole('textbox', { name: 'Section end' }).press('Enter');
  await page.waitForTimeout(200);
  check('a mark past an unknown runtime is NOT clamped to zero',
    (await page.locator('#section-summary').innerText()).includes('01:20:00'),
    await page.locator('#section-summary').innerText());
  await page.locator('#sectionmodal').screenshot({
    path: `${ROOT}/__screenshots__/section-modal-noduration.png`,
  });
  await page.locator('#section-cancel').click();
  await page.locator('#sectionmodal').waitFor({ state: 'detached', timeout: 15_000 });

  // ── 7: THE CAPABILITY GATE. No control at all, not a disabled one. ──────────────────────
  isSectionsPlayed = false;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#grid .tile .cap', { hasText: 'A Reel Sampler' }).first()
    .waitFor({ timeout: 30_000 });
  await page.waitForTimeout(800);
  check('a backend that cannot play a section shows no TAG',
    await page.locator('#grid .sectiontag').count() === 0);
  await openPanel(windowKey);
  check('…and no ROW in the entry sheet — absent, never disabled',
    await page.locator('#entry-sectionfield').count() === 0);
  check('…while the entry sheet is otherwise intact',
    await page.locator('#entrymodal .field').count() > 0);
  await page.locator('#entrymodal').screenshot({
    path: `${ROOT}/__screenshots__/section-panel-no-capability.png`,
  });

  await browser.close();
} finally {
  await killServer(server);
  await fs.rm(scratch, { recursive: true, force: true });
}

console.log(failures ? `section-ui FAILED (${failures})` : 'section-ui OK');
process.exit(failures ? 1 : 0);
