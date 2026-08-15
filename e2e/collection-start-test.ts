// Engine test for the COLLECTION start floor: {series, season, episode}.
//
// `collectionItems` must skip every member BEFORE the named series, floor that member's
// episodes at {season, episode}, and leave later members untouched. Runs offline — the Plex
// client is a fake container reader, so nothing here depends on the live server.
//
// Node port of the retired e2e/collection-start-test.py (deleted with queue_builder/ on
// 2026-08-12); same six assertions against server/src/engine/resolve.js.
//
// Run:  server/node_modules/.bin/tsx e2e/collection-start-test.ts   (from the repo root; non-zero on failure)
import * as resolve from '../server/src/engine/resolve.js';
import type { ResolvedItem } from '../server/src/engine/resolve.js';
import type { PlexClient, Start } from '../server/src/types.js';

const FAILS: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && detail ? `  -- ${detail}` : ''));
  if (!cond) FAILS.push(name);
}

const CHILDREN = [
  { ratingKey: '100', type: 'show', title: 'Series One' },
  { ratingKey: '200', type: 'show', title: 'Series Two' },
  { ratingKey: '300', type: 'movie', title: 'The Movie' },
];

// 3 episodes per series, ratingKeys <rk><ep> — enough to see a floor bite.
const episodes = (rk: string) => [1, 2, 3].map((i) => ({
  ratingKey: `${rk}${i}`,
  title: `ep${i}`,
  grandparentTitle: `Show ${rk}`,
  parentIndex: 1,
  index: i,
  duration: 1000,
  type: 'episode',
}));

// The only Plex surface collectionItems touches: collections search, children, allLeaves.
const client: PlexClient = {
  async container(path) {
    if (path.includes('/collections?')) return { Metadata: [{ ratingKey: '999', title: 'Anything' }] };
    if (path.startsWith('/library/collections/999/children')) return { Metadata: CHILDREN };
    const m = path.match(/\/library\/metadata\/(\d+)\/allLeaves/);
    // The capture group is inside the `if (m)`, so `m[1]` is present whenever we get here.
    if (m) return { Metadata: episodes(m[1]!) };
    throw new Error(`unexpected path ${path}`);
  },
  async accountToken() { return null; },
};

const CFG = { queue_sections: [11] };
// `collectionItems` returns null only for a collection it cannot FIND, and every call below
// names the one the fake client always answers — so the reads are non-null by construction.
const keys = (items: readonly ResolvedItem[] | null) => items!.map((i) => i.ratingKey);
const items = (start: Start | null) =>
  resolve.collectionItems(client, CFG, 'Anything', new Set(), null, start);

// No start: everything, in collection order.
const all = await items(null);
ok('no start -> every member, in order',
  JSON.stringify(keys(all)) === JSON.stringify(['1001', '1002', '1003', '2001', '2002', '2003', '300']),
  JSON.stringify(keys(all)));

// Start at the SECOND series, episode 2: series one is skipped entirely, series two starts at
// its episode 2, and the movie after it is untouched.
const floored = await items({ series: '200', season: 1, episode: 2 });
ok('start floors the collection at the named member',
  JSON.stringify(keys(floored)) === JSON.stringify(['2002', '2003', '300']), JSON.stringify(keys(floored)));

// The member may be named by TITLE (a hand-written YAML entry), not just by ratingKey.
const byTitle = await items({ series: 'Series Two', episode: 3 });
ok('member can be named by title',
  JSON.stringify(keys(byTitle)) === JSON.stringify(['2003', '300']), JSON.stringify(keys(byTitle)));

// A start naming a MOVIE member has no episode — it just skips what comes before it.
const movieStart = await items({ series: '300' });
ok('movie member start skips the earlier members',
  JSON.stringify(keys(movieStart)) === JSON.stringify(['300']), JSON.stringify(keys(movieStart)));

// An unknown member is ignored rather than emptying the collection (a renamed/removed series
// must not silently stop the queue).
const unknown = await items({ series: '404', episode: 2 });
ok('unknown member -> no floor, plays normally',
  JSON.stringify(keys(unknown)) === JSON.stringify(keys(all)), JSON.stringify(keys(unknown)));

// The floor never marks anything watched — it only removes earlier items from the pick, and
// already-watched ones still drop out normally.
const withWatched = await resolve.collectionItems(
  client, CFG, 'Anything', new Set(['2002']), null, { series: '200', season: 1, episode: 2 },
);
ok('watched items still drop out at/after the floor',
  JSON.stringify(keys(withWatched)) === JSON.stringify(['2003', '300']), JSON.stringify(keys(withWatched)));

console.log(FAILS.length ? `FAILURES: ${FAILS.length}` : 'done');
process.exit(FAILS.length ? 1 : 0);
