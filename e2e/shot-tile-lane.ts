// Before/after shot of the TILE CHROME: the select mark, and the lane control under it.
//
//   BEFORE  ✕ over an empty ring. The ring is empty in every state — the rule that turns a
//           selected tile's circle accent is outranked by the one that draws the circle, so
//           the ✓ never paints and the control looks identical checked and unchecked
//           (owner, 2026-08-26: "Checkbox icon isn't working").
//   AFTER   the mark is an SVG that ghosts in on hover and goes solid on the accent fill when
//           checked, and a third control sits under it: ↑ into the Priority queue, ↓ back out.
//
// Same script for both stages; the third control is simply absent before the change. Every
// byte on screen is fixture data (`stubs/plex-member-list.mjs` — a collection of public-domain
// films). Dark scheme, because that is what the owner reads the app in.
//
// Usage: `server/node_modules/.bin/tsx e2e/shot-tile-lane.ts [before|after]`
// Writes `__screenshots__/tile-lane-<stage>-*.png`.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright.js';
import { startStubPlex } from './stubs/plex-member-list.mjs';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = process.argv[2] === 'after' ? 'after' : 'before';
const PORT = parseInt(process.env.WEB_PORT || '18902', 10);
const PLEX_PORT = parseInt(process.env.STUB_PLEX_PORT || '18903', 10);
const BASE = `http://localhost:${PORT}`;
const OUT = `${ROOT}/__screenshots__`;

// An ORDERED queue with one entry pushed down into the pool, so BOTH lanes are drawn and the
// arrow has both directions to show. The lane the control moves an entry to is the one it is
// not in, so a page with one populated lane would only ever prove half of it.
const QUEUES_YAML = `bob:
- {title: "Collection: The Frontier Trilogy"}
- {ratingKey: "9700", title: "The Phantom Carriage (1921)", placement: random}
`;
const SETS_YAML = `sets:
  - id: bob
    label: Bob — Movies
    kind: picks
    source: queue
    add_as: priority
    sections: [1, 5]
`;

const waitReady = async (url: string, ms = 30000) => {
  const end = Date.now() + ms;
  for (;;) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`not ready: ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
};

await fs.mkdir(OUT, { recursive: true });
await fs.writeFile('/tmp/queues-tilelane.yaml', QUEUES_YAML);
await fs.writeFile('/tmp/sets-tilelane.yaml', SETS_YAML);
for (const p of [
  '/tmp/queues-tilelane.yaml.lock', '/tmp/sets-tilelane.yaml.lock',
  '/tmp/cache-tilelane.sqlite', '/tmp/queuepilot-tilelane.sqlite',
]) {
  await fs.rm(p, { force: true, recursive: true });
}

const plex = startStubPlex(PLEX_PORT);
await plex.ready;

const srv = spawnServer({
  env: {
    ...process.env,
    ADB_ENABLED: 'false',
    CACHE_PATH: '/tmp/cache-tilelane.sqlite',
    HISTORY_PATH: '/tmp/.history-tilelane.json',
    MQTT_HOST: '',
    PLEX_API_SERVER_URL: `http://127.0.0.1:${PLEX_PORT}`,
    PLEX_TOKEN: 'stub',
    QUEUES_PATH: '/tmp/queues-tilelane.yaml',
    SETS_PATH: '/tmp/sets-tilelane.yaml',
    STORE_PATH: '/tmp/queuepilot-tilelane.sqlite',
    WEB_PORT: String(PORT),
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

try {
  await waitReady(`${BASE}/api/shelves`);

  const browser = await chromium.launch();
  const page = await browser.newPage({
    colorScheme: 'dark',
    viewport: { width: 1180, height: 820 },
  });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.route('**/api/thumb/**', (route) => route.fulfill({ body: '', status: 404 }));

  await page.goto(`${BASE}/q/bob`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#queue:not([hidden])', { timeout: 30000 });
  // The scheme toggle persists to localStorage, so the `colorScheme` above is not enough.
  await page.evaluate(() => document.documentElement.setAttribute('data-scheme', 'dark'));
  await page.waitForFunction(
    () => document.body.innerText.includes('Great Train Robbery'),
    undefined,
    { timeout: 60000 },
  );
  await page.waitForTimeout(600);

  const lanes = page.locator('.lanes');
  const poolTile = page.locator('ul.grid[data-lane="random"] li.tile').first();

  // 1 — at REST. The chrome is quiet until asked for, in both stages.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
  await lanes.screenshot({ path: `${OUT}/tile-lane-${STAGE}-1-rest.png` });

  // 2 — HOVERED. The poster, not the tile: hovering the tile lands on the next-up line, whose
  // tooltip then covers the chrome these shots exist to show.
  await poolTile.locator('.thumb').hover();
  await page.waitForTimeout(400);
  await lanes.screenshot({ path: `${OUT}/tile-lane-${STAGE}-2-hover.png` });
  console.log(`${STAGE} controls:`, await poolTile.evaluate((el) =>
    [...el.querySelectorAll('.tilechrome > *')].map((c) => c.className).join(', ')));

  // 3 — CHECKED. The frame the report is about: before the change this is indistinguishable
  // from frame 2.
  await poolTile.locator('.check').click();
  await page.waitForTimeout(500);
  await lanes.screenshot({ path: `${OUT}/tile-lane-${STAGE}-3-checked.png` });
  console.log(`${STAGE} checked classes:`, await poolTile.getAttribute('class'));
  console.log(`${STAGE} mark paints:`, await poolTile.locator('.check').evaluate((el) => {
    const svg = el.querySelector('svg');
    const s = getComputedStyle(el);
    return svg
      ? { fill: s.backgroundColor, markOpacity: getComputedStyle(svg).opacity }
      : { fill: s.backgroundColor, text: el.textContent, color: s.color };
  }));

  // 4 — PROMOTED. Only the after stage has the control; before it, the pool tile stays put
  // and that absence is the finding.
  const lane = poolTile.locator('.lanebtn');
  if (await lane.count()) {
    await poolTile.locator('.check').click(); // clear the selection first — this is a
    await page.waitForTimeout(300);           // separate claim and the bar would cover it
    await poolTile.locator('.thumb').hover();
    await lane.click();
    await page.waitForFunction(
      () => document.querySelectorAll('ul.grid[data-lane="priority"] li.tile').length === 2,
      undefined,
      { timeout: 30000 },
    );
    await page.mouse.move(0, 0);
    await page.waitForTimeout(600);
    await lanes.screenshot({ path: `${OUT}/tile-lane-${STAGE}-4-promoted.png` });
    const order = await page.$$eval(
      'ul.grid[data-lane="priority"] li.tile .title',
      (els) => els.map((e) => (e.textContent || '').trim()),
    );
    console.log(`${STAGE} priority lane after the press:`, order);
  } else {
    console.log(`${STAGE}: no lane control on this build — the drag is the only way across`);
  }

  console.log(`shot: ${OUT}/tile-lane-${STAGE}-*.png`);
  await browser.close();
} finally {
  killServer(srv);
  await plex.close();
}

process.exit(0);
