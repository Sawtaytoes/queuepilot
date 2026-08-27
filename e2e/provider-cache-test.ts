// A warm /api/queues makes NO provider call, and `?fresh=1` is the only thing that does.
//
// What this pins, and why it is worth a gate: the page was 5.1 s warm because turning one
// queue ENTRY into one item had no cache at all. Measured on the live registry — 566 provider
// calls per warm page load, 339 of them `/library/metadata/<rk>`, one per entry, every single
// time. The SQLite cache covered episode lists, collection children, title lookups and section
// listings, and missed the hottest path in the app
// (decision `2026-08-26-a-provider-read-is-cached-and-the-page-revalidates-after-it-paints`).
//
// Five claims:
//   1. a COLD /api/queues reads the providers, because it has to;
//   2. a WARM one resolves every entry with no provider call of its own — the whole point.
//      One call remains and is a DIFFERENT decision's: the show-leaves validator;
//   3. `?fresh=1` reads them again, which is what makes the cached answer safe to serve;
//   4. and it PICKS UP a change made behind the app's back, which is what the browser's
//      phase-3 pass exists to do;
//   5. the cached and the fresh payload agree when nothing changed. A cache that is fast and
//      wrong is worse than the 5.1 s it replaced.
//
// Counting, not timing: a wall-clock assertion in CI is a flake. `countingPlex` and
// `countingKavita` tally every request their stubs answer.
//
// Every byte is fixture data; the repo is public.
//
// Run:  server/node_modules/.bin/tsx e2e/provider-cache-test.ts
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const PORT = parseInt(process.env.WEB_PORT_PCACHE || '18902', 10);
const PLEX_PORT = parseInt(process.env.STUB_PLEX_PORT_PCACHE || '18903', 10);
const BASE = `http://localhost:${PORT}`;
const TMP = `/tmp/qp-pcache-${process.pid}`;

const FAILS: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && detail ? `  -- ${detail}` : ''));
  if (!cond) FAILS.push(name);
}

const MIN = 60_000;
const MOVIES = 1;
const SHOWS = 5;

/** Two films and a show, in one curated queue. The show gives `nextEpisode` something to do. */
const ITEMS: Record<string, Record<string, unknown>> = {
  7001: { ratingKey: '7001', type: 'movie', title: 'A Trip to the Moon', year: 1902, duration: 13 * MIN, librarySectionID: MOVIES },
  7002: { ratingKey: '7002', type: 'movie', title: 'The Cabinet of Dr. Caligari', year: 1920, duration: 76 * MIN, librarySectionID: MOVIES },
  7003: { ratingKey: '7003', type: 'show', title: 'The Lighthouse Keeper', year: 1921, librarySectionID: SHOWS, leafCount: 2, viewedLeafCount: 0, updatedAt: 1_755_000_000 },
};

const EPISODES = [
  { ratingKey: '7031', type: 'episode', title: 'First Light', parentIndex: 1, index: 1, duration: 24 * MIN, grandparentTitle: 'The Lighthouse Keeper' },
  { ratingKey: '7032', type: 'episode', title: 'The Long Night', parentIndex: 1, index: 2, duration: 24 * MIN, grandparentTitle: 'The Lighthouse Keeper' },
];

const QUEUES_YAML = `bob:
- {ratingKey: "7001", title: "A Trip to the Moon (1902)"}
- {ratingKey: "7002", title: "The Cabinet of Dr. Caligari (1920)"}
- {ratingKey: "7003", title: "The Lighthouse Keeper (1921)"}
`;

const SETS_YAML = `sets:
  - id: bob
    label: Bob — Movies
    kind: picks
    source: queue
    add_as: priority
    sections: [${MOVIES}, ${SHOWS}]
`;

/** A stub Plex that COUNTS what it is asked for, and can have its titles changed mid-run. */
function countingPlex(port: number) {
  const counts = { metadata: 0, total: 0 };
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    counts.total++;
    const send = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const wrap = (rows: unknown[], extra: Record<string, unknown> = {}) => send({
      MediaContainer: { size: rows.length, Metadata: rows, ...extra },
    });
    if (url.pathname === '/library/sections') {
      return send({
        MediaContainer: {
          size: 2,
          Directory: [
            { key: String(MOVIES), title: 'Movies', type: 'movie', agent: 'tv.plex.agents.movie' },
            { key: String(SHOWS), title: 'Series', type: 'show', agent: 'tv.plex.agents.series' },
          ],
        },
      });
    }
    if (/^\/library\/sections\/\d+\/collections$/.test(url.pathname)) return wrap([]);
    if (/^\/library\/sections\/\d+\/all$/.test(url.pathname)) return wrap(Object.values(ITEMS));
    if (url.pathname === '/library/metadata/7003/allLeaves') return wrap(EPISODES);
    const meta = /^\/library\/metadata\/([\d,]+)$/.exec(url.pathname);
    if (meta) {
      counts.metadata++;
      const want = new Set(String(meta[1]).split(','));
      return wrap(Object.values(ITEMS).filter((m) => want.has(String(m.ratingKey))));
    }
    return send({ MediaContainer: { size: 0 } });
  });
  const listening = new Promise<void>((resolve) => { server.listen(port, '127.0.0.1', () => resolve()); });
  return {
    counts,
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

/** Every tile's title, flattened — what the assertions below compare. */
type QueuesBody = { sets: Record<string, { items: { title?: string }[] }> };
const titles = (body: QueuesBody): string[] => Object
  .values(body.sets)
  .flatMap((s) => s.items.map((i) => String(i.title ?? '')));

await fs.mkdir(TMP, { recursive: true });
await fs.writeFile(`${TMP}/queues.yaml`, QUEUES_YAML);
await fs.writeFile(`${TMP}/sets.yaml`, SETS_YAML);

const plex = countingPlex(PLEX_PORT);
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

  // --- claim 1: a cold read talks to Plex --------------------------------------------- //
  plex.counts.metadata = 0;
  const cold = await (await fetch(`${BASE}/api/queues`)).json() as QueuesBody;
  const coldMeta = plex.counts.metadata;
  ok(
    'a COLD /api/queues resolves its entries against Plex',
    coldMeta >= 3,
    `metadata reads: ${coldMeta}`,
  );
  ok(
    'and it resolves every entry',
    titles(cold).length === 3 && titles(cold).includes('A Trip to the Moon'),
    titles(cold).join(' | '),
  );

  // --- claim 2: a warm read resolves nothing against Plex ------------------------------ //
  //
  // ONE metadata read is expected and is not this cache's: `allLeaves` validates a cached
  // episode list against the show's live (updatedAt, viewedLeafCount) on every read, so an
  // episode watched outside the app self-heals at once
  // (decision `2026-08-07-leaves-cache-revalidates-on-read`). The fixture holds one show, so
  // one call. What must be zero is the ENTRY-RESOLUTION read this cache owns — three entries
  // resolved, and the two films cost nothing at all.
  //
  // Asserted as an exact count rather than "fewer than cold": skipping the leaves validator
  // here was tried on 2026-08-26 and reverted, because the ENGINE reads through the same
  // function and a stale answer there gets queued and played rather than merely displayed. A
  // ceiling would have let that back in silently.
  plex.counts.metadata = 0;
  const warm = await (await fetch(`${BASE}/api/queues`)).json() as QueuesBody;
  ok(
    'a WARM /api/queues resolves every entry with NO read of its own',
    plex.counts.metadata === 1,
    `metadata reads: ${plex.counts.metadata} (1 = the show-leaves validator, 0 = the entries)`,
  );
  ok(
    'and it still answers with every tile',
    titles(warm).join('|') === titles(cold).join('|'),
    titles(warm).join(' | '),
  );

  // --- claim 3 + 5: the revalidation pass re-reads, and agrees ------------------------ //
  plex.counts.metadata = 0;
  const fresh = await (await fetch(`${BASE}/api/queues?fresh=1`)).json() as QueuesBody;
  ok(
    'GET /api/queues?fresh=1 reads Plex again',
    plex.counts.metadata >= 3,
    `metadata reads: ${plex.counts.metadata}`,
  );
  ok(
    'and the cached answer was not wrong — same tiles, nothing having changed',
    titles(fresh).join('|') === titles(warm).join('|'),
    `${titles(warm).join(' | ')}  vs  ${titles(fresh).join(' | ')}`,
  );

  // --- claim 4: a change behind the app's back reaches the fresh pass ------------------ //
  // A rename in Plex moves no timestamp this app reads and is invisible to every cache above
  // — which is exactly the sort of change phase 3 exists to catch.
  ITEMS['7001'] = { ...ITEMS['7001'], title: 'Le Voyage dans la Lune' };

  const stillCached = await (await fetch(`${BASE}/api/queues`)).json() as QueuesBody;
  ok(
    'the cached read does NOT see it — which is the trade this design makes',
    titles(stillCached).includes('A Trip to the Moon'),
    titles(stillCached).join(' | '),
  );

  const refreshed = await (await fetch(`${BASE}/api/queues?fresh=1`)).json() as QueuesBody;
  ok(
    'the fresh pass DOES see it',
    titles(refreshed).includes('Le Voyage dans la Lune'),
    titles(refreshed).join(' | '),
  );

  const afterRefresh = await (await fetch(`${BASE}/api/queues`)).json() as QueuesBody;
  ok(
    'and it wrote the correction back, so the next cached read is right too',
    titles(afterRefresh).includes('Le Voyage dans la Lune'),
    titles(afterRefresh).join(' | '),
  );
} finally {
  killServer(srv);
  await plex.close();
  await fs.rm(TMP, { recursive: true, force: true });
}

console.log(FAILS.length ? `\n${FAILS.length} FAILED: ${FAILS.join(', ')}` : '\nall passed');
process.exit(FAILS.length ? 1 : 0);
