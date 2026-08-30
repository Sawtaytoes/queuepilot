// Browser contract for the Picks entry editor's inner Shuffle setting.
// Synthetic tile data keeps this public-repo screenshot and gate free of household data.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = parseInt(process.env.WEB_PORT || '18993', 10);
const BASE = `http://localhost:${PORT}`;
const scratch = '/tmp/queuepilot-per-entry-shuffle-ui';
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
    QUEUES_PATH: queuesPath,
    SETS_PATH: setsPath,
    STORE_PATH: `${scratch}/queuepilot.sqlite`,
    WEB_PORT: String(PORT),
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
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

try {
  await waitReady();
  const shelves = await fetch(`${BASE}/api/shelves`).then((response) => response.json()) as {
    sets: Record<string, { items: { key: string }[] }>;
  };
  const key = shelves.sets.bob_anime?.items[0]?.key;
  if (!key) throw new Error('fixture must have a bob_anime entry');

  const queuePayload = await fetch(`${BASE}/api/queues`).then((response) => response.json()) as {
    sets?: Record<string, { items: unknown[] }>;
  };

  const synthetic = {
    key,
    raw: 'Example Show',
    resolved: true,
    ratingKey: '900002',
    type: 'show',
    title: 'Example Show',
    year: 2020,
    childCount: 72,
    nextEp: {
      ratingKey: '900003',
      season: 1,
      episode: 1,
      title: 'A Beginning',
      multiSeason: true,
      duration: 1_200_000,
    },
    isNextEpFailed: false,
    partiallyWatched: false,
    viewOffset: 0,
    duration: 1_200_000,
    editionTitle: null,
    start: null,
    done: false,
    isFinished: false,
    isRevived: false,
    episodes: null,
    item_order: null as 'shuffle' | null,
    volumes: null,
    weight: 1,
    batch_stops_at: null,
    placement: null,
    lead: null,
    promote_window: null,
  };

  const browser = await chromium.launch();
  const page = await browser.newPage({
    colorScheme: 'dark',
    viewport: { width: 1280, height: 1000 },
  });
  page.on('pageerror', (error) => {
    console.log(`PAGEERROR ${error.message}`);
    failures += 1;
  });

  await page.route('**/api/queues*', async (route, request) => {
    if (request.method() !== 'GET') {
      if (request.method() === 'PATCH' && request.url().endsWith('/item-order')) {
        const body = JSON.parse(request.postData() ?? '{}') as { item_order?: unknown };
        synthetic.item_order = body.item_order === 'shuffle' ? 'shuffle' : null;
      }
      await route.continue();
      return;
    }
    if (queuePayload.sets?.bob_anime) {
      queuePayload.sets.bob_anime.items = [{ ...synthetic }];
    }
    await route.fulfill({
      body: JSON.stringify(queuePayload),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.route('**/api/thumb/**', (route) => route.fulfill({ body: '', status: 404 }));

  await page.goto(`${BASE}/q/bob_anime`, { waitUntil: 'domcontentloaded' });
  try {
    await page.locator('#grid .tile .cap', { hasText: 'Example Show' }).first()
      .waitFor({ timeout: 30_000 });
  } catch (error) {
    console.log(`BODY ${await page.locator('body').innerText()}`);
    throw error;
  }
  await page.locator('#grid .tile .editbtn').first().click();
  const modal = page.locator('#entrymodal');
  await modal.waitFor({ timeout: 15_000 });

  const orderField = modal.locator('.field', { hasText: 'Episode order' });
  const orderTrigger = orderField.locator(
    '[role="combobox"], [aria-haspopup="listbox"]',
  ).first();
  check('a show entry exposes Episode order', await orderField.count() === 1);
  check(
    'the default is next-unwatched, in order',
    /In order/.test(await orderTrigger.innerText()),
  );

  await orderTrigger.click();
  await page.getByRole('option', { name: 'Shuffle — any item' }).click();
  await page.locator('#status', { hasText: 'Saved' }).waitFor({ timeout: 15_000 });

  check(
    'the picker changes to Shuffle',
    /Shuffle/.test(await orderTrigger.innerText()),
  );
  check(
    'the tile names the inner mode with a Shuffle tag',
    await page.locator('#grid .tile .shuffletag').count() === 1,
  );
  check(
    'the tile no longer claims a specific next episode',
    (await page.locator('#grid .tile .next').first().textContent())?.trim() === 'Any episode',
  );
  check(
    'the API write persisted item_order: shuffle',
    /item_order:\s*shuffle/.test(await fs.readFile(queuesPath, 'utf8')),
  );

  await modal.screenshot({ path: `${ROOT}/__screenshots__/per-entry-shuffle-panel.png` });
  await page.unroute('**/api/queues*');
  await browser.close();
} finally {
  await killServer(server);
  await fs.rm(scratch, { recursive: true, force: true });
}

console.log(failures ? `per-entry-shuffle-ui FAILED (${failures})` : 'per-entry-shuffle-ui OK');
process.exit(failures ? 1 : 0);
