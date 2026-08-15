// Offline gate: a READING queue's artwork and tiles come from its provider, not from Plex.
//
// The bug this pins, reported from the live app 2026-08-15 — a search dropdown of broken-image
// glyphs on the `manga_webtoons` channel, one row per Kavita series. The cover PROXY had
// shipped (PR 76, /api/providers/:id/cover/:itemId) and worked; nothing ever called it. The
// frontend's only move was `/api/thumb/<ratingKey>`, which is PLEX's poster proxy, so every
// reading result asked Plex about a Kavita seriesId and got a 502.
//
// The same provider-blindness sat one layer deeper, where it was invisible only because the
// queue was still empty: /api/queues resolved EVERY entry through Plex, so a reading entry
// would have come back `resolved: false, ratingKey: null` — a tile with no artwork and no
// next-up, which looks like missing art rather than like a resolver that answered the wrong
// backend.
//
// So both are pinned here, over one queue and one channel:
//   * /api/search sends a `cover` URL for a pull set (and the URL actually serves bytes)
//   * /api/queues + /api/sets/:id/members resolve through the provider — title, cover,
//     next-up chapter, and `unit: chapter` so the tile says "Ch 113" and not "E113"
//   * a series that has VANISHED from Kavita degrades to an unresolved tile rather than
//     taking the whole response down with it
//
// Self-contained: spawns its own server on a private port against a STUB Kavita on
// 127.0.0.1, so it needs no token, no network and no Kavita. Plex is pointed at a dead port,
// which is also the proof that none of this touches Plex.
//
// Run:  server/node_modules/.bin/tsx e2e/kavita-covers-test.ts   (from the repo root; non-zero on failure)
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { killServer, spawnServer } from './stubs/server-process.mjs';

/**
 * A JSON body off the API — same call as api-v2-test.ts makes, for the same reason:
 * `Response.json()` is honestly `unknown`, and every assertion below reads deep into a payload
 * the server itself produces (`sets.manga.items[…].nextEp.episode`). Re-declaring each route's
 * response shape here would be a second copy of server/src/routes that rots on its own, so the
 * cast lives HERE, once, and the reads are deliberately unchecked.
 */
type JsonBody = Record<string, any>;

const PORT = 18781;
const QUEUES = '/tmp/queues-kvcovers.yaml';
const SETS = '/tmp/sets-kvcovers.yaml';
const HIST = '/tmp/history-kvcovers.json';
const PROVIDERS = '/tmp/providers-kvcovers.yaml';
const SECRETS = '/tmp/providers-secrets-kvcovers.yaml';

const ok = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); if (!c) process.exitCode = 1; };

// --------------------------------------------------------------------------- //
// The stub Kavita — only the endpoints these routes reach, shaped like the live ones
// (docs/kavita-feasibility.md §2). A one-pixel PNG stands in for the cover bytes.
// --------------------------------------------------------------------------- //
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
/** A series row as `Search/search` and `Series/{id}` return it. */
interface StubSeries { id: number; name: string; libraryId: number; format: number }
/** A ChapterDto slice — the fields the tiles resolver reads. */
interface StubChapter {
  id: number;
  number: string;
  minNumber: number;
  title: string;
  pages: number;
  pagesRead: number;
}
/** `Series/series-detail`'s body. */
interface StubDetail { unreadCount?: number; chapters: StubChapter[]; specials: StubChapter[] }

// Keyed by the string form: a query parameter and a path capture are both strings, and these
// tables are only ever indexed by one of those.
const SERIES: Record<string, StubSeries> = {
  599: { id: 599, name: 'Dungeon Porter', libraryId: 5, format: 1 },
  149: { id: 149, name: 'Tower Dungeon', libraryId: 2, format: 1 },
  900: { id: 900, name: 'Finished Series', libraryId: 5, format: 1 },
};
const DETAIL: Record<string, StubDetail> = {
  // Two unread chapters; the lower number must lead, and its own title is just the number.
  599: { unreadCount: 2, chapters: [
    { id: 9002, number: '114', minNumber: 114, title: '114', pages: 20, pagesRead: 0 },
    { id: 9001, number: '113', minNumber: 113, title: "The Tower's Bottom", pages: 20, pagesRead: 6 },
  ], specials: [] },
  149: { unreadCount: 1, chapters: [
    { id: 9010, number: '7', minNumber: 7, title: '7', pages: 30, pagesRead: 0 },
  ], specials: [] },
  // Every chapter read: the tile must say "All read", not re-serve chapter 1.
  900: { unreadCount: 0, chapters: [
    { id: 9020, number: '1', minNumber: 1, title: '1', pages: 50, pagesRead: 50 },
  ], specials: [] },
};
const KAVITA_HITS: string[] = [];

const kavita = createServer((req: IncomingMessage, res: ServerResponse) => {
  // Node only omits `req.url` for a request that never had a request line; every call here
  // is an ordinary GET, and an empty path would 404 out of the bottom of this handler anyway.
  const url = new URL(req.url ?? '/', 'http://kavita.stub');
  KAVITA_HITS.push(url.pathname);
  const json = (body: unknown) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  };
  if (url.pathname === '/api/Plugin/authenticate') return json({ token: 'stub-jwt', username: 'bob' });
  if (url.pathname === '/api/Search/search') {
    const q = (url.searchParams.get('queryString') || '').toLowerCase();
    return json({
      series: Object.values(SERIES)
        .filter((s) => s.name.toLowerCase().includes(q))
        .map((s) => ({ seriesId: s.id, name: s.name, libraryId: s.libraryId, libraryName: 'Webtoons', format: s.format })),
    });
  }
  if (url.pathname === '/api/Series/series-detail') {
    // `String(null)` is 'null' — a key no series has — so a missing `seriesId` still lands on
    // the empty fallback, exactly as indexing with the raw null did.
    return json(DETAIL[String(url.searchParams.get('seriesId'))] ?? { chapters: [], specials: [] });
  }
  if (url.pathname === '/api/Image/series-cover') {
    // The API key is a QUERY PARAMETER here — the whole reason the app re-serves these bytes.
    if (!url.searchParams.get('apiKey')) { res.statusCode = 401; return res.end(); }
    res.setHeader('Content-Type', 'image/png');
    return res.end(PNG);
  }
  const m = url.pathname.match(/^\/api\/Series\/(\d+)$/);
  if (m) {
    // The capture group is inside the `if (m)`, so `m[1]` is present here.
    const s = SERIES[m[1]!];
    if (!s) { res.statusCode = 404; return res.end(); }
    return json(s);
  }
  res.statusCode = 404;
  res.end();
});
await new Promise<void>((r) => { kavita.listen(0, '127.0.0.1', () => r()); });
// `address()` is `string | AddressInfo | null`; a TCP listen always yields the object form,
// and the throw is the honest read of "the stub never bound" rather than a cast.
const kavitaAddress = kavita.address();
if (kavitaAddress === null || typeof kavitaAddress === 'string') {
  throw new Error('the stub Kavita did not bind a TCP port');
}
const KAVITA_URL = `http://127.0.0.1:${kavitaAddress.port}`;

// --------------------------------------------------------------------------- //
// The app under test
// --------------------------------------------------------------------------- //
// A reading QUEUE (three entries, one of them a series the stub has never heard of) and a
// reading CHANNEL (members, the other resolver). `9999` is the vanished-series case.
await fs.writeFile(QUEUES, [
  'manga:',
  '- {ratingKey: 599, title: Dungeon Porter}',
  '- {ratingKey: 900, title: Finished Series}',
  '- {ratingKey: 9999, title: Deleted From Kavita}',
  '',
].join('\n'), 'utf8');
await fs.writeFile(SETS, [
  'sets:',
  '  - id: manga',
  '    label: Manga & Webtoons',
  '    kind: anime',
  '    source: queue',
  '    sections: []',
  '    providers:',
  '      - provider: kavita',
  '        libraries: ["2", "5"]',
  '  - id: reading_channel',
  '    label: Reading Channel',
  '    kind: anime',
  '    source: rotation',
  '    sections: []',
  '    members: [{ratingKey: 149, title: Tower Dungeon}]',
  '    providers:',
  '      - provider: kavita',
  '        libraries: ["2", "5"]',
  '',
].join('\n'), 'utf8');
for (const f of [HIST, PROVIDERS, SECRETS]) await fs.rm(f, { force: true });

const env = {
  ...process.env,
  WEB_PORT: String(PORT),
  QUEUES_PATH: QUEUES,
  SETS_PATH: SETS,
  HISTORY_PATH: HIST,
  PROVIDERS_PATH: PROVIDERS,
  PROVIDERS_SECRETS_PATH: SECRETS,
  CACHE_PATH: '/tmp/cache-kvcovers.sqlite',
  KAVITA_API_SERVER_URL: KAVITA_URL,
  KAVITA_API_KEY: 'offline-test-key',
  // Plex is DEAD here on purpose: every assertion below must hold with no Plex at all.
  PLEX_API_SERVER_URL: 'https://127.0.0.1:1',
  PLEX_TOKEN: '',
  MQTT_HOST: '',
  NODE_TLS_REJECT_UNAUTHORIZED: '0',
};

const api = (p: string, opts?: RequestInit): Promise<Response> =>
  fetch(`http://localhost:${PORT}/api${p}`, opts);
const json = (p: string, opts?: RequestInit): Promise<JsonBody> =>
  api(p, opts).then((r) => r.json() as Promise<JsonBody>);

// The Express entry point is gone and server/src is TypeScript — `spawnServer` is what knows
// to run server/src/index.ts through tsx, and (with `killServer` below) what keeps the node
// grandchild behind the tsx wrapper from outliving this run and squatting the port.
const child = spawnServer({ env, stdio: 'ignore' });
for (let i = 0; i < 50; i++) {
  try { await json('/history'); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
}

try {
  // --- search ---------------------------------------------------------------- //
  const { results } = await json('/search?set=manga&q=dungeon');
  ok(`search finds both Dungeon series (${results.length})`, results.length === 2);
  const porter = results.find((r: JsonBody) => r.title === 'Dungeon Porter');
  ok(
    `every result carries a cover URL (${porter?.cover})`,
    results.every((r: JsonBody) => r.cover === `/api/providers/kavita/cover/${r.ratingKey}`),
  );
  // The URL is worth nothing if it does not serve bytes — that is the whole bug.
  // `porter.cover` is a whole path, as the browser would use it — not an /api suffix.
  const img = await fetch(`http://localhost:${PORT}${porter.cover}`);
  ok(`the cover URL serves an image (${img.status} ${img.headers.get('content-type')})`,
    img.status === 200 && String(img.headers.get('content-type')).startsWith('image/'));
  const raw = await api(`/thumb/${porter.ratingKey}?v=2`);
  ok(`/api/thumb still refuses a Kavita id (${raw.status})`, raw.status >= 400);

  // --- the queue grid -------------------------------------------------------- //
  const items = (await json('/queues')).sets.manga.items;
  ok(`the reading queue resolves its 3 entries (${items.length})`, items.length === 3);

  const dp = items.find((i: JsonBody) => i.key.includes('599') || i.title === 'Dungeon Porter');
  ok('a reading entry RESOLVES (it used to be Plex-resolved, i.e. never)', dp?.resolved === true);
  ok(`its title comes from Kavita (${dp?.title})`, dp?.title === 'Dungeon Porter');
  ok(`its poster is the provider cover (${dp?.cover})`, dp?.cover === '/api/providers/kavita/cover/599');
  ok(`it counts chapters (${dp?.unit})`, dp?.unit === 'chapter');
  ok(`next-up is the LOWEST unread chapter (${dp?.nextEp?.episode})`, dp?.nextEp?.episode === 113);
  ok('a part-read chapter reads as in progress', dp?.partiallyWatched === true);
  ok('no season is invented for a chapter', dp?.nextEp?.season === null && dp?.nextEp?.multiSeason === false);

  const fin = items.find((i: JsonBody) => i.title === 'Finished Series');
  ok('a fully-read series resolves with nothing next', fin?.resolved === true && fin?.nextEp === null);

  const gone = items.find((i: JsonBody) => i.title === 'Deleted From Kavita');
  ok('a vanished series degrades to its stored title', gone?.resolved === false && gone?.ratingKey === null);
  ok('…and does not take the other entries with it', items.filter((i: JsonBody) => i.resolved).length === 2);

  // --- the channel's member grid --------------------------------------------- //
  const { members } = await json('/sets/reading_channel/members');
  ok(`the reading channel resolves its member (${members?.length})`, members?.length === 1);
  ok(`the member has provider artwork (${members?.[0]?.cover})`,
    members?.[0]?.cover === '/api/providers/kavita/cover/149');
  ok(`…and its own next chapter (${members?.[0]?.nextEp?.episode})`, members?.[0]?.nextEp?.episode === 7);

  // --- the credential ---------------------------------------------------------- //
  // The API key is a query parameter on Kavita's image endpoint, so the ONE thing that must
  // never happen is the browser being handed that URL instead of these bytes.
  const bodies = JSON.stringify([results, items, members]);
  ok('no API key anywhere in a browser-reachable response', !bodies.includes('offline-test-key'));
  ok('no Kavita URL escapes into a response', !bodies.includes(KAVITA_URL));
  ok('the covers were actually fetched FROM Kavita', KAVITA_HITS.includes('/api/Image/series-cover'));
} finally {
  await new Promise<void>((r) => { child.once('exit', () => r()); killServer(child); });
  kavita.close();
}
