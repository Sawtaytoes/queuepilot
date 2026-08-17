// A COLLECTION's members are read and cached PER ACCOUNT (browserless, self-contained: spawns
// its own fake Plex whose watched state varies by the request's X-Plex-Token, points plex.js at
// it, uses a private /tmp cache DB).
//
// THE BUG THIS PINS (live, 2026-08-16, reported after the curated-queue profile fix landed).
// `collectionChildren()` took no AccountScope: it read `/library/collections/<rk>/children` with
// the ADMIN token, called `episodeCounts()` with no opts, and cached the result under `rk` alone.
// So the "Start from…" series picker on the Carol 1 queue — gated to Older Kids — printed
// **"1. Dragon Ball 154/155 watched · 2. Dragon Ball Z 176/291 watched"**. Those are the OWNER's
// numbers; Older Kids is 45/155 and 0/291. The tile above it already said E36 by then, so the
// modal contradicted the tile it was opened from.
//
// Three fields on a member row are the querying account's own, and all three leaked:
//   * a show member's viewedLeafCount — the "N/M watched" chip;
//   * a movie member's `watched`, which `collectionNext()` uses to SKIP a member outright;
//   * a movie member's viewOffset (its resume point).
//
// Run:  server/node_modules/.bin/tsx e2e/collection-children-per-account-test.ts
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';

const PORT = 18799;
const DB = '/tmp/collection-children-per-account.sqlite';
for (const f of [DB, DB + '-wal', DB + '-shm']) await fs.rm(f, { force: true });

const ok = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); if (!c) process.exitCode = 1; };

// --- fake Plex ------------------------------------------------------------------------- //
// A collection shaped like the live one that reported this: a SHOW first, then a MOVIE.
const COLL = '5000';
const SHOW = '5001';
const MOVIE = '5002';

// Admin watched 2 of the show's 3 episodes AND the movie. The kid watched neither.
const WATCHED_EPS: Record<string, Set<number>> = {
  'admin-token': new Set([1, 2]),
  'kid-token': new Set(),
};
const MOVIE_SEEN: Record<string, boolean> = { 'admin-token': true, 'kid-token': false };

interface FakeLeaf {
  type: string; ratingKey: string; parentIndex: number; index: number;
  title: string; duration: number; viewCount?: number;
}
const ep = (index: number, watched: boolean | undefined): FakeLeaf => ({
  type: 'episode', ratingKey: `${SHOW}${index}`, parentIndex: 1, index,
  title: `Ep ${index}`, duration: 1_400_000, ...(watched ? { viewCount: 1 } : {}),
});

const childrenHits: Record<string, number> = { 'admin-token': 0, 'kid-token': 0 };

const srv = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  const url = (req.url || '').split('?')[0];
  const tok = String(req.headers['x-plex-token'] || 'admin-token');
  const seenEps = WATCHED_EPS[tok] ?? new Set<number>();

  if (url === `/library/collections/${COLL}/children`) {
    childrenHits[tok] = (childrenHits[tok] || 0) + 1;
    res.end(JSON.stringify({ MediaContainer: {
      updatedAt: 1000, childCount: 2,
      Metadata: [
        // A show child carries Plex's raw aggregate; the app recomputes it from allLeaves.
        { type: 'show', ratingKey: SHOW, title: 'The Show', year: 1986,
          leafCount: 3, viewedLeafCount: seenEps.size },
        // A movie child is "watched" by its own viewCount, and carries its own resume point.
        { type: 'movie', ratingKey: MOVIE, title: 'The Movie', year: 1989,
          duration: 5_400_000,
          ...(MOVIE_SEEN[tok] ? { viewCount: 1 } : { viewOffset: 60_000 }) },
      ],
    } }));
    return;
  }
  if (url === `/library/metadata/${SHOW}/allLeaves`) {
    const leaves = [1, 2, 3].map((i) => ep(i, seenEps.has(i)));
    res.end(JSON.stringify({ MediaContainer: { size: leaves.length, Metadata: leaves } }));
    return;
  }
  if (url === `/library/metadata/${SHOW}`) {
    res.end(JSON.stringify({ MediaContainer: { Metadata: [{
      type: 'show', ratingKey: SHOW, leafCount: 3, viewedLeafCount: seenEps.size, updatedAt: 1000,
    }] } }));
    return;
  }
  res.statusCode = 404; res.end('{}');
});
await new Promise<void>((r) => srv.listen(PORT, () => r()));

process.env.PLEX_API_SERVER_URL = `http://127.0.0.1:${PORT}`;
process.env.PLEX_TOKEN = 'admin-token'; // the default (no-account) token
process.env.CACHE_PATH = DB;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Imported AFTER the env above: config.js/env.js snapshot process.env at module load.
const cache = await import('../server/src/cache.js');
const plex = await import('../server/src/plex.js');
await cache.init();

const KID = { token: 'kid-token', account: 'kid-uuid' };

try {
  // 1) Admin read (no opts) — the owner's view, which is what this always returned.
  let kids = await plex.collectionChildren(COLL);
  ok(`admin show member reads 2/3 watched (got ${kids?.[0]?.viewedLeafCount}/${kids?.[0]?.leafCount})`,
    kids?.[0]?.viewedLeafCount === 2 && kids?.[0]?.leafCount === 3);
  ok('admin movie member is watched', kids?.[1]?.watched === true);
  ok(`admin fetched children once (hits=${childrenHits['admin-token']})`, childrenHits['admin-token'] === 1);

  // 2) Kid read — its OWN counts, and its own fetch. This is the whole bug: before the fix the
  //    admin row was served here and the kid saw 2/3 + watched.
  kids = await plex.collectionChildren(COLL, KID);
  ok(`kid show member reads 0/3 watched (got ${kids?.[0]?.viewedLeafCount}/${kids?.[0]?.leafCount})`,
    kids?.[0]?.viewedLeafCount === 0 && kids?.[0]?.leafCount === 3);
  ok('kid movie member is NOT watched', kids?.[1]?.watched === false);
  ok(`kid movie member keeps its OWN resume point (got ${kids?.[1]?.viewOffset})`,
    kids?.[1]?.viewOffset === 60_000);
  ok(`kid fetched its OWN children (hits=${childrenHits['kid-token']})`, childrenHits['kid-token'] === 1);

  // 3) Warm reads on both sides: each is served from its own row, and neither clobbered the
  //    other. A shared key would show up here as a refetch or as the wrong numbers.
  kids = await plex.collectionChildren(COLL, KID);
  ok(`kid warm still 0/3 (got ${kids?.[0]?.viewedLeafCount}/3)`, kids?.[0]?.viewedLeafCount === 0);
  ok(`kid warm did NOT refetch (hits=${childrenHits['kid-token']})`, childrenHits['kid-token'] === 1);

  kids = await plex.collectionChildren(COLL);
  ok(`admin row intact at 2/3 (got ${kids?.[0]?.viewedLeafCount}/3)`, kids?.[0]?.viewedLeafCount === 2);
  ok(`admin warm did NOT refetch (hits=${childrenHits['admin-token']})`, childrenHits['admin-token'] === 1);

  // 4) The consequence that decides what PLAYS, not just what is printed: collectionNext walks
  //    the members in order and skips a watched one. The admin has finished the show's E1-E2 and
  //    seen the movie, so it lands on the show's E3; the kid has seen nothing, so it lands on E1
  //    of the same show — and must never be handed the movie on the strength of the owner's view.
  const adminNext = await plex.collectionNext(COLL);
  ok(`admin next-up is the show's E3 (got ${adminNext?.kind} E${adminNext?.episode})`,
    adminNext?.kind === 'show' && adminNext?.episode === 3);

  const kidNext = await plex.collectionNext(COLL, null, KID);
  ok(`kid next-up is the show's E1 (got ${kidNext?.kind} E${kidNext?.episode})`,
    kidNext?.kind === 'show' && kidNext?.episode === 1);
  ok(`kid next-up names member 1, not the movie (got ${kidNext?.member})`,
    kidNext?.member === 'The Show' && kidNext?.position === 1);
} finally {
  srv.close();
}
console.log('done');
