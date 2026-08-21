// Before/after shot of the PENDING list, against a stub Plex.
//
// The change is server logic, so the honest evidence is the LIST: the same fixture library,
// the same six arrivals, rendered through the real `/api/pending`. Two rows must leave, one
// per symptom — the film a bare-title queue entry already names, and the items already
// watched. `e2e/shot-addto-menus.ts` stubs `/api/pending` in the BROWSER, which would prove
// nothing here: the whole change is what that endpoint computes.
//
// Every byte on screen is fixture data (see `stubs/plex-pending-coverage.mjs`); the repo is
// public and a live capture would commit the owner's library into a PNG.
//
// Usage: `server/node_modules/.bin/tsx e2e/shot-pending-coverage.ts [before|after]`
// Writes `__screenshots__/pending-coverage-<stage>.png`.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';
import {
  PENDING_YAML, QUEUES_YAML, SETS_YAML, startStubPlex,
} from './stubs/plex-pending-coverage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = process.argv[2] === 'after' ? 'after' : 'before';
const PORT = parseInt(process.env.WEB_PORT || '18894', 10);
const PLEX_PORT = parseInt(process.env.STUB_PLEX_PORT || '18895', 10);
const BASE = `http://localhost:${PORT}`;
const OUT = `${ROOT}/__screenshots__`;

const waitReady = async (url: string, ms = 30000) => {
  const end = Date.now() + ms;
  for (;;) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`not ready: ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
};

await fs.mkdir(OUT, { recursive: true });
await fs.writeFile('/tmp/queues-pcov.yaml', QUEUES_YAML);
await fs.writeFile('/tmp/sets-pcov.yaml', SETS_YAML);
await fs.writeFile('/tmp/pending-pcov.yaml', PENDING_YAML);
for (const p of ['/tmp/queues-pcov.yaml.lock', '/tmp/sets-pcov.yaml.lock', '/tmp/cache-pcov.sqlite']) {
  await fs.rm(p, { recursive: true, force: true });
}

const plex = startStubPlex(PLEX_PORT);
await plex.ready;

const srv = spawnServer({
  env: {
    ...process.env,
    PLEX_API_SERVER_URL: `http://127.0.0.1:${PLEX_PORT}`,
    PLEX_TOKEN: 'stub',
    QUEUES_PATH: '/tmp/queues-pcov.yaml',
    SETS_PATH: '/tmp/sets-pcov.yaml',
    PENDING_PATH: '/tmp/pending-pcov.yaml',
    HISTORY_PATH: '/tmp/.history-pcov.json',
    CACHE_PATH: '/tmp/cache-pcov.sqlite',
    ADB_ENABLED: 'false',
    WEB_PORT: String(PORT),
    MQTT_HOST: '',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

try {
  await waitReady(`${BASE}/api/shelves`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1300, height: 760 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  // No poster fetches: the stub serves no artwork and a pending thumb request would just
  // stall the shot. The tiles render their placeholder, identically in both stages.
  await page.route('**/api/thumb/**', (route) => route.fulfill({ status: 404, body: '' }));

  await page.goto(`${BASE}/pending`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#pending:not([hidden])', { timeout: 30000 });
  await page.waitForFunction(
    () => !document.querySelector('#pending [role="status"]'),
    undefined,
    { timeout: 60000 },
  ).catch(() => {});
  await page.waitForTimeout(800);

  const titles = await page.$$eval('#pendinggrid li .ptitle', (els) =>
    els.map((e) => (e.textContent || '').trim()));
  console.log(`${STAGE}: ${titles.length} tiles`, titles);

  await page.screenshot({ path: `${OUT}/pending-coverage-${STAGE}.png` });
  console.log(`shot: ${OUT}/pending-coverage-${STAGE}.png`);
  await browser.close();
} finally {
  killServer(srv);
  await plex.close();
}

process.exit(0);
