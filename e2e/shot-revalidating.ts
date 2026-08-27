// Before/after shot of the PROGRESS LINE — the visible half of the read-cache change.
//
//   BEFORE  nothing says the page is doing anything after it paints.
//   AFTER   a thin indeterminate line sits on the header's bottom edge while the providers
//           are re-read behind the tiles, and is removed when the pass lands
//           (decision `2026-08-26-a-provider-read-is-cached-and-the-page-revalidates-after-it-paints`).
//
// ⚠️ It does NOT show the SPEED, and must not be read as if it did. Eight fixture films
// resolve in one concurrent batch, so both stages paint at about the same moment here — the
// live registry is 340 entries and 566 provider calls, which is where 5.1 s warm became about
// 0.1 s. That claim is a measurement, and what GATES it is `e2e/provider-cache-test.ts`
// counting provider calls; a wall-clock assertion in CI would only be a flake.
//
// The stub delays each metadata read so the line is on screen long enough to photograph. Both
// stages run the SAME script (`--tag=before` on `main`). Every byte on screen is fixture data
// — the repo is public.
//
// Usage: `server/node_modules/.bin/tsx e2e/shot-revalidating.ts [before|after]`
// Writes `__screenshots__/revalidating-<stage>-*.png`.
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = process.argv[2] === 'after' ? 'after' : 'before';
const PORT = parseInt(process.env.WEB_PORT || '18904', 10);
const PLEX_PORT = parseInt(process.env.STUB_PLEX_PORT || '18905', 10);
const BASE = `http://localhost:${PORT}`;
const OUT = `${ROOT}/__screenshots__`;
const TMP = `/tmp/qp-reval-shot-${process.pid}`;

/**
 * How long the stub takes to answer ONE metadata read.
 *
 * Deliberately slower than a real Plex call (~30 ms on the owner's LAN). Eight fixture films
 * resolve concurrently, so a realistic delay makes the whole pass finish in about 45 ms —
 * faster than one frame, which photographs neither the progress line nor the wait it
 * replaces. The LIVE pass is 6.8 s over 566 calls; this makes the fixture's about one second,
 * which is still an order of magnitude kinder than the thing being illustrated.
 */
const READ_DELAY_MS = 900;

const MIN = 60_000;
const MOVIES = 1;

const FILMS = [
  { ratingKey: '8101', title: 'A Trip to the Moon', year: 1902, duration: 13 * MIN },
  { ratingKey: '8102', title: 'The Cabinet of Dr. Caligari', year: 1920, duration: 76 * MIN },
  { ratingKey: '8103', title: 'Nosferatu', year: 1922, duration: 94 * MIN },
  { ratingKey: '8104', title: 'Metropolis', year: 1927, duration: 148 * MIN },
  { ratingKey: '8105', title: 'The General', year: 1926, duration: 79 * MIN },
  { ratingKey: '8106', title: 'The Gold Rush', year: 1925, duration: 95 * MIN },
  { ratingKey: '8107', title: 'Sherlock Jr.', year: 1924, duration: 45 * MIN },
  { ratingKey: '8108', title: 'The Kid', year: 1921, duration: 68 * MIN },
].map((f) => ({ ...f, type: 'movie', librarySectionID: MOVIES }));

const QUEUES_YAML = `bob:\n${FILMS
  .map((f) => `- {ratingKey: "${f.ratingKey}", title: "${f.title} (${f.year})"}`)
  .join('\n')}\n`;

const SETS_YAML = `sets:
  - id: bob
    label: Bob — Movies
    kind: picks
    source: queue
    add_as: priority
    sections: [${MOVIES}]
`;

function slowPlex(port: number) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    const send = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const wrap = (rows: unknown[]) => send({ MediaContainer: { size: rows.length, Metadata: rows } });
    if (url.pathname === '/library/sections') {
      return send({
        MediaContainer: {
          size: 1,
          Directory: [{ key: String(MOVIES), title: 'Movies', type: 'movie', agent: 'tv.plex.agents.movie' }],
        },
      });
    }
    if (/^\/library\/sections\/\d+\/collections$/.test(url.pathname)) return wrap([]);
    if (/^\/library\/sections\/\d+\/all$/.test(url.pathname)) return wrap(FILMS);
    const meta = /^\/library\/metadata\/([\d,]+)$/.exec(url.pathname);
    if (meta) {
      await new Promise((r) => setTimeout(r, READ_DELAY_MS));
      const want = new Set(String(meta[1]).split(','));
      return wrap(FILMS.filter((m) => want.has(m.ratingKey)));
    }
    return send({ MediaContainer: { size: 0 } });
  });
  const listening = new Promise<void>((resolve) => { server.listen(port, '127.0.0.1', () => resolve()); });
  return {
    ready: listening,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

const waitReady = async (url: string, ms = 30000) => {
  const end = Date.now() + ms;
  for (;;) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`not ready: ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
};

await fs.mkdir(OUT, { recursive: true });
await fs.mkdir(TMP, { recursive: true });
await fs.writeFile(`${TMP}/queues.yaml`, QUEUES_YAML);
await fs.writeFile(`${TMP}/sets.yaml`, SETS_YAML);

const plex = slowPlex(PLEX_PORT);
await plex.ready;

const srv = spawnServer({
  env: {
    ...process.env,
    ADB_ENABLED: 'false',
    CACHE_PATH: `${TMP}/cache.sqlite`,
    HISTORY_PATH: `${TMP}/.history.json`,
    KAVITA_API_KEY: '',
    KAVITA_API_SERVER_URL: '',
    MQTT_HOST: '',
    PLEX_API_SERVER_URL: `http://127.0.0.1:${PLEX_PORT}`,
    PLEX_TOKEN: 'stub',
    QUEUES_PATH: `${TMP}/queues.yaml`,
    SETS_PATH: `${TMP}/sets.yaml`,
    STORE_PATH: `${TMP}/store.sqlite`,
    WEB_PORT: String(PORT),
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

try {
  await waitReady(`${BASE}/api/shelves`);
  // Warm whatever the build under test caches. The before stage caches nothing, which is the
  // finding: the same warm-up leaves it exactly as slow.
  await fetch(`${BASE}/api/queues`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.route('**/api/thumb/**', (route) => route.fulfill({ body: '', status: 404 }));

  const started = Date.now();
  await page.goto(`${BASE}/q/bob`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#queue:not([hidden])', { timeout: 30000 });

  // 1 — 400 ms in, which is inside the refresh pass. After: the line is there. Before: it is
  // not, and there is nothing else that would have said so.
  await page.waitForTimeout(400);
  const tilesAt400 = await page.locator('.tile').count();
  const lineAt400 = await page.locator('#revalidating').count();
  await page.screenshot({ path: `${OUT}/revalidating-${STAGE}-1-early.png` });
  console.log(`${STAGE}: ${tilesAt400} tiles at 400ms, progress line: ${lineAt400 > 0} (+${Date.now() - started}ms)`);

  // 2 — settled.
  await page.waitForFunction(
    () => document.querySelectorAll('.tile').length >= 8,
    undefined,
    { timeout: 30000 },
  ).catch(() => { /* reported below */ });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/revalidating-${STAGE}-2-settled.png` });
  console.log(`${STAGE}: ${await page.locator('.tile').count()} tiles settled (+${Date.now() - started}ms)`);
  console.log(`${STAGE}: progress line present at settle:`, await page.locator('#revalidating').count() > 0);

  console.log(`shot: ${OUT}/revalidating-${STAGE}-*.png`);
  await browser.close();
} finally {
  killServer(srv);
  await plex.close();
  await fs.rm(TMP, { recursive: true, force: true });
}

process.exit(0);
