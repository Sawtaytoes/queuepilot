// Leaves cache re-validates on read (browserless, self-contained: spawns its OWN fake Plex on a
// private port, points plex.js at it, uses a private /tmp cache DB). Regression for the bug where
// an episode finished OUTSIDE the app's flow (a manual Plex play / another client) left the tile
// on a stale next-up for up to the 24 h TTL — because allLeaves served the cached episodes without
// checking the show's live watch aggregate, and only cache.dropLeaves (MQTT now-playing) or the
// TTL could bust it. (decision 2026-08-07-leaves-cache-revalidates-on-read)
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';

const PORT = 18796;
const DB = '/tmp/leaves-revalidate.sqlite';
for (const f of [DB, DB + '-wal', DB + '-shm']) await fs.rm(f, { force: true });

const ok = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); if (!c) process.exitCode = 1; };

// --- fake Plex: a mutable show whose episodes + aggregate we flip mid-test -------------------
const RK = '9001';
/** One leaf as this fake Plex serves it. `viewCount` is ABSENT at 0, exactly as Plex omits it. */
interface FakeLeaf {
  type: string;
  ratingKey: string;
  parentIndex: number;
  index: number;
  title: string;
  duration: number;
  viewCount?: number;
}
const ep = (index: number, viewCount: number): FakeLeaf => ({
  type: 'episode', ratingKey: `${RK}${index}`, parentIndex: 1, index,
  title: `Ep ${index}`, duration: 1_400_000, ...(viewCount ? { viewCount } : {}),
});
// Start: E1,E2 watched; E3 unwatched. Aggregate viewedLeafCount = 2.
const state: {
  leaves: FakeLeaf[];
  updatedAt: number;
  allLeavesHits: number;
  aggregateHits: number;
  /** Flipped mid-test to drive the offline-fallback case; absent means "aggregate is up". */
  failAggregate?: boolean;
} = {
  leaves: [ep(1, 1), ep(2, 1), ep(3, 0)],
  updatedAt: 1000,
  allLeavesHits: 0,
  aggregateHits: 0,
};
const viewed = () => state.leaves.filter((e) => (e.viewCount ?? 0) > 0).length;

const srv = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  const url = (req.url || '').split('?')[0];
  if (url === `/library/metadata/${RK}/allLeaves`) {
    state.allLeavesHits += 1;
    res.end(JSON.stringify({ MediaContainer: { size: state.leaves.length, Metadata: state.leaves } }));
    return;
  }
  if (url === `/library/metadata/${RK}`) {
    state.aggregateHits += 1;
    if (state.failAggregate) { res.statusCode = 500; res.end('{}'); return; }
    // The show NODE reports the aggregate the allLeaves container omits.
    res.end(JSON.stringify({ MediaContainer: { Metadata: [{
      type: 'show', ratingKey: RK, leafCount: state.leaves.length,
      viewedLeafCount: viewed(), updatedAt: state.updatedAt,
    }] } }));
    return;
  }
  res.statusCode = 404; res.end('{}');
});
await new Promise<void>((r) => srv.listen(PORT, () => r()));

process.env.PLEX_API_SERVER_URL = `http://127.0.0.1:${PORT}`;
process.env.PLEX_TOKEN = 'test-token';
process.env.CACHE_PATH = DB;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Import AFTER env is set (config.js/env.js read process.env at module load).
const cache = await import('../server/src/cache.js');
const plex = await import('../server/src/plex.js');
await cache.init();

try {
  // 1) Cold read → fetches allLeaves once, next-up is the first unwatched (E3).
  let n = await plex.nextEpisode(RK);
  ok(`cold read picks E3 (got E${n?.episode})`, n?.episode === 3);
  ok(`cold read fetched allLeaves once (hits=${state.allLeavesHits})`, state.allLeavesHits === 1);

  // 2) Warm read, nothing changed → served from cache, NO second allLeaves fetch (the aggregate
  //    validator matched). The light aggregate call is allowed; the expensive one is not.
  n = await plex.nextEpisode(RK);
  ok(`warm read still E3 (got E${n?.episode})`, n?.episode === 3);
  ok(`warm unchanged did NOT refetch allLeaves (hits=${state.allLeavesHits})`, state.allLeavesHits === 1);

  // 3) OUT-OF-BAND completion: E3 is watched elsewhere (no MQTT drop). Aggregate viewedLeafCount
  //    goes 2→3. The next read must self-heal: refetch allLeaves and advance to E4.
  state.leaves = [ep(1, 1), ep(2, 1), ep(3, 1), ep(4, 0)];
  n = await plex.nextEpisode(RK);
  ok(`out-of-band watch self-heals to E4 (got E${n?.episode})`, n?.episode === 4);
  ok(`changed aggregate DID refetch allLeaves (hits=${state.allLeavesHits})`, state.allLeavesHits === 2);

  // 4) Offline fallback: the aggregate call fails → validator is null → the TTL path serves the
  //    last-known cached episodes (no throw, no refetch). Degraded behaviour is unchanged.
  state.failAggregate = true;
  const before = state.allLeavesHits;
  n = await plex.nextEpisode(RK);
  ok(`aggregate-down still serves cached next-up (got E${n?.episode})`, n?.episode === 4);
  ok(`aggregate-down did NOT refetch allLeaves (hits=${state.allLeavesHits})`, state.allLeavesHits === before);
} finally {
  srv.close();
}
console.log('done');
