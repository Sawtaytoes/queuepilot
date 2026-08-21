// Before/after for the shelf's ✕ — the Ordered Queues page could not remove a title.
//
// `--tag=` names the output, so the same script shoots BEFORE on `main` and AFTER on the
// branch and the two frames are comparable pixel for pixel.
//
//   server/node_modules/.bin/tsx e2e/shot-shelf-remove.ts --tag=after
//
// **FIXTURE DATA, NEVER LIVE.** The shelf renders the household's queue NAMES and its
// library's titles; either in a PNG committed to a public repo says something about the
// owner's life, and a PNG is opaque to every grep that would otherwise find it later
// (decision `2026-08-19-pr-screenshots-are-fixture-data-never-live`, and this repo's own
// `2026-08-17-the-repo-is-public-so-people-hosts-and-ips-are-placeholders`). Every name below
// is the repo's anonymized cast.
//
// It runs a STUB PLEX rather than the unroutable one the browser suites use, and that is the
// difference between a useful shot and a misleading one: with no Plex every entry resolves to
// nothing, so the shelf paints six red "Not in library" boxes and the reader is looking at a
// picture of a broken app instead of at the control under discussion. The stub answers a title
// search and serves a flat SVG poster, so the wall reads as a wall.
import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const PORT = 18798;
const tagArg = process.argv.find((a) => a.startsWith('--tag='));
const TAG = tagArg ? tagArg.slice('--tag='.length) : 'after';
const OUT = '__screenshots__';

/** The fixture library: public film titles, no household anywhere in it. */
const LIBRARY = [
  { ratingKey: '9001', title: 'Duel', year: 1971, hue: 8 },
  { ratingKey: '9002', title: 'The Iron Giant', year: 1999, hue: 205 },
  { ratingKey: '9003', title: 'Steamboy', year: 2004, hue: 32 },
  { ratingKey: '9004', title: 'Jin-Roh', year: 1999, hue: 250 },
  { ratingKey: '9005', title: 'Akira', year: 1988, hue: 350 },
  { ratingKey: '9006', title: 'Ghost in the Shell', year: 1995, hue: 170 },
  { ratingKey: '9007', title: 'Ponyo', year: 2008, hue: 190 },
  { ratingKey: '9008', title: 'Song of the Sea', year: 2014, hue: 150 },
  { ratingKey: '9009', title: 'The Secret of Kells', year: 2009, hue: 96 },
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

// --- the stub Plex -------------------------------------------------------------------- //
const plexStub = http.createServer((req, res) => {
  const url = req.url || '';
  const photo = /\/photo\/:\/transcode\?.*[?&]url=([^&]+)/.exec(url);
  if (photo) {
    // The `url` parameter is the METADATA thumb path (`/library/metadata/9002/thumb/1`), so
    // the ratingKey is the id in it — not the trailing `/thumb/1`, which is a version counter
    // and matched first when this was written loosely. Every poster came out as Duel.
    const rk = /\/library\/metadata\/(\d+)\//.exec(decodeURIComponent(photo[1] as string))?.[1] ?? '9001';
    res.setHeader('Content-Type', 'image/svg+xml');
    return res.end(posterSvg(rk));
  }
  res.setHeader('Content-Type', 'application/json');
  if (/\/library\/sections\/\d+\/all\?/.test(url)) {
    const want = decodeURIComponent(/[?&]title=([^&]*)/.exec(url)?.[1] ?? '').toLowerCase();
    const hits = LIBRARY.filter((m) => m.title.toLowerCase() === want);
    return res.end(JSON.stringify({ MediaContainer: { Metadata: hits.map((m) => ({
      ratingKey: m.ratingKey, type: 'movie', title: m.title, year: m.year,
      thumb: `/library/metadata/${m.ratingKey}/thumb/1`, duration: 6_000_000, viewCount: 0,
    })) } }));
  }
  if (/\/library\/metadata\/\d+\/allLeaves/.test(url)) {
    return res.end(JSON.stringify({ MediaContainer: { Metadata: [] } }));
  }
  if (/\/library\/metadata\/\d+/.test(url)) {
    const rk = /\/library\/metadata\/(\d+)/.exec(url)?.[1] ?? '9001';
    const m = LIBRARY.find((x) => x.ratingKey === rk) ?? LIBRARY[0]!;
    return res.end(JSON.stringify({ MediaContainer: { Metadata: [{
      ratingKey: m.ratingKey, type: 'movie', title: m.title, year: m.year,
      thumb: `/library/metadata/${m.ratingKey}/thumb/1`, duration: 6_000_000, viewCount: 0,
    }] } }));
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
  QUEUES_PATH: '/tmp/queues-shotshelfremove.yaml',
  SETS_PATH: '/tmp/sets-shotshelfremove.yaml',
  GROUPS_PATH: '/tmp/groups-shotshelfremove.yaml',
  HISTORY_PATH: '/tmp/history-shotshelfremove.json',
  CACHE_PATH: '/tmp/cache-shotshelfremove.sqlite',
  PLEX_API_SERVER_URL: `http://127.0.0.1:${addr.port}`,
  PLEX_TOKEN: 'stub',
  MQTT_HOST: '',
};

await fs.writeFile(env.QUEUES_PATH, `bob:
- {title: Duel (1971)}
- {title: The Iron Giant (1999)}
- {title: Steamboy (2004)}
- {title: Jin-Roh (1999)}
- {title: Akira (1988)}
- {title: Ghost in the Shell (1995)}
family:
- {title: Ponyo (2008)}
- {title: Song of the Sea (2014)}
- {title: The Secret of Kells (2009)}
`);
await fs.writeFile(env.SETS_PATH, `sets:
- id: bob
  label: Bob — Movies
  kind: movies
  source: queue
  sections: [ 1 ]
- id: family
  label: Family — Movies
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
  // rather than clicking the toggle after it.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  await ctx.addInitScript(() => {
    try { localStorage.setItem('charcuterie-scheme', 'dark'); } catch { /* private mode */ }
  });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/queues`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.shelf[data-set="bob"] li.tile .poster', { timeout: 40000 });
  await page.waitForTimeout(2000);

  const shelf = page.locator('.shelf[data-set="bob"]');
  const tile = page.locator('.shelf[data-set="bob"] li.tile').first();

  // HOVERED, because the chrome is quiet until asked for — a resting shot of the after branch
  // looks identical to the before one and proves nothing.
  await tile.locator('.thumb').hover();
  await page.waitForTimeout(500);
  await shelf.screenshot({ path: `${OUT}/shelf-remove-${TAG}.png` });

  // The per-entry menu, the second half of the change. On `before` this frame is a shelf with
  // no menu on it, which is exactly the point: `useHomeDrags` already swallowed the browser's
  // native menu there, so a right-click did nothing at all.
  await tile.locator('.thumb').click({ button: 'right' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/shelf-remove-${TAG}-menu.png` });

  console.log(`shot: ${OUT}/shelf-remove-${TAG}.png, ${OUT}/shelf-remove-${TAG}-menu.png`);
} finally {
  await browser.close();
  if (server) killServer(server);
  plexStub.close();
}
