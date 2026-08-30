// Before/after for SKIPPED — the curated queue's item-level exclude.
//
// Three frames, and the middle one is the whole feature: the queue grid, the tile menu with
// its new Skip row, and the queue grid again after the skip — where the tile's next-up has
// moved on to the following episode and the Skipped panel has appeared below the grid.
//
// `--tag=` names the output, so the same script shoots BEFORE on `main` and AFTER on the
// branch and the frames are comparable pixel for pixel. The web bundle is what the server
// serves, so rebuild `web/dist` between the two runs:
//
//   yarn workspace queuepilot-web run build
//   server/node_modules/.bin/tsx e2e/shot-skipped-items.ts --tag=after
//
// **FIXTURE DATA, NEVER LIVE** (decision `2026-08-19-pr-screenshots-are-fixture-data-never-live`,
// and this repo's `2026-08-17-the-repo-is-public-so-people-hosts-and-ips-are-placeholders`).
// Every show and episode title below is invented here.
//
// It runs a STUB PLEX, the same one `shot-tile-edition.ts` uses, widened to answer
// `allLeaves` with real episodes: a skip is a skip of an EPISODE, so a stub that returns no
// leaves would paint a queue with nothing to skip.
import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import { chromium } from './playwright.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const PORT = 18852;
const tagArg = process.argv.find((a) => a.startsWith('--tag='));
const TAG = tagArg ? tagArg.slice('--tag='.length) : 'after';
const OUT = '__screenshots__';

/** The fixture library: three shows, each with a short run of unwatched episodes. */
const SHOWS = [
  { ratingKey: '5100', title: 'The Lantern Keepers', year: 2021, hue: 250 },
  { ratingKey: '5200', title: 'Harbour Nine', year: 2019, hue: 32 },
  { ratingKey: '5300', title: 'Paper Cranes', year: 2023, hue: 160 },
];
/** Four episodes per show. Nothing is watched, so E1 is every tile's next-up to begin with. */
const EPISODES: Record<string, { ratingKey: string; index: number; title: string }[]> = {
  5100: [
    { ratingKey: '5101', index: 1, title: 'First Light' },
    { ratingKey: '5102', index: 2, title: 'The Long Watch' },
    { ratingKey: '5103', index: 3, title: 'Low Tide' },
    { ratingKey: '5104', index: 4, title: 'Signal Fire' },
  ],
  5200: [
    { ratingKey: '5201', index: 1, title: 'Berth 12' },
    { ratingKey: '5202', index: 2, title: 'Cargo' },
    { ratingKey: '5203', index: 3, title: 'Nightshift' },
    { ratingKey: '5204', index: 4, title: 'The Manifest' },
  ],
  5300: [
    { ratingKey: '5301', index: 1, title: 'Fold' },
    { ratingKey: '5302', index: 2, title: 'A Thousand' },
    { ratingKey: '5303', index: 3, title: 'Wingspan' },
    { ratingKey: '5304', index: 4, title: 'Release' },
  ],
};

/** A flat two-tone poster with the title on it — enough to read as artwork, invented here. */
const posterSvg = (rk: string) => {
  const m = SHOWS.find((x) => x.ratingKey === rk) ?? SHOWS[0]!;
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

const showMetadata = (m: (typeof SHOWS)[number]) => ({
  ratingKey: m.ratingKey,
  type: 'show',
  title: m.title,
  year: m.year,
  thumb: `/library/metadata/${m.ratingKey}/thumb/1`,
  leafCount: 4,
  viewedLeafCount: 0,
  updatedAt: 1,
});

const leafMetadata = (showRk: string, e: { ratingKey: string; index: number; title: string }) => ({
  ratingKey: e.ratingKey,
  type: 'episode',
  title: e.title,
  grandparentTitle: SHOWS.find((s) => s.ratingKey === showRk)?.title,
  grandparentRatingKey: showRk,
  parentIndex: 1,
  index: e.index,
  duration: 1_400_000,
  viewCount: 0,
});

// --- the stub Plex -------------------------------------------------------------------- //
const plexStub = http.createServer((req, res) => {
  const url = req.url || '';
  const photo = /\/photo\/:\/transcode\?.*[?&]url=([^&]+)/.exec(url);
  if (photo) {
    const rk = /\/library\/metadata\/(\d+)\//.exec(decodeURIComponent(photo[1] as string))?.[1] ?? '5100';
    res.setHeader('Content-Type', 'image/svg+xml');
    return res.end(posterSvg(rk));
  }
  res.setHeader('Content-Type', 'application/json');
  if (url === '/') {
    return res.end(JSON.stringify({ MediaContainer: { machineIdentifier: 'fixture-server' } }));
  }
  const leaves = /\/library\/metadata\/(\d+)\/allLeaves/.exec(url);
  if (leaves) {
    const rk = leaves[1] as string;
    return res.end(JSON.stringify({
      MediaContainer: {
        updatedAt: 1,
        leafCount: 4,
        viewedLeafCount: 0,
        Metadata: (EPISODES[rk] || []).map((e) => leafMetadata(rk, e)),
      },
    }));
  }
  if (/\/library\/sections\/\d+\/all\?/.test(url)) {
    const want = decodeURIComponent(/[?&]title=([^&]*)/.exec(url)?.[1] ?? '').toLowerCase();
    const hits = SHOWS.filter((m) => m.title.toLowerCase() === want);
    return res.end(JSON.stringify({ MediaContainer: { Metadata: hits.map(showMetadata) } }));
  }
  if (/\/library\/sections\/\d+\/collections/.test(url)) {
    return res.end(JSON.stringify({ MediaContainer: { Metadata: [] } }));
  }
  if (/\/library\/sections(\?|$)/.test(url)) {
    return res.end(JSON.stringify({
      MediaContainer: { Directory: [{ key: '1', title: 'Shows', type: 'show' }] },
    }));
  }
  const meta = /\/library\/metadata\/(\d+)/.exec(url);
  if (meta) {
    const rk = meta[1] as string;
    const show = SHOWS.find((x) => x.ratingKey === rk);
    if (show) return res.end(JSON.stringify({ MediaContainer: { Metadata: [showMetadata(show)] } }));
    for (const [showRk, eps] of Object.entries(EPISODES)) {
      const leaf = eps.find((e) => e.ratingKey === rk);
      if (leaf) {
        return res.end(JSON.stringify({ MediaContainer: { Metadata: [leafMetadata(showRk, leaf)] } }));
      }
    }
  }
  res.end(JSON.stringify({ MediaContainer: {} }));
});
await new Promise<void>((r) => plexStub.listen(0, () => r()));
const addr = plexStub.address();
if (addr === null || typeof addr === 'string') throw new Error('the stub Plex did not bind a TCP port');

const env = {
  ...process.env,
  WEB_PORT: String(PORT),
  QUEUES_PATH: '/tmp/queues-shotskipped.yaml',
  SETS_PATH: '/tmp/sets-shotskipped.yaml',
  GROUPS_PATH: '/tmp/groups-shotskipped.yaml',
  HISTORY_PATH: '/tmp/history-shotskipped.json',
  CACHE_PATH: '/tmp/cache-shotskipped.sqlite',
  PLEX_API_SERVER_URL: `http://127.0.0.1:${addr.port}`,
  PLEX_TOKEN: 'stub',
  MQTT_HOST: '',
};

await fs.writeFile(
  env.QUEUES_PATH,
  `demo:\n${SHOWS.map((m) => `- ratingKey: '${m.ratingKey}'\n  title: ${JSON.stringify(`${m.title} (${m.year})`)}`).join('\n')}\n`,
);
// A CURATED POOL (`kind: anime`) — the "members play in random order" set the owner asked
// about. The skip rule is identical on an Ordered Queue; this is the one that prompted it.
await fs.writeFile(env.SETS_PATH, `sets:
- id: demo
  label: Demo — Curated Pool
  kind: anime
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

  // The owner's UI is dark; the scheme persists to localStorage, so set it before first paint.
  const seedScheme = () => {
    try { localStorage.setItem('charcuterie-scheme', 'dark'); } catch { /* private mode */ }
  };

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1200 } });
  await ctx.addInitScript(seedScheme);
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/q/demo`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#grid li.tile .poster', { timeout: 40000 });
  await page.waitForTimeout(2500);

  // 1. BEFORE — every tile's next-up is E1.
  await page.locator('#queue').screenshot({ path: `${OUT}/skipped-before-${TAG}.png` });

  // 2. The tile menu, open on the first tile, showing the Skip row beside Remove.
  const tile = page.locator('#grid li.tile').first();
  await tile.click({ button: 'right' });
  await page.waitForSelector('#tilemenu:not([hidden])', { timeout: 10000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/skipped-menu-${TAG}.png` });

  // 3. AFTER — press Skip, then let the grid re-resolve. The tile's next-up must move to E2
  //    and the Skipped panel must appear above the grid.
  const skip = page.locator('#tilemenu button', { hasText: 'Skip' });
  if (await skip.count()) {
    await skip.first().click();
    await page.waitForSelector('.skippanel', { timeout: 40000 });
    await page.waitForTimeout(2500);
    // Expand it, so the frame shows WHAT is skipped and not only that something is.
    await page.locator('.skippanel button').first().click();
    await page.waitForSelector('.skipgrid li', { timeout: 10000 });
    const panel = page.locator('.skippanel');
    if (!(await page.locator('#grid ~ .skippanel').count())) throw new Error('Skipped is not after the active queue grid');
    await panel.locator('a', { hasText: 'Harbour Nine' }).waitFor();
    await panel.locator('.badges', { hasText: 'From Harbour Nine' }).waitFor();
    await panel.locator('button[aria-label^="Restore"]').waitFor();
    for (const [label, density] of [['Posters', 'posters'], ['List', 'rows'], ['Cards', 'cards']] as const) {
      await page.getByRole('radio', { name: label }).click();
      if (!(await page.locator('.skipgrid').evaluate((el, expected) => el.classList.contains(expected), density))) {
        throw new Error(`Skipped did not follow the ${label} density`);
      }
    }
    await page.mouse.move(2, 2);
    await page.waitForTimeout(800);
  } else {
    // On `main` there is no Skip row at all, which is the point of the BEFORE run — close the
    // menu and shoot the unchanged grid so the two tags still have three comparable frames.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }
  await page.locator('#queue').screenshot({ path: `${OUT}/skipped-after-${TAG}.png` });

  // The claim the frames alone cannot make: the queue's stored skip list is what changed, and
  // the engine reads the same field.
  const reg = await fetch(`http://localhost:${PORT}/api/sets`).then((r) => r.json());
  const demo = (reg.sets as { id: string; skipped?: string[] }[]).find((s) => s.id === 'demo');
  console.log(`stored skipped: ${JSON.stringify(demo?.skipped ?? null)}`);

  console.log(`shot: ${OUT}/skipped-{before,menu,after}-${TAG}.png`);
} finally {
  await browser.close();
  if (server) killServer(server);
  plexStub.close();
}
