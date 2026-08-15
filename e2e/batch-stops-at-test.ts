// `batch_stops_at` — WHERE a multi-episode batch may stop, in the NODE port. The count cap
// (`episodes:`) says how many; this says where the batch may end.
//
// The case that motivated it (owner, 2026-08-12): a two-episode batch sitting on a season finale
// queued the finale AND the next season's premiere — or, inside a `Collection:`, the finale AND
// episode 1 of the NEXT member show. Watchable, but not what you want right after an emotional
// finale. "none" (default) fills across anything; "member" never spans two collection members;
// "season" also never spans a season boundary, including inside one show.
//
// Same table as e2e/batch-stops-at-test.py, deliberately: the feature lands in both engines
// identically, so a Node↔Python DIFF stays green either way and proves nothing — each side has
// to be pinned by assertion. Hermetic fake client (client.container is the whole surface).
//
// Run: server/node_modules/.bin/tsx e2e/batch-stops-at-test.ts
import assert from 'node:assert/strict';
import type { EntryDescriptor } from '../server/src/engine/resolve.js';
import type { PlexClient, PlexMetadata } from '../server/src/types.js';

process.env.SETS_PATH = '/nonexistent-so-loadSets-is-never-consulted.yaml';
const { resolveMember } = await import('../server/src/engine/resolve.js');
const env = await import('../server/src/env.js');

const SECTION = 11;
const CFG = { queue_sections: [SECTION], episodic_sections: [SECTION], item_sections: [] };

// Two shows: "Alpha" with two seasons (S1 x2, S2 x2) and "Beta" (S1 x2), in one collection.
const leaf = (show: string, season: number, episode: number, rk: number) => ({
  ratingKey: String(rk), title: `${show} S${season}E${episode}`, grandparentTitle: show,
  parentIndex: season, index: episode, type: 'episode', duration: 1_400_000,
});
const ALPHA = [leaf('Alpha', 1, 1, 101), leaf('Alpha', 1, 2, 102),
  leaf('Alpha', 2, 1, 201), leaf('Alpha', 2, 2, 202)];
const BETA = [leaf('Beta', 1, 1, 301), leaf('Beta', 1, 2, 302)];
const LEAVES: Record<string, ReturnType<typeof leaf>[]> = { 600: ALPHA, 700: BETA };

const SHOW_CHILDREN = [{ ratingKey: '600', title: 'Alpha', type: 'show' },
  { ratingKey: '700', title: 'Beta', type: 'show' }];
// Two movie members, to prove they are never fused into one segment (their `show` is the
// collection name, so a boundary keyed on `show` alone would read the pair as one member).
const MOVIE_CHILDREN = [{ ratingKey: '801', title: 'Movie One', type: 'movie', duration: 1 },
  { ratingKey: '802', title: 'Movie Two', type: 'movie', duration: 1 }];

// Reassigned to MOVIE_CHILDREN for case 4, so it is the wire shape rather than either literal.
let children: PlexMetadata[] = SHOW_CHILDREN;
// `container` is the whole surface this path touches (a null token is passed throughout), so
// the double deliberately has no `accountToken`; one cast keeps it that way.
const fakeClient = {
  async container(path: string) {
    if (path.startsWith(`/library/sections/${SECTION}/collections`)) {
      return { Metadata: [{ ratingKey: '5000', title: 'Both Shows' }] };
    }
    if (path === '/library/collections/5000/children') return { Metadata: children };
    const leaves = /^\/library\/metadata\/(\d+)\/allLeaves$/.exec(path);
    // Fresh objects per call, exactly like the real showEpisodes — resolve tags `member_key` in
    // place, and a shared array would leak that tag between cases.
    // The capture group of the match that guards the read.
    if (leaves) return { Metadata: (LEAVES[leaves[1]!] || []).map((e) => ({ ...e })) };
    const meta = /^\/library\/metadata\/(\d+)$/.exec(path);
    if (meta) {
      const rk = meta[1]!;
      if (rk === '600' || rk === '700') {
        return { Metadata: [{ type: 'show', title: rk === '600' ? 'Alpha' : 'Beta' }] };
      }
      return { Metadata: [{ type: 'movie', title: `Movie ${rk}`, viewOffset: 0, viewCount: 0 }] };
    }
    throw new Error(`unexpected path ${path}`);
  },
} as PlexClient;

// The fixtures carry only the identity fields the resolver reads; `describe()` fills the rest
// off real YAML. Widened once here rather than at each of the twenty call sites below.
const COLL = { collection: 'Both Shows', key: 'title:Collection: Both Shows' } as EntryDescriptor;
const SHOW = { ratingKey: '600', key: 'rk:600' } as EntryDescriptor;

const titles = async (
  desc: EntryDescriptor,
  cfg: { batch_stops_at?: string } = {},
  batch: number | null = 1,
  watched: string[] = [],
) => {
  const res = await resolveMember(
    fakeClient, desc, { ...CFG, ...cfg }, new Set(watched), null, batch, true,
  );
  // Every descriptor passed here names a member the fake client resolves; `resolveMember`
  // returns null only for one it cannot find.
  return res!.items.map((e) => e.title);
};

let failed = 0;
const check = async (label: string, actual: unknown, expected: unknown): Promise<void> => {
  const got = await actual;
  try {
    assert.deepEqual(got, expected);
    console.log(`PASS ${label} — ${JSON.stringify(got)}`);
  } catch {
    console.log(`FAIL ${label} — got ${JSON.stringify(got)}, want ${JSON.stringify(expected)}`);
    failed += 1;
  }
};

// 1. Default ("none") — today's behavior, across BOTH boundary kinds.
await check('default: a 2-batch spans the member boundary',
  titles(COLL, {}, 2, ['101', '102', '201']), ['Alpha S2E2', 'Beta S1E1']);
await check('default: a 2-batch spans the SEASON boundary inside one show',
  titles(SHOW, {}, 2, ['101']), ['Alpha S1E2', 'Alpha S2E1']);

// 2. "member" — a batch never spans two collection members.
await check('member: the collection\'s last Alpha episode plays ALONE',
  titles(COLL, { batch_stops_at: 'member' }, 2, ['101', '102', '201']), ['Alpha S2E2']);
await check('member: a batch WITHIN one member is still filled',
  titles(COLL, { batch_stops_at: 'member' }, 2, ['101']), ['Alpha S1E2', 'Alpha S2E1']);
await check('member: is a no-op for a plain show entry (one member by definition)',
  titles(SHOW, { batch_stops_at: 'member' }, 2, ['101']), ['Alpha S1E2', 'Alpha S2E1']);

// 3. "season" — also cuts at a season boundary, inside a show as well.
await check('season: a show at its finale queues the finale ALONE',
  titles(SHOW, { batch_stops_at: 'season' }, 2, ['101']), ['Alpha S1E2']);
await check('season: mid-season, the batch still fills',
  titles(SHOW, { batch_stops_at: 'season' }, 2), ['Alpha S1E1', 'Alpha S1E2']);
await check('season: implies the member boundary too',
  titles(COLL, { batch_stops_at: 'season' }, 2, ['101', '102', '201']), ['Alpha S2E2']);

// 4. Two movie members are two segments, never one.
children = MOVIE_CHILDREN;
await check('member: two movie members are NOT fused into one segment',
  titles(COLL, { batch_stops_at: 'member' }, 2), ['Movie One']);
await check('default: the same pair still fills across, as it always did',
  titles(COLL, {}, 2), ['Movie One', 'Movie Two']);
children = SHOW_CHILDREN;

// 5. The floor of ONE item: a boundary cut must never empty a live batch, because nextQueue
//    reads empty items as FINISHED and marks the entry done.
for (const stop of ['none', 'member', 'season']) {
  await check(`${stop}: one episode left still yields that one (never [] = finished)`,
    titles(SHOW, { batch_stops_at: stop }, 2, ['101', '102', '201']), ['Alpha S2E2']);
  await check(`${stop}: a batch of 1 is unaffected`,
    titles(SHOW, { batch_stops_at: stop }, 1), ['Alpha S1E1']);
}
await check('a genuinely finished show is still FINISHED (empty items), stop or no stop',
  titles(SHOW, { batch_stops_at: 'season' }, 2, ['101', '102', '201', '202']), []);

// 6. Precedence: entry override > set > global default.
await check('entry override wins over the set (entry none on a season set)',
  titles({ ...SHOW, batch_stops_at: 'none' }, { batch_stops_at: 'season' }, 2, ['101']),
  ['Alpha S1E2', 'Alpha S2E1']);
await check('entry override wins over the set (entry season on an unset set)',
  titles({ ...SHOW, batch_stops_at: 'season' }, {}, 2, ['101']), ['Alpha S1E2']);
// An unrecognised value is IGNORED at that level, so a typo falls back to the set's intent
// instead of silently switching the feature off.
await check('a typo\'d entry value falls back to the set, not to off',
  titles({ ...SHOW, batch_stops_at: 'seasons' }, { batch_stops_at: 'season' }, 2, ['101']),
  ['Alpha S1E2']);
await check('off/blank spellings read as none',
  titles({ ...SHOW, batch_stops_at: 'off' }, { batch_stops_at: 'season' }, 2, ['101']),
  ['Alpha S1E2', 'Alpha S2E1']);
// The global default is read from env at module eval, so assert its shape rather than
// re-importing the module under a mutated process.env.
check('BATCH_STOPS_AT defaults to none (the global fallback)', env.BATCH_STOPS_AT, 'none');

// 7. The uncapped rotation / member-bucket caller is untouched — its round-robin needs the FULL
//    ordered list to advance a show across rounds.
await check('rotation path (no default batch) stays uncapped under season',
  titles(SHOW, { batch_stops_at: 'season' }, null),
  ['Alpha S1E1', 'Alpha S1E2', 'Alpha S2E1', 'Alpha S2E2']);
await check('rotation path (no default batch) stays uncapped under member',
  titles(COLL, { batch_stops_at: 'member' }, null),
  ['Alpha S1E1', 'Alpha S1E2', 'Alpha S2E1', 'Alpha S2E2', 'Beta S1E1', 'Beta S1E2']);

// 8. The count cap still wins where it is smaller, and the hard cap still applies.
await check('a 3-batch under season still stops at the season boundary',
  titles(SHOW, { batch_stops_at: 'season' }, 3), ['Alpha S1E1', 'Alpha S1E2']);
await check('QUEUE_SERIES_LENGTH still clamps an absurd override',
  titles({ ...SHOW, episodes: 9999 }, {}, 1).then((t) => t.length), ALPHA.length);

console.log(failed ? `batch-stops-at FAILED (${failed})` : 'batch-stops-at OK');
process.exit(failed ? 1 : 0);
