// Before/after shot of the PENDING screen: the library include list, and the windowed grid.
//
// Both halves of the change are in one frame, against a stub Plex. Every byte on screen is
// fixture data (see `stubs/plex-pending-libraries.mjs`); the repo is public and a live
// capture would commit the owner's library into a PNG that no grep will ever find again
// (decision `2026-08-19-pr-screenshots-are-fixture-data-and-pinned-to-the-merge`).
//
// `before` is meant to be run from a checkout of the branch point — this file and its stub
// are the only two things copied in, so the SERVER and the VIEW under it are the old ones.
// That is the honest pairing: the same fixture through both versions of the code.
//
// Usage: `server/node_modules/.bin/tsx e2e/shot-pending-libraries.ts [before|after]`
// Writes `__screenshots__/pending-libraries-<stage>.png`.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';
import {
  PENDING_YAML, QUEUES_YAML, SETS_YAML, startStubPlex,
} from './stubs/plex-pending-libraries.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = process.argv[2] === 'after' ? 'after' : 'before';
const PORT = parseInt(process.env.WEB_PORT || '18896', 10);
const PLEX_PORT = parseInt(process.env.STUB_PLEX_PORT || '18897', 10);
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
await fs.writeFile('/tmp/queues-plib.yaml', QUEUES_YAML);
await fs.writeFile('/tmp/sets-plib.yaml', SETS_YAML);
await fs.writeFile('/tmp/pending-plib.yaml', PENDING_YAML);
for (const p of ['/tmp/queues-plib.yaml.lock', '/tmp/sets-plib.yaml.lock', '/tmp/cache-plib.sqlite']) {
  await fs.rm(p, { recursive: true, force: true });
}

const plex = startStubPlex(PLEX_PORT);
await plex.ready;

const srv = spawnServer({
  env: {
    ...process.env,
    PLEX_API_SERVER_URL: `http://127.0.0.1:${PLEX_PORT}`,
    PLEX_TOKEN: 'stub',
    QUEUES_PATH: '/tmp/queues-plib.yaml',
    SETS_PATH: '/tmp/sets-plib.yaml',
    PENDING_PATH: '/tmp/pending-plib.yaml',
    HISTORY_PATH: '/tmp/.history-plib.json',
    CACHE_PATH: '/tmp/cache-plib.sqlite',
    ADB_ENABLED: 'false',
    WEB_PORT: String(PORT),
    MQTT_HOST: '',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

try {
  await waitReady(`${BASE}/api/shelves`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  // The stub serves no artwork, so a thumb request would only stall the shot. Both stages
  // render the same placeholder.
  await page.route('**/api/thumb/**', (route) => route.fulfill({ status: 404, body: '' }));

  await page.goto(`${BASE}/pending`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#pending:not([hidden])', { timeout: 30000 });
  await page.waitForSelector('#pendinggrid li', { timeout: 120000 });
  await page.waitForTimeout(1200);

  // The numbers the caption claims, read off the page rather than asserted about it. `cells`
  // is what EXISTS and `total` is what the list HOLDS — before the change they are the same
  // number, which is the whole finding.
  const stats = await page.evaluate(() => ({
    cells: document.querySelectorAll('#pendinggrid li').length,
    total: document.querySelector('#pendinggrid li')?.getAttribute('aria-setsize') ?? 'n/a',
    domNodes: document.getElementsByTagName('*').length,
    buttons: document.querySelectorAll('button').length,
    libraryBoxes: document.querySelectorAll('#pending-libs input[type=checkbox]').length,
  }));
  console.log(`${STAGE}:`, JSON.stringify(stats));

  await page.screenshot({ path: `${OUT}/pending-libraries-${STAGE}.png` });
  console.log('shot:', `${OUT}/pending-libraries-${STAGE}.png`);
  await browser.close();
} finally {
  await killServer(srv);
  await plex.close();
}
