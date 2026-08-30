// The Pending Dismiss control removes one item immediately and keeps it absent after reload.
//
// This is a browser gate because `pending-test.ts` pins the server subtraction but cannot see
// the view's local list. The two halves can therefore each pass while the pressed card stays
// on screen.
import { promises as fs } from 'node:fs';
import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';
import {
  PENDING_YAML, QUEUES_YAML, SETS_YAML, startStubPlex,
} from './stubs/plex-pending-libraries.mjs';

const PORT = Number(process.env.WEB_PORT ?? 18908);
const PLEX_PORT = Number(process.env.STUB_PLEX_PORT ?? 18909);
const BASE = `http://localhost:${PORT}`;
const TMP = '/tmp/queuepilot-pending-dismiss';

const waitReady = async (url: string, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // The fixture server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`not ready: ${url}`);
};

await fs.mkdir(TMP, { recursive: true });
await fs.writeFile(`${TMP}/queues.yaml`, QUEUES_YAML);
await fs.writeFile(`${TMP}/sets.yaml`, SETS_YAML);
await fs.writeFile(`${TMP}/pending.yaml`, PENDING_YAML);
await fs.rm(`${TMP}/cache.sqlite`, { force: true });
await fs.rm(`${TMP}/queuepilot.sqlite`, { force: true });

const plex = startStubPlex(PLEX_PORT);
await plex.ready;

const server = spawnServer({
  env: {
    ...process.env,
    ADB_ENABLED: 'false',
    CACHE_PATH: `${TMP}/cache.sqlite`,
    MQTT_HOST: '',
    PENDING_PATH: `${TMP}/pending.yaml`,
    PLEX_API_SERVER_URL: `http://127.0.0.1:${PLEX_PORT}`,
    PLEX_TOKEN: 'stub',
    QUEUES_PATH: `${TMP}/queues.yaml`,
    SETS_PATH: `${TMP}/sets.yaml`,
    STORE_BACKEND: 'yaml',
    STORE_PATH: `${TMP}/queuepilot.sqlite`,
    WEB_PORT: String(PORT),
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

try {
  await waitReady(`${BASE}/api/pending`);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const before = await fetch(`${BASE}/api/pending`).then((response) => response.json()) as {
    items: Array<{ ratingKey: string; title: string }>;
  };
  const dismissedKey = before.items[0]?.ratingKey;
  if (!dismissedKey) throw new Error('fixture has no Pending item');

  await page.goto(`${BASE}/pending`, { waitUntil: 'domcontentloaded' });
  const firstCard = page.locator('#pendinggrid li').first();
  await firstCard.waitFor({ state: 'visible', timeout: 30_000 });
  const title = (await firstCard.locator('.ptitle').innerText()).trim();
  const cardElement = await firstCard.elementHandle();
  if (!cardElement) throw new Error('fixture Pending card has no element');
  await firstCard.locator('[data-testid="pending-dismiss"]').click();
  await page
    .getByText(`Removed “${title.replace(/\s+\d{4}$/, '')}” from Pending`)
    .waitFor({ timeout: 15_000 });
  if (await cardElement.evaluate((element) => element.isConnected)) {
    throw new Error('Dismissed Pending card stayed visible');
  }

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#pendinggrid li').first().waitFor({ state: 'visible', timeout: 30_000 });
  const after = await fetch(`${BASE}/api/pending`).then((response) => response.json()) as {
    items: Array<{ ratingKey: string }>;
  };
  if (after.items.some((item) => item.ratingKey === dismissedKey)) {
    throw new Error('Dismissed Pending card returned after reload');
  }

  await browser.close();
  console.log('pending-dismiss-test: 2/2 passed');
} finally {
  await killServer(server);
  await plex.close();
  await fs.rm(TMP, { force: true, recursive: true });
}
