// The QUEUE add-search, told apart by its edition — the before/after pair for the fix that
// carries #139's edition label across from the pool member picker.
//
// FIXTURE DATA, NO LIVE PLEX. The shot has to show two library items with the same title and
// the same year, which is the household's own library in every real capture, and a PNG is
// opaque to every grep that would otherwise catch it later. The stub below serves that exact
// SHAPE — one tagged edition, one plain, both invented — so the geometry the shot is about
// reproduces with none of the household in it.
// (decision `2026-08-19-pr-screenshots-are-fixture-data-never-live` in the agentic root repo)
//
// Runs against ANY vintage of the app, because it is used to re-shoot the BEFORE at the
// pre-fix commit:
//
//   server/node_modules/.bin/tsx e2e/shot-queue-search-edition.ts --tag=before
//
// Writes `__screenshots__/queue-search-edition-<tag>.png` and, for the same fix on the Home
// toolbar's add-to-ANY-queue box, `__screenshots__/home-search-edition-<tag>.png`.
import type { ChildProcess } from 'node:child_process';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import zlib from 'node:zlib';
import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const PORT = 18796;
const tagArg = process.argv.find((a) => a.startsWith('--tag='));
const TAG = tagArg ? tagArg.slice('--tag='.length) : 'after';

const SECTION = 1;
const SECTIONS = [{ key: String(SECTION), title: 'Movies', type: 'movie' }];

// Two library items, ONE title, ONE year — the whole defect in two rows. Plex tags only the
// non-default edition, so `900002` carries no `editionTitle` and must stay plain.
const TAGGED = '900001';
const PLAIN = '900002';
const MOVIES = [
  {
    ratingKey: TAGGED,
    type: 'movie',
    title: 'The Fixture Feature',
    year: 2019,
    editionTitle: "Director's Cut",
    thumb: `/t/${TAGGED}.png`,
    duration: 6_000_000,
    viewCount: 0,
    viewOffset: 0,
  },
  {
    ratingKey: PLAIN,
    type: 'movie',
    title: 'The Fixture Feature',
    year: 2019,
    thumb: `/t/${PLAIN}.png`,
    duration: 5_400_000,
    viewCount: 0,
    viewOffset: 0,
  },
];

/** A 1x1 RGB PNG, so a poster is a flat colour rather than the browser's broken-image glyph. */
function onePixelPng(r: number, g: number, b: number): Buffer {
  const chunk = (type: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(typed));
    return Buffer.concat([head, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0x00, r, g, b]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const POSTERS: Record<string, Buffer> = {
  [TAGGED]: onePixelPng(0x3f, 0x51, 0x8a),
  [PLAIN]: onePixelPng(0x7a, 0x4a, 0x3f),
};

const plexStub = http.createServer((req, res) => {
  const url = req.url || '';

  // The poster bytes. `plex.thumb()` asks for the transcode first and falls back to the raw
  // art path, so both shapes answer.
  const photo = /url=([^&]+)/.exec(url);
  const key = /\/t\/(\d+)\.png/.exec(photo ? decodeURIComponent(photo[1] ?? '') : url)?.[1];
  if (key && POSTERS[key]) {
    res.setHeader('Content-Type', 'image/png');
    return res.end(POSTERS[key]);
  }

  res.setHeader('Content-Type', 'application/json');

  if (/\/library\/sections(\?|$)/.test(url))
    return res.end(JSON.stringify({ MediaContainer: { Directory: SECTIONS } }));

  if (/\/library\/sections\/\d+\/collections/.test(url))
    return res.end(JSON.stringify({ MediaContainer: { Metadata: [] } }));

  // The rating facets, empty. Answered EXPLICITLY because the fallback path is the same
  // `all?` listing the search uses, and the pool's "Allowed ratings" box would then offer the
  // film's title as a content rating.
  if (/\/library\/sections\/\d+\/contentRating/.test(url) || /group=contentRating/.test(url))
    return res.end(JSON.stringify({ MediaContainer: { Directory: [] } }));

  // The add box's search. Title-filtered here the way Plex filters it, so a query that
  // matches nothing still answers an empty list rather than everything.
  const all = /\/library\/sections\/(\d+)\/all\?(.*)$/.exec(url);
  if (all) {
    const title = decodeURIComponent(new URLSearchParams(all[2]).get('title') || '').toLowerCase();
    const hits = MOVIES.filter((m) => !title || m.title.toLowerCase().includes(title));
    return res.end(JSON.stringify({ MediaContainer: { Metadata: hits } }));
  }

  // One entry already in the queue resolves through here, which is what draws its tile AND
  // what makes the search row say "In this queue".
  const md = /\/library\/metadata\/([\d,]+)/.exec(url);
  if (md) {
    const want = new Set((md[1] ?? '').split(','));
    return res.end(
      JSON.stringify({
        MediaContainer: {
          Metadata: MOVIES.filter((m) => want.has(m.ratingKey)).map((m) => ({
            ...m,
            librarySectionID: SECTION,
          })),
        },
      }),
    );
  }

  res.end(JSON.stringify({ MediaContainer: {} }));
});

await new Promise<void>((r) => plexStub.listen(0, () => r()));

const addr = plexStub.address();

if (addr === null || typeof addr === 'string') throw new Error('the stub Plex did not bind a TCP port');

const SETS_PATH = '/tmp/sets-shotqse.yaml';
const QUEUES_PATH = '/tmp/queues-shotqse.yaml';

// One ordered queue over the stub's movie library, plus one filtered pool — the pool is what
// draws the THIRD picker with the same defect, the Blocked list.
const SETS_SEED = `sets:
- id: fixture
  label: Fixture — Movies
  kind: movies
  source: queue
  sections: [ ${SECTION} ]
- id: fixturepool
  label: Fixture — Pool
  kind: cartoons
  source: rotation
  behavior: progress
  item_sections: [ ${SECTION} ]
`;

// The tagged edition is ALREADY in the queue and stored the way the pre-fix add box stored
// it — title only, no edition. That is what makes the pair of search rows show BOTH branches
// of `rowFor` at once: the already-queued row and the addable one.
const QUEUES_SEED = `fixture:
- ratingKey: ${TAGGED}
  title: The Fixture Feature (2019)
`;

const env = {
  ...process.env,
  WEB_PORT: String(PORT),
  SETS_PATH,
  QUEUES_PATH,
  GROUPS_PATH: '/tmp/groups-shotqse.yaml',
  HISTORY_PATH: '/tmp/history-shotqse.json',
  CACHE_PATH: '/tmp/cache-shotqse.sqlite',
  PLEX_API_SERVER_URL: `http://localhost:${addr.port}`,
  PLEX_TOKEN: 'stub',
  MQTT_HOST: '',
  NODE_TLS_REJECT_UNAUTHORIZED: '0',
};

for (const [body, dest] of [
  [SETS_SEED, SETS_PATH],
  [QUEUES_SEED, QUEUES_PATH],
] as const) {
  await fs.writeFile(dest, body);
  await fs.rm(`${dest}.lock`, { force: true, recursive: true });
}
await fs.rm(env.CACHE_PATH, { force: true }); // a 7-day resolve cache would outlive the run
await fs.mkdir('__screenshots__', { recursive: true });

let server: ChildProcess | undefined;
const browser = await chromium.launch();

try {
  server = spawnServer({ env, stdio: 'ignore' });

  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`http://localhost:${PORT}/api/sets`).then((r) => r.json());
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const page = await browser.newPage({ viewport: { width: 900, height: 560 } });

  await page.goto(`http://localhost:${PORT}/q/fixture`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#search', { timeout: 30000 });
  await page.fill('#search', '');
  await page.fill('#search', 'fixture feature');
  await page.waitForSelector('#results.open li', { timeout: 20000 });
  await page.waitForTimeout(1200);

  const rows = await page.locator('#results li').allInnerTexts();
  console.log(`rows:\n${rows.map((r) => `  ${r.replace(/\n/g, ' · ')}`).join('\n')}`);

  const path = `__screenshots__/queue-search-edition-${TAG}.png`;
  await page.screenshot({ path });
  console.log(`shot: ${path}`);

  // The SECOND picker with the same defect: Home's add-to-any-queue box writes the same queue
  // entry this one does, from the same hit, and named it the same wrong way.
  await page.goto(`http://localhost:${PORT}/queues`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#gsearch', { timeout: 30000 });
  await page.fill('#gsearch', '');
  await page.fill('#gsearch', 'fixture feature');
  await page.waitForSelector('#gresults.open li', { timeout: 20000 });
  await page.waitForTimeout(1200);

  const homeRows = await page.locator('#gresults li').allInnerTexts();
  console.log(`home rows:\n${homeRows.map((r) => `  ${r.replace(/\n/g, ' · ')}`).join('\n')}`);

  const homePath = `__screenshots__/home-search-edition-${TAG}.png`;
  await page.screenshot({ path: homePath });
  console.log(`shot: ${homePath}`);

  // The THIRD picker: a pool's Blocked list. It excludes by ratingKey, so it excludes exactly
  // ONE of the two editions — and the row never said which.
  // Taller, because the filters panel has a PINNED footer: at 560 the dropdown opens behind
  // "Save filters" and the shot shows half a row.
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto(`http://localhost:${PORT}/channels`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#ch-blocksearch', { timeout: 30000 });
  await page.locator('#ch-blocksearch').scrollIntoViewIfNeeded();
  await page.fill('#ch-blocksearch', '');
  await page.fill('#ch-blocksearch', 'fixture feature');
  await page.waitForSelector('#ch-blockresults.open li', { timeout: 20000 });
  await page.waitForTimeout(1200);

  const blockRows = await page.locator('#ch-blockresults li').allInnerTexts();
  console.log(`blocked rows:\n${blockRows.map((r) => `  ${r.replace(/\n/g, ' · ')}`).join('\n')}`);

  const blockPath = `__screenshots__/blocked-search-edition-${TAG}.png`;
  await page.screenshot({ path: blockPath });
  console.log(`shot: ${blockPath}`);
} finally {
  killServer(server);
  await browser.close();
  plexStub.close();
}
