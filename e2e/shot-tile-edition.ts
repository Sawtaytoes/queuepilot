// Before/after for the tile's EDITION chip — a queue grid, the Ordered Queues shelf and the
// Narrow View, each holding two editions of one film.
//
// `--tag=` names the output, so the same script shoots BEFORE on `main` and AFTER on the
// branch and the frames are comparable pixel for pixel. The web bundle is what the server
// serves, so rebuild `web/dist` between the two runs:
//
//   yarn workspace queuepilot-web run build
//   server/node_modules/.bin/tsx e2e/shot-tile-edition.ts --tag=after
//
// **FIXTURE DATA, NEVER LIVE.** The shot has to show ONE title twice, and the real pair would
// be the household's own library (decision `2026-08-19-pr-screenshots-are-fixture-data-never-live`
// and this repo's `2026-08-17-the-repo-is-public-so-people-hosts-and-ips-are-placeholders`).
// Every title below is public-domain film and every edition label is invented here.
//
// It runs a STUB PLEX, copied from `shot-shelf-remove.ts` and for the same reason: with an
// unroutable Plex nothing resolves, every tile paints a red "Not in library", and the picture
// is of a broken app rather than of the chip under discussion. This stub adds one field to
// that one — `editionTitle` on the metadata it answers with.
import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const PORT = 18847;
const tagArg = process.argv.find((a) => a.startsWith('--tag='));
const TAG = tagArg ? tagArg.slice('--tag='.length) : 'after';
const OUT = '__screenshots__';

/**
 * The fixture library. TWO PAIRS share a title AND a year and differ only in the edition —
 * which is the whole point: without the chip those four tiles are two identical twins.
 *
 * The long label is deliberate. "Original TV Version – 16mm scan" is what a caption layout
 * breaks on if it is going to, and the Narrow View frame below is where it breaks first.
 */
const LIBRARY = [
  { ratingKey: '9101', title: 'Nosferatu', year: 1922, hue: 250, edition: null },
  { ratingKey: '9102', title: 'Nosferatu', year: 1922, hue: 205, edition: 'Original TV Version – 16mm scan' },
  { ratingKey: '9103', title: 'The General', year: 1926, hue: 32, edition: null },
  { ratingKey: '9104', title: 'The General', year: 1926, hue: 8, edition: "Director's Cut" },
  { ratingKey: '9105', title: 'The Iron Giant', year: 1999, hue: 170, edition: null },
  { ratingKey: '9106', title: 'Steamboy', year: 2004, hue: 350, edition: null },
  { ratingKey: '9107', title: 'Akira', year: 1988, hue: 96, edition: null },
  { ratingKey: '9108', title: 'Song of the Sea', year: 2014, hue: 150, edition: null },
];

/** A flat two-tone poster with the title on it — enough to read as artwork, invented here. */
const posterSvg = (rk: string) => {
  const m = LIBRARY.find((x) => x.ratingKey === rk) ?? LIBRARY[0]!;
  const words = m.title.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if ((`${line} ${w}`).trim().length > 12) { lines.push(line.trim()); line = w; }
    else line = `${line} ${w}`;
  }
  if (line.trim()) lines.push(line.trim());
  const text = lines
    .map((l, i) => `<text x="240" y="${560 + i * 58}" fill="#f4f4f5" font-family="Helvetica, Arial, sans-serif" font-size="46" font-weight="600" text-anchor="middle">${l}</text>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="720" viewBox="0 0 480 720">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="hsl(${m.hue} 55% 42%)"/>
      <stop offset="1" stop-color="hsl(${(m.hue + 40) % 360} 45% 16%)"/>
    </linearGradient></defs>
    <rect width="480" height="720" fill="url(#g)"/>
    <circle cx="240" cy="300" r="120" fill="hsl(${m.hue} 60% 62%)" opacity="0.35"/>
    ${text}</svg>`;
};

/** One item as Plex answers it. `editionTitle` is OMITTED on the plain edition of a pair —
 *  Plex tags only the non-default item, and a "" would not be the same test. */
const metadataFor = (m: (typeof LIBRARY)[number]) => ({
  ratingKey: m.ratingKey,
  type: 'movie',
  title: m.title,
  year: m.year,
  ...(m.edition ? { editionTitle: m.edition } : {}),
  thumb: `/library/metadata/${m.ratingKey}/thumb/1`,
  duration: 6_000_000,
  viewCount: 0,
});

// --- the stub Plex -------------------------------------------------------------------- //
const plexStub = http.createServer((req, res) => {
  const url = req.url || '';
  const photo = /\/photo\/:\/transcode\?.*[?&]url=([^&]+)/.exec(url);
  if (photo) {
    // The ratingKey is the id INSIDE the metadata thumb path, not the trailing `/thumb/1`
    // version counter — matching that loosely made every poster the same one.
    const rk = /\/library\/metadata\/(\d+)\//.exec(decodeURIComponent(photo[1] as string))?.[1] ?? '9101';
    res.setHeader('Content-Type', 'image/svg+xml');
    return res.end(posterSvg(rk));
  }
  res.setHeader('Content-Type', 'application/json');
  if (/\/library\/sections\/\d+\/all\?/.test(url)) {
    const want = decodeURIComponent(/[?&]title=([^&]*)/.exec(url)?.[1] ?? '').toLowerCase();
    const hits = LIBRARY.filter((m) => m.title.toLowerCase() === want);
    return res.end(JSON.stringify({ MediaContainer: { Metadata: hits.map(metadataFor) } }));
  }
  if (/\/library\/metadata\/\d+\/allLeaves/.test(url)) {
    return res.end(JSON.stringify({ MediaContainer: { Metadata: [] } }));
  }
  if (/\/library\/metadata\/\d+/.test(url)) {
    const rk = /\/library\/metadata\/(\d+)/.exec(url)?.[1] ?? '9101';
    const m = LIBRARY.find((x) => x.ratingKey === rk) ?? LIBRARY[0]!;
    return res.end(JSON.stringify({ MediaContainer: { Metadata: [metadataFor(m)] } }));
  }
  if (/\/library\/sections\/\d+\/collections/.test(url)) {
    return res.end(JSON.stringify({ MediaContainer: { Metadata: [] } }));
  }
  if (/\/library\/sections(\?|$)/.test(url)) {
    return res.end(JSON.stringify({ MediaContainer: { Directory: [{ key: '1', title: 'Movies', type: 'movie' }] } }));
  }
  res.end(JSON.stringify({ MediaContainer: {} }));
});
await new Promise<void>((r) => plexStub.listen(0, () => r()));
const addr = plexStub.address();
if (addr === null || typeof addr === 'string') throw new Error('the stub Plex did not bind a TCP port');

const env = {
  ...process.env,
  WEB_PORT: String(PORT),
  QUEUES_PATH: '/tmp/queues-shottileedition.yaml',
  SETS_PATH: '/tmp/sets-shottileedition.yaml',
  GROUPS_PATH: '/tmp/groups-shottileedition.yaml',
  HISTORY_PATH: '/tmp/history-shottileedition.json',
  CACHE_PATH: '/tmp/cache-shottileedition.sqlite',
  PLEX_API_SERVER_URL: `http://127.0.0.1:${addr.port}`,
  PLEX_TOKEN: 'stub',
  MQTT_HOST: '',
};

// Entries carry the ratingKey, which is what a pick writes — and it is the only way to name
// ONE of two items that share a title and a year. The stored `title` is display text and
// names the edition too, exactly as `entryTitle()` builds it (#153).
const entry = (m: (typeof LIBRARY)[number]) =>
  `- ratingKey: '${m.ratingKey}'\n  title: ${JSON.stringify(`${m.title} (${m.year})${m.edition ? ` — ${m.edition}` : ''}`)}`;

await fs.writeFile(env.QUEUES_PATH, `bob:\n${LIBRARY.map(entry).join('\n')}\n`);
await fs.writeFile(env.SETS_PATH, `sets:
- id: bob
  label: Bob — Movies
  kind: movies
  source: queue
  sections: [ 1 ]
`);
for (const p of [env.QUEUES_PATH, env.SETS_PATH]) {
  await fs.rm(`${p}.lock`, { force: true, recursive: true });
}
for (const p of [env.HISTORY_PATH, env.CACHE_PATH, `${env.CACHE_PATH}-wal`, `${env.CACHE_PATH}-shm`]) {
  await fs.rm(p, { force: true });
}
await fs.mkdir(OUT, { recursive: true });

let server: ChildProcess | undefined;
const browser = await chromium.launch();

try {
  server = spawnServer({ env, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { await fetch(`http://localhost:${PORT}/api/sets`).then((r) => r.json()); break; } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // The owner's UI is dark; the scheme persists to localStorage, so set it before first paint
  // rather than clicking a toggle after it.
  const seedScheme = () => {
    try { localStorage.setItem('charcuterie-scheme', 'dark'); } catch { /* private mode */ }
  };

  // --- the queue grid, wide ---------------------------------------------------------- //
  const wide = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await wide.addInitScript(seedScheme);
  const page = await wide.newPage();
  await page.goto(`http://localhost:${PORT}/q/bob`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#grid li.tile .poster', { timeout: 40000 });
  await page.waitForTimeout(2500);
  await page.locator('#grid').screenshot({ path: `${OUT}/tile-edition-grid-${TAG}.png` });

  // --- the Ordered Queues shelf ------------------------------------------------------ //
  await page.goto(`http://localhost:${PORT}/queues`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.shelf[data-set="bob"] li.tile .poster', { timeout: 40000 });
  await page.waitForTimeout(2500);
  // Clipped with a margin rather than shot as an element: the shelf's own box ends at the
  // badge row, so an element shot cuts the chip in half — which is the one thing this frame
  // exists to show.
  const box = await page.locator('.shelf[data-set="bob"]').boundingBox();
  if (!box) throw new Error('the shelf did not lay out');
  await page.screenshot({
    clip: { height: box.height + 28, width: box.width, x: box.x, y: box.y },
    path: `${OUT}/tile-edition-shelf-${TAG}.png`,
  });
  await wide.close();

  // --- the NARROW VIEW --------------------------------------------------------------- //
  // 390px is where `--tile` drops to 132px, so it is where a long edition label would push
  // the caption open or scroll the page sideways if the chip did not cap itself.
  const narrow = await browser.newContext({ viewport: { width: 390, height: 900 } });
  await narrow.addInitScript(seedScheme);
  const narrowPage = await narrow.newPage();
  await narrowPage.goto(`http://localhost:${PORT}/q/bob`, { waitUntil: 'domcontentloaded' });
  await narrowPage.waitForSelector('#grid li.tile .poster', { timeout: 40000 });
  // The POSTER wall, which is the tightest caption there is: `--tile` is 132px below 760px,
  // so this is where a long edition label breaks the layout if it is going to.
  await narrowPage.getByRole('radio', { name: 'Posters' }).click();
  // The click leaves the pointer over whatever the density swap slid under it, and a HOVERED
  // tile wears its ✕ and its ▶ — chrome that has nothing to do with this change and that
  // lands on a different tile in the before and after frames.
  await narrowPage.mouse.move(2, 2);
  await narrowPage.waitForTimeout(2500);
  await narrowPage.locator('#grid').screenshot({ path: `${OUT}/tile-edition-narrow-${TAG}.png` });

  // The claim the frame alone cannot make: nothing scrolls sideways. Same measurement the
  // `narrow-scroll` gate makes, taken here so the shot and the assertion agree.
  const overflow = await narrowPage.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  console.log(`narrow view horizontal overflow: ${overflow}px`);
  await narrow.close();

  console.log(`shot: ${OUT}/tile-edition-{grid,shelf,narrow}-${TAG}.png`);
} finally {
  await browser.close();
  if (server) killServer(server);
  plexStub.close();
}
