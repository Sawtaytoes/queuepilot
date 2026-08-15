// Engine test: an IN-PROGRESS queued item must never read as finished/done (the OAD bug).
//
// Live-Plex evidence (2026-08, bob_anime): the entry "Prison School: Mad Wax (2016)" is a
// 1-leaf, Season-0 OAD (ratingKey 363480 -> leaf 363482), and Plex has it mid-episode
// (viewOffset 1060898 ms, viewCount ABSENT = 0, no history row). An earlier scan still marked
// the entry `done: true`, because the specials filter dropped its only leaf as a front-loading
// "special", so it looked finished — and it was then skipped while the owner was mid-episode.
//
// Node port of the retired e2e/resume-in-progress-done-test.py (deleted with queue_builder/ on
// 2026-08-12), against server/src/engine/resolve.js. Exercises the REAL resolveMember /
// nextQueue with only the Plex container reads faked, and asserts:
//   * a specials-only show keeps its Season-0 leaf on the queue path (not dropped);
//   * an entry flagged `done: true` but actually in-progress is REVIVED (selected, resumed at
//     its viewOffset) and reported for clearing the stale flag;
//   * a genuinely-watched item (viewCount >= 1) still resolves finished / stays done.
//
// Run:  server/node_modules/.bin/tsx e2e/resume-in-progress-done-test.ts   (from the repo root; non-zero on failure)
import * as resolve from '../server/src/engine/resolve.js';
import type { EntryDescriptor, ResolvedItem } from '../server/src/engine/resolve.js';
import type { PlexClient } from '../server/src/types.js';
import type { Rng } from '../server/src/engine/weight.js';

/** One recorded leaf in the per-show view-state fixtures below. */
interface Leaf {
  ratingKey: string;
  title: string;
  show: string;
  season: number;
  episode: number;
  duration: number;
  viewCount: number;
  viewOffset: number;
}

const FAILS: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && detail ? `  -- ${detail}` : ''));
  if (!cond) FAILS.push(name);
}

// --- fixtures: per-leaf view state, keyed by show ratingKey ----------------------- //
// Season 0 => an OAD/special; season >= 1 => a real season. viewCount 0 is what Plex's ABSENT
// count coerces to, which is exactly the state that must read as "in progress", not "watched".
const LEAVES: Record<string, Leaf[]> = {
  // The Prison School OAD: one Season-0 leaf, mid-episode, viewCount absent (-> 0).
  363480: [{ ratingKey: '363482', title: 'OAD', show: 'Prison School: Mad Wax', season: 0, episode: 1, duration: 1532964, viewCount: 0, viewOffset: 1060898 }],
  // A genuinely-finished 1-leaf special: watched once, no resume point.
  900000: [{ ratingKey: '900001', title: 'OVA', show: 'Watched Special', season: 0, episode: 1, duration: 1000000, viewCount: 1, viewOffset: 0 }],
  // A normal multi-season show: S1E1 watched, S1E2 in-progress, S1E3 fresh.
  700000: [
    { ratingKey: '700001', title: 'e1', show: 'Real Show', season: 1, episode: 1, duration: 1000000, viewCount: 1, viewOffset: 0 },
    { ratingKey: '700002', title: 'e2', show: 'Real Show', season: 1, episode: 2, duration: 1000000, viewCount: 0, viewOffset: 500000 },
    { ratingKey: '700003', title: 'e3', show: 'Real Show', season: 1, episode: 3, duration: 1000000, viewCount: 0, viewOffset: 0 },
  ],
  // A show that WAS finished and has since aired a new episode: E1/E2 watched outright, E3
  // fresh — unwatched with NO resume point, so nothing about it is "in progress". The
  // Trapped-in-a-Dating-Sim case (bob_anime, 2026-08): watched through S2E6, entry marked
  // done, S2E7 airs.
  800000: [
    { ratingKey: '800001', title: 'e1', show: 'Returning Show', season: 1, episode: 1, duration: 1000000, viewCount: 1, viewOffset: 0 },
    { ratingKey: '800002', title: 'e2', show: 'Returning Show', season: 1, episode: 2, duration: 1000000, viewCount: 1, viewOffset: 0 },
    { ratingKey: '800003', title: 'e3', show: 'Returning Show', season: 1, episode: 3, duration: 1000000, viewCount: 0, viewOffset: 0 },
  ],
};
const TITLES: Record<string, string> = {
  363480: 'Prison School: Mad Wax', 900000: 'Watched Special', 700000: 'Real Show',
  800000: 'Returning Show',
};

// The only Plex surface the resolver touches: a show's allLeaves, and an item's own metadata.
const client: PlexClient = {
  async container(path) {
    const leaves = path.match(/\/library\/metadata\/(\d+)\/allLeaves/);
    if (leaves) {
      // Both `!`s assert the match that guards this branch and the fixture it keys into —
      // every allLeaves path the resolver builds here names a show that LEAVES carries.
      return {
        Metadata: LEAVES[leaves[1]!]!.map((e) => ({
          ratingKey: e.ratingKey,
          title: e.title,
          grandparentTitle: e.show,
          parentIndex: e.season,
          index: e.episode,
          duration: e.duration,
          type: 'episode',
          viewCount: e.viewCount,
          viewOffset: e.viewOffset,
        })),
      };
    }
    const meta = path.match(/\/library\/metadata\/(\d+)$/);
    if (meta) {
      const rk = meta[1]!; // the capture group of the match that guards this branch
      if (LEAVES[rk]) return { Metadata: [{ ratingKey: rk, type: 'show', title: TITLES[rk] }] };
      const leaf = Object.values(LEAVES).flat().find((e) => e.ratingKey === rk);
      return {
        Metadata: [{
          ratingKey: rk, type: 'episode', title: leaf ? leaf.title : rk,
          viewOffset: leaf ? leaf.viewOffset : 0, viewCount: leaf ? leaf.viewCount : 0,
        }],
      };
    }
    return { Metadata: [] };
  },
  async accountToken() { return null; },
};

const CFG = { source: 'queue', queue_sections: [1] }; // kind != anime -> ordered queue
// The fixture builds the identity fields the resolver reads and omits `weight`/`raw`, which
// only `describe()` fills in off real YAML — widened once here rather than at each call site.
// `doneAt` set = markDone wrote the flag; null = the owner hand-tagged it (a deliberate skip).
const entry = (
  rk: string | number,
  done = false,
  doneAt: number | null = done ? 1786668576 : null,
): EntryDescriptor => ({
  key: `rk:${rk}`, ratingKey: String(rk), title: null, year: null, guid: null,
  collection: null, episodes: null, start: null, done, doneAt,
} as EntryDescriptor);
const keys = (items: readonly ResolvedItem[]) => items.map((i) => i.ratingKey);

// 1. resolveMember keeps a specials-only show's Season-0 leaf on the resume path.
let r = await resolve.resolveMember(client, entry('363480'), CFG, new Set(), null, 1, true);
// `resolveMember` returns null only for a member it cannot resolve; every entry below names
// one the fake client always answers, so each `!` fails exactly where the original did.
ok('specials-only show keeps its Season-0 OAD leaf',
  JSON.stringify(keys(r!.items)) === JSON.stringify(['363482']), JSON.stringify(r));
// ...and WITHOUT resume (rotation path) the Season-0-only leaf is still dropped, unchanged.
const r0 = await resolve.resolveMember(client, entry('363480'), CFG, new Set(), null, 1, false);
ok('rotation path still drops the Season-0 special', r0!.items.length === 0, JSON.stringify(r0));

// 2. An in-progress leaf is kept even when history counts the whole show watched.
r = await resolve.resolveMember(client, entry('363480'), CFG, new Set(['363482']), null, 1, true);
ok('in-progress leaf survives a watched-history hit',
  JSON.stringify(keys(r!.items)) === JSON.stringify(['363482']), JSON.stringify(r));

// 3. nextQueue REVIVES a done-flagged OAD that is actually in-progress: it plays, resumes at the
//    leaf's viewOffset, is reported for clearing the stale flag, and is not reported finished.
// A HAND-marked entry (no done_at) is used here on purpose: in-progress revival must not
// depend on the timestamp the new-content rule below keys off.
let res = await resolve.nextQueue(client, 'q', CFG, [entry('363480', true, null)], new Set(), null);
ok('done OAD is revived as the play head',
  JSON.stringify(keys(res.play)) === JSON.stringify(['363482']), JSON.stringify(keys(res.play)));
ok('revived OAD resumes at its viewOffset', res.offset === 1060898, String(res.offset));
// `revived` is optional on `QueueResult` (buildReel omits it); `nextQueue` always sets it.
ok('revived OAD clears its stale done flag',
  JSON.stringify(res.revived) === JSON.stringify(['rk:363480']), JSON.stringify(res.revived));
ok('revived OAD is not listed finished', res.done.length === 0, JSON.stringify(res.done));

// 4. A genuinely-watched done special STAYS done: no in-progress item, nothing to revive.
res = await resolve.nextQueue(client, 'q', CFG, [entry('900000', true)], new Set(['900001']), null);
ok('watched special stays done (no play)', res.play.length === 0, JSON.stringify(res.play));
ok('watched special is not revived', res.revived!.length === 0, JSON.stringify(res.revived));

// 4b. NEW CONTENT revives a done entry. An entry is marked done when its resolution comes back
//     EMPTY, so a done entry that now resolves to something playable is stale — even with no
//     resume point anywhere in it. Nothing else ever clears the flag (the TTL sweep defaults to
//     `never`), so without this a returning show is skipped forever.
res = await resolve.nextQueue(client, 'q', CFG, [entry('800000', true)], new Set(['800001', '800002']), null);
ok('done entry is revived by a newly-aired episode',
  JSON.stringify(keys(res.play)) === JSON.stringify(['800003']), JSON.stringify(keys(res.play)));
ok('revived-by-new-content entry clears its stale done flag',
  JSON.stringify(res.revived) === JSON.stringify(['rk:800000']), JSON.stringify(res.revived));
ok('revived-by-new-content entry is not listed finished', res.done.length === 0, JSON.stringify(res.done));
ok('a fresh episode starts at 0, not a resume point', res.offset === 0, String(res.offset));

// 4c. A HAND-marked `done: true` (no done_at — the owner wrote it, markDone did not) is a
//     deliberate skip, not a stale flag. New unwatched content must NOT resurrect it; only
//     actually being mid-episode does (case 3 above). Live case: the "Frieren" entry in
//     bob_anime carries `done: true` with no `done_at`.
res = await resolve.nextQueue(client, 'q', CFG, [entry('800000', true, null)], new Set(['800001', '800002']), null);
ok('hand-marked skip is not revived by new content', res.play.length === 0, JSON.stringify(keys(res.play)));
// `revived` is optional on `QueueResult` (buildReel omits it); `nextQueue` always sets it —
// the same `!` line 153 already writes.
ok('hand-marked skip stays done', res.revived!.length === 0 && res.done.length === 1,
  JSON.stringify({ revived: res.revived, done: res.done }));

// 5. A normal series leads with its in-progress episode (S1E2), not the watched S1E1. A queue
//    plays QUEUE_SERIES_DEFAULT (1) episode per scan, so the resumed episode is the play head.
res = await resolve.nextQueue(client, 'q', CFG, [entry('700000')], new Set(['700001']), null);
ok('series leads with the in-progress episode (default batch = 1)',
  JSON.stringify(keys(res.play)) === JSON.stringify(['700002']), JSON.stringify(keys(res.play)));
ok('series reports the in-progress episode\'s offset', res.offset === 500000, String(res.offset));

// --------------------------------------------------------------------------- //
// bob_anime is a SHUFFLED channel (kind == "anime"): the in-progress OAD must still LEAD so
// it resumes, not land mid-shuffle behind fresh members. The rng here REVERSES the batches, so
// without the hoist the fresh multi-season member would sort first.
// --------------------------------------------------------------------------- //
const ANIME = { source: 'queue', kind: 'anime', queue_sections: [1] };
const reversingRng: Rng = { shuffle: (arr) => { arr.reverse(); } };
res = await resolve.nextQueue(
  client, 'q', ANIME, [entry('700000'), entry('363480', true)], new Set(), null, reversingRng,
);
ok('anime channel leads with the in-progress OAD',
  res.play.length > 0 && res.play[0]!.ratingKey === '363482',
  JSON.stringify(keys(res.play).slice(0, 2)));
ok('anime channel resumes the OAD at its offset', res.offset === 1060898, String(res.offset));

console.log(FAILS.length ? `FAILURES: ${FAILS.length}` : 'done');
process.exit(FAILS.length ? 1 : 0);
