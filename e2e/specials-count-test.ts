// Specials/extras filter (decision 2026-08-07-specials-count-excludes-op-ed-trailer-extras):
// the web UI's "X/Y watched" counts, the playable list they reflect, AND the collection next-up
// must EXCLUDE Season-0 trailers/openings/endings — recognised DETERMINISTICALLY by the Season-0
// episode INDEX (exclude 200–399), plus any Plex clip/extraType — while KEEPING real episodes,
// regular Season-0 specials (index 1–99), and Season-0 "other" (index 400+).
//
// Two halves: pure predicate/count math (no I/O), then collectionNext driven off a SEEDED
// SQLite cache (no server, browser, or Plex) — the Saiki K. collection scenario from the field.
//
// Run:  server/node_modules/.bin/tsx e2e/specials-count-test.ts   (repo root; non-zero on failure)
import { promises as fs } from 'node:fs';
import type { EpisodeLike } from '../server/src/plex.js';

// A local const, not `process.env.CACHE_PATH` re-read: the env value is `string | undefined`
// everywhere it is read back, and the paths below are the same string by construction.
const CACHE_PATH = '/tmp/specials-count-cache.sqlite';
process.env.CACHE_PATH = CACHE_PATH;
for (const f of [CACHE_PATH, `${CACHE_PATH}-wal`, `${CACHE_PATH}-shm`]) {
  await fs.rm(f, { force: true });
}

const plex = await import('../server/src/plex.js');
const cache = await import('../server/src/cache.js');
const { isExtraOrPromo, isCountableEpisode, isPlayableEpisode, countEpisodes, collectionNext } = plex;

const ok = (n: string, c: boolean) => {
  console.log(`${c ? 'PASS' : 'FAIL'} ${n}`);
  if (!c) process.exitCode = 1;
};

const DUR = 1_000; // any positive duration — classification is by INDEX, never by length
const s1 = (rk: string, i: number, watched: boolean): EpisodeLike =>
  ({ ratingKey: rk, parentIndex: 1, index: i, title: `Ep ${i}`, duration: DUR, viewCount: watched ? 1 : 0 });
// Season-0 items, classified by index range: 1–99 special, 200–299 trailer, 300–399 OP/ED, 400+ other.
const s0 = (rk: string, index: number, title: string, watched = false): EpisodeLike =>
  ({ ratingKey: rk, parentIndex: 0, index, title, duration: DUR, viewCount: watched ? 1 : 0 });

// ---------------------------------------------------------------------------------------- //
// Part A — the predicate + counts (pure)
// ---------------------------------------------------------------------------------------- //
// A SONG-NAMED ED (index 300s) — no "NCED"/"Ending" in the title, so only the index catches it.
ok('a Season-0 OP/ED (index 301) IS an extra', isExtraOrPromo(s0('e1', 301, 'Kokoro')) === true);
ok('a Season-0 trailer (index 201) IS an extra', isExtraOrPromo(s0('t1', 201, 'Trailer')) === true);
ok('a clip-typed item is an extra', isExtraOrPromo({ parentIndex: 0, index: 5, type: 'clip' }) === true);
ok('an extraType item is an extra', isExtraOrPromo({ parentIndex: 0, index: 5, extraType: 'behindTheScenes' }) === true);
ok('a regular Season-0 special (index 1) is NOT an extra', isExtraOrPromo(s0('sp', 1, 'OVA: Hot Springs')) === false);
ok('the special (index 1) COUNTS as a real episode', isCountableEpisode(s0('sp', 1, 'OVA: Hot Springs')) === true);
ok('a Season-0 "other" (index 401) is NOT an extra and COUNTS', isExtraOrPromo(s0('o1', 401, 'Recap')) === false && isCountableEpisode(s0('o1', 401, 'Recap')) === true);
ok('a normal S1 episode is NOT an extra', isExtraOrPromo(s1('11', 1, false)) === false);
// The index rule fires ONLY on Season 0: a Season-1 episode 301 (a long-running show) is safe.
ok('a Season-1 episode 301 is NOT dropped', isCountableEpisode({ parentIndex: 1, index: 301, title: 'Ep 301', duration: DUR }) === true);

// A specials-only show (an OAD with no real season, e.g. "Prison School: Mad Wax") must still be
// listable: showEpisodes passes includeSpecials when there are no real seasons, so a regular
// Season-0 special is kept — but an OP/ED stays dropped; and a normal show still skips Season 0.
ok('specials-only: S0 special (idx 1) IS playable when includeSpecials', isPlayableEpisode(s0('oad', 1, 'OAD'), { includeSpecials: true }) === true);
ok('specials-only: S0 OP/ED (idx 301) still dropped even with includeSpecials', isPlayableEpisode(s0('ed', 301, 'Kokoro'), { includeSpecials: true }) === false);
ok('normal show: S0 special (idx 1) dropped by default', isPlayableEpisode(s0('sp', 1, 'OVA')) === false);

// A show: 3 normal S1 (two watched) + special(s0e1) + other(s0e401) + an OP/ED(s0e301) + trailer(s0e201).
const showEps = [
  s1('11', 1, true), s1('12', 2, false), s1('13', 3, true),
  s0('20', 1, 'OVA: Hot Springs'), s0('40', 401, 'Recap'),
  s0('30', 301, 'Kokoro'), s0('21', 201, 'Trailer'),
];
const counts = countEpisodes(showEps);
ok('leafCount = 3 normal + special + other (5, not 7)', counts.leafCount === 5);
ok('viewedLeafCount counts only watched real episodes (2)', counts.viewedLeafCount === 2);
ok('missing viewCount is unwatched', countEpisodes([{ parentIndex: 1, index: 9, title: 'x', duration: DUR }]).viewedLeafCount === 0);

// Playback: Season 0 excluded entirely by default (open-point rule) → only the 3 S1 episodes.
ok('default playable list is the 3 S1 episodes', showEps.filter((e) => isPlayableEpisode(e)).map((e) => e.ratingKey).join(',') === '11,12,13');
// include_specials adds the regular special AND the "other", but never the trailer/OP/ED.
ok('include_specials adds special + other, not trailer/OP-ED', showEps.filter((e) => isPlayableEpisode(e, { includeSpecials: true })).map((e) => e.ratingKey).join(',') === '11,12,13,20,40');

// ---------------------------------------------------------------------------------------- //
// Part B — collectionNext advances past a series whose only unwatched leaves are extras
// (the Saiki K. collection: S1/S2/S3 done except OP/ED theme songs at index 301+; S4 has 6 real
// unwatched eps). Cache is seeded so collectionChildren + allLeaves hit locally — no Plex/server.
// ---------------------------------------------------------------------------------------- //
await cache.init();

const normalEps = (rk: string, n: number, { watched }: { watched: boolean }): EpisodeLike[] =>
  Array.from({ length: n }, (_, k) => s1(`${rk}${k + 1}`, k + 1, watched));

// S1: 24 watched real episodes + 4 song-named ED theme songs at index 301–304 (unwatched). Those
// four Season-0 ED leaves are what made Plex report 25/29 (inflated); filtered, S1 is 24/24.
const s1Leaves = [
  ...normalEps('100', 24, { watched: true }),
  s0('100e1', 301, 'Seishun wa Zankoku ja Nai'), s0('100e2', 302, 'Sai Psi Sai Kouchou!'),
  s0('100e3', 303, 'Psi Desu I Like You'), s0('100e4', 304, 'Kokoro'),
];
const s2Leaves = [...normalEps('200', 26, { watched: true }), s0('200e1', 301, 'Ending A'), s0('200e2', 302, 'Ending B')];
const s3Leaves = normalEps('300', 2, { watched: true });
const s4Leaves = normalEps('400', 6, { watched: false }); // SIX real unwatched episodes

const SEEDS: [string, EpisodeLike[]][] = [
  ['100', s1Leaves], ['200', s2Leaves], ['300', s3Leaves], ['400', s4Leaves],
];
for (const [rk, eps] of SEEDS) {
  const c = countEpisodes(eps);
  await cache.putLeaves(rk, { updatedAt: 1, leafCount: c.leafCount, viewedLeafCount: c.viewedLeafCount, payload: eps });
}

ok('S1 counts as 24/24 (index-301+ ED songs excluded, not 24/28)', (() => { const c = countEpisodes(s1Leaves); return c.viewedLeafCount === 24 && c.leafCount === 24; })());
ok('S4 counts as 0/6 real episodes', (() => { const c = countEpisodes(s4Leaves); return c.viewedLeafCount === 0 && c.leafCount === 6; })());

const members = [
  { ratingKey: '100', type: 'show', title: 'The Disastrous Life of Saiki K.', year: 2016, watched: false, viewedLeafCount: 24, leafCount: 24 },
  { ratingKey: '200', type: 'show', title: 'The Disastrous Life of Saiki K. 2', year: 2018, watched: false, viewedLeafCount: 26, leafCount: 26 },
  { ratingKey: '300', type: 'show', title: 'The Disastrous Life of Saiki K.: The Final Arc', year: 2019, watched: false, viewedLeafCount: 2, leafCount: 2 },
  { ratingKey: '400', type: 'show', title: 'The Disastrous Life of Saiki K.: Reawakened', year: 2019, watched: false, viewedLeafCount: 0, leafCount: 6 },
];
await cache.putCollectionChildren('COLL1', { updatedAt: 1, childCount: members.length, payload: members });

const next = await collectionNext('COLL1');
ok('collectionNext advances past the ED-only series to S4', next != null && next.memberRatingKey === '400');
ok('collectionNext returns S4 episode 1', next != null && next.kind === 'show' && Number(next.episode) === 1);
ok('collectionNext reports S4 as member position 4', next != null && next.position === 4);

// A genuinely-unwatched NORMAL episode in an earlier member BLOCKS the advance: reseed S2 with
// one real unwatched episode → next-up must stop at S2, not skip ahead to S4.
const s2WithUnwatched = [...normalEps('200', 25, { watched: true }), s1('200u', 26, false), s0('200e1', 301, 'Ending A')];
const c2 = countEpisodes(s2WithUnwatched);
await cache.putLeaves('200', { updatedAt: 2, leafCount: c2.leafCount, viewedLeafCount: c2.viewedLeafCount, payload: s2WithUnwatched });
const next2 = await collectionNext('COLL1');
ok('a real unwatched episode blocks the advance (stops at S2)', next2 != null && next2.memberRatingKey === '200' && Number(next2.episode) === 26);

if (process.exitCode) console.log('specials-count: FAILURES');
else console.log('specials-count: done');
