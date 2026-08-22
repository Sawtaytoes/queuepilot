// Before/after shot of the PENDING screen's two views.
//
// Every byte on screen is fixture data (`stubs/plex-pending-libraries.mjs`, reused as-is):
// the repo is public, and a live capture would commit the owner's library into a PNG no grep
// will ever find again (decision
// `2026-08-19-pr-screenshots-are-fixture-data-and-pinned-to-the-merge`).
//
// `before` is meant to be run from a checkout of the branch point — this file and the stub it
// imports are the only things copied in, so the view under it is the old one. `after` shoots
// twice, once per view, because the change IS the choice between them.
//
// Usage: `server/node_modules/.bin/tsx e2e/shot-pending-views.ts [before|after]`
// Writes `__screenshots__/pending-views-before.png`, `-posters.png`, `-list.png`.
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
const PORT = parseInt(process.env.WEB_PORT || '18898', 10);
const PLEX_PORT = parseInt(process.env.STUB_PLEX_PORT || '18899', 10);
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
await fs.writeFile('/tmp/queues-pviews.yaml', QUEUES_YAML);
await fs.writeFile('/tmp/sets-pviews.yaml', SETS_YAML);
await fs.writeFile('/tmp/pending-pviews.yaml', PENDING_YAML);
for (const p of ['/tmp/queues-pviews.yaml.lock', '/tmp/sets-pviews.yaml.lock', '/tmp/cache-pviews.sqlite']) {
  await fs.rm(p, { recursive: true, force: true });
}

const plex = startStubPlex(PLEX_PORT);
await plex.ready;

const srv = spawnServer({
  env: {
    ...process.env,
    PLEX_API_SERVER_URL: `http://127.0.0.1:${PLEX_PORT}`,
    PLEX_TOKEN: 'stub',
    QUEUES_PATH: '/tmp/queues-pviews.yaml',
    SETS_PATH: '/tmp/sets-pviews.yaml',
    PENDING_PATH: '/tmp/pending-pviews.yaml',
    HISTORY_PATH: '/tmp/.history-pviews.json',
    CACHE_PATH: '/tmp/cache-pviews.sqlite',
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
  /*
    The stub Plex serves no artwork, and an empty poster is exactly the wrong thing to shoot
    here: the change is partly ABOUT the poster box, and a 404 collapses it to nothing.

    So every thumb is answered with a flat SVG whose SHAPE alternates — 2:3, then 4:3, then
    3:4. Plex's own posters are not all 2:3 either, and a mixed set is what proves the tile
    draws one box and crops to it rather than inheriting whatever the file happened to be.
  */
  await page.route('**/api/thumb/**', (route) => {
    const key = Number(/\/api\/thumb\/(\d+)/.exec(route.request().url())?.[1] ?? 0);
    const [w, h] = [[400, 600], [600, 450], [450, 600]][key % 3] as [number, number];
    const hue = (key * 47) % 360;

    return route.fulfill({
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">`
        + `<rect width="100%" height="100%" fill="hsl(${hue} 45% 62%)"/></svg>`,
      contentType: 'image/svg+xml',
      status: 200,
    });
  });

  const open = async () => {
    await page.goto(`${BASE}/pending`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#pending:not([hidden])', { timeout: 30000 });
    await page.waitForSelector('#pendinggrid li', { timeout: 120000 });
    await page.waitForTimeout(1200);
  };

  await open();

  if (STAGE === 'before') {
    await page.screenshot({ path: `${OUT}/pending-views-before.png` });
    console.log('shot:', `${OUT}/pending-views-before.png`);
  } else {
    await page.screenshot({ path: `${OUT}/pending-views-posters.png` });
    console.log('shot:', `${OUT}/pending-views-posters.png`);

    await page.getByRole('radio', { name: 'List' }).click();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${OUT}/pending-views-list.png` });
    console.log('shot:', `${OUT}/pending-views-list.png`);

    /*
      A third frame for the control the other two cannot show: "Start at…" appears on a SHOW
      and the fixture's films outnumber its serials thousands to one on the first screenful.
      Narrowing the libraries to Serials is the cheapest way to a page made of shows, and it
      exercises the library filter on the way past.
    */
    await page.getByRole('checkbox', { name: 'Films' }).click();
    await page.waitForTimeout(800);
    await page.getByRole('checkbox', { name: 'Documentaries' }).click();
    await page.waitForSelector('#pendinggrid li', { timeout: 60000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/pending-views-start.png` });
    console.log('shot:', `${OUT}/pending-views-start.png`);
  }

  await browser.close();
} finally {
  await killServer(srv);
  await plex.close();
}
