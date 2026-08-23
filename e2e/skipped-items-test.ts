// Engine test: a curated queue's `skipped` list, the item-level exclude.
//
// A Filtered Pool has had `blocklist` since the Python service; a CURATED queue had nothing,
// so the only way to stop one episode was to remove the whole entry (owner, 2026-08-22: "we
// have excludes, but only for filtered queues and not selected"). `skipped` is the curated
// twin — a flat list of LEAF ratingKeys on the set, permanent until it is cleared.
//
// Five claims, and the third is the one this suite got BACKWARDS on its first day:
//   1. a skipped episode is dropped, and the entry moves on to the next one;
//   2. the batch cap counts what SURVIVES the skip (skip E2 with `episodes: 2` -> E3 + E4,
//      not E3 alone), which is why the filter runs before `applyBatch`;
//   3. a skipped item COUNTS TOWARDS the entry being finished, exactly as a watched one does.
//      Watch a show's first episodes and skip the last and the show is over; the entry is
//      reported as `newlyDone` and marked complete. The first cut of this feature carved an
//      exception here and was wrong: it left an entry that could never complete and never
//      leave the queue (owner, 2026-08-23: "if you finish a show and the last episode is
//      skipped, that will mark it complete, right? ... That's what I'd expect.");
//   4. and the undo needs nothing special — RESTORING the skip makes the entry resolve to
//      something playable again, which the stale-done recovery revives and un-flags;
//   5. a skipped collection CHILD goes whole (a film, or a whole child show), because the
//      collection is the member and its children are the items inside it.
//
// Exercises the REAL resolveMember / nextQueue with only the Plex container reads faked, in
// the shape e2e/resume-in-progress-done-test.ts established.
//
// Run:  server/node_modules/.bin/tsx e2e/skipped-items-test.ts   (from the repo root; non-zero on failure)
import * as resolve from '../server/src/engine/resolve.js';
import type { EntryDescriptor, ResolvedItem } from '../server/src/engine/resolve.js';
import type { PlexClient } from '../server/src/types.js';

/** One recorded leaf in the per-show fixtures below. */
interface Leaf {
  ratingKey: string;
  title: string;
  show: string;
  season: number;
  episode: number;
  duration: number;
  viewCount: number;
}

const FAILS: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && detail ? `  -- ${detail}` : ''));
  if (!cond) FAILS.push(name);
}

// --- fixtures ---------------------------------------------------------------------- //
// Synthetic, like every fixture in this repo: the library contents are placeholders
// (decision `2026-08-17-the-repo-is-public-so-people-hosts-and-ips-are-placeholders`).
const LEAVES: Record<string, Leaf[]> = {
  // Four unwatched episodes. The skip target is E2.
  100000: [
    { ratingKey: '100001', title: 'e1', show: 'Show A', season: 1, episode: 1, duration: 1000000, viewCount: 1 },
    { ratingKey: '100002', title: 'e2', show: 'Show A', season: 1, episode: 2, duration: 1000000, viewCount: 0 },
    { ratingKey: '100003', title: 'e3', show: 'Show A', season: 1, episode: 3, duration: 1000000, viewCount: 0 },
    { ratingKey: '100004', title: 'e4', show: 'Show A', season: 1, episode: 4, duration: 1000000, viewCount: 0 },
  ],
  // ONE unwatched episode left, and it is the one that gets skipped: the claim-3 case.
  200000: [
    { ratingKey: '200001', title: 'e1', show: 'Show B', season: 1, episode: 1, duration: 1000000, viewCount: 1 },
    { ratingKey: '200002', title: 'e2', show: 'Show B', season: 1, episode: 2, duration: 1000000, viewCount: 0 },
  ],
  // Fully watched — nothing skipped about it. The claim-4 control.
  300000: [
    { ratingKey: '300001', title: 'e1', show: 'Show C', season: 1, episode: 1, duration: 1000000, viewCount: 1 },
  ],
  // A collection child that is a SHOW.
  410000: [
    { ratingKey: '410001', title: 'e1', show: 'Member Show', season: 1, episode: 1, duration: 1000000, viewCount: 0 },
  ],
};
const TITLES: Record<string, string> = {
  100000: 'Show A', 200000: 'Show B', 300000: 'Show C', 410000: 'Member Show',
};
// The collection under test: one show member, one film member.
const COLLECTION_RK = '400000';
const COLLECTION_NAME = 'Sample Collection';
const CHILDREN = [
  { ratingKey: '410000', type: 'show', title: 'Member Show' },
  { ratingKey: '420000', type: 'movie', title: 'Member Film', duration: 1000000 },
];

// The only Plex surface the resolver touches: a section's collection search, a collection's
// children, a show's allLeaves, and an item's own metadata.
const client: PlexClient = {
  async container(path) {
    if (path.startsWith('/library/sections/1/collections')) {
      return { Metadata: [{ ratingKey: COLLECTION_RK, type: 'collection', title: COLLECTION_NAME }] };
    }
    if (path.startsWith(`/library/collections/${COLLECTION_RK}/children`)) {
      return { Metadata: CHILDREN };
    }
    const leaves = path.match(/\/library\/metadata\/(\d+)\/allLeaves/);
    if (leaves) {
      // Both `!`s assert the match that guards this branch and the fixture it keys into.
      return {
        Metadata: (LEAVES[leaves[1]!] || []).map((e) => ({
          ratingKey: e.ratingKey,
          title: e.title,
          grandparentTitle: e.show,
          parentIndex: e.season,
          index: e.episode,
          duration: e.duration,
          type: 'episode',
          viewCount: e.viewCount,
        })),
      };
    }
    const meta = path.match(/\/library\/metadata\/(\d+)$/);
    if (meta) {
      const rk = meta[1]!; // the capture group of the match that guards this branch
      if (LEAVES[rk]) return { Metadata: [{ ratingKey: rk, type: 'show', title: TITLES[rk] }] };
      if (rk === '420000') return { Metadata: [{ ratingKey: rk, type: 'movie', title: 'Member Film' }] };
      const leaf = Object.values(LEAVES).flat().find((e) => e.ratingKey === rk);
      return {
        Metadata: [{
          ratingKey: rk, type: 'episode', title: leaf ? leaf.title : rk, viewCount: leaf ? leaf.viewCount : 0,
        }],
      };
    }
    return { Metadata: [] };
  },
  async accountToken() { return null; },
};

/** The same cfg every case uses, plus that case's own skip list. kind != anime = ordered queue. */
const cfg = (skipped: string[], episodes?: number) => ({
  source: 'queue', queue_sections: [1], skipped, ...(episodes ? { episodes } : {}),
});

// The fixture builds the identity fields the resolver reads and omits `weight`/`raw`, which
// only `describe()` fills in off real YAML — widened once here rather than at each call site.
// `done` + a `doneAt` is what `markDone` writes; a hand-written `done: true` carries no stamp
// and is a deliberate skip the resolver never revives on new content alone. The round-trip
// case below needs the STAMPED form, because that is what completing an entry produces.
const entry = (
  rk: string | number,
  episodes: number | null = null,
  done = false,
): EntryDescriptor => ({
  key: `rk:${rk}`, ratingKey: String(rk), title: null, year: null, guid: null,
  collection: null, episodes, start: null, done, doneAt: done ? 1786668576 : null,
} as EntryDescriptor);

const collectionEntry = (name: string): EntryDescriptor => ({
  key: `title:Collection: ${name}`, ratingKey: null, title: null, year: null, guid: null,
  collection: name, episodes: null, start: null, done: false, doneAt: null,
} as EntryDescriptor);

const keys = (items: readonly ResolvedItem[]) => items.map((i) => i.ratingKey);
// WATCHED state is the resolver's own parameter, not a field on the leaf: `resolveMember`
// filters on `watched.has(ratingKey)` and never reads `viewCount` (only the tile's
// `plex.nextEpisode` does). The fixture leaves carry `viewCount` to match what Plex sends;
// this set is what actually decides, and it is the same one for every case below.
const WATCHED = new Set(['100001', '200001', '300001']);

// 1. A skipped episode is dropped and the entry moves on to the next one.
let r = await resolve.resolveMember(client, entry('100000'), cfg(['100002']), WATCHED, null, 1);
// `resolveMember` returns null only for a member it cannot resolve; every entry below names
// one the fake client always answers, so each `!` fails exactly where the original did.
ok('skipped episode is dropped; next one plays', JSON.stringify(keys(r!.items)) === '["100003"]',
  JSON.stringify(keys(r!.items)));

// The control: with nothing skipped, the very same entry plays E2.
r = await resolve.resolveMember(client, entry('100000'), cfg([]), WATCHED, null, 1);
ok('control — unskipped, the same entry plays E2', JSON.stringify(keys(r!.items)) === '["100002"]',
  JSON.stringify(keys(r!.items)));

// 2. The batch cap counts what SURVIVES the skip. This is the assertion that pins the filter
//    BEFORE `applyBatch`: filtering after it would queue E3 alone, one item short.
r = await resolve.resolveMember(client, entry('100000', 2), cfg(['100002']), WATCHED, null, 1);
ok('batch of 2 fills past the skip (E3 + E4)', JSON.stringify(keys(r!.items)) === '["100003","100004"]',
  JSON.stringify(keys(r!.items)));

// 3. The write side. `newlyDone` is what `queues.markDone` persists as `done: true`.
//    Show B has one unwatched episode left and it is skipped: the show is OVER.
let res = await resolve.nextQueue(
  client, 'q', cfg(['200002']), [entry('200000'), entry('300000')], WATCHED, null,
);
ok('watched-then-skipped-the-last completes the entry',
  (res.newlyDone || []).includes('rk:200000'), JSON.stringify(res.newlyDone));
ok('a fully-watched entry completes on the same set',
  (res.newlyDone || []).includes('rk:300000'), JSON.stringify(res.newlyDone));
ok('both report as having nothing left to play',
  res.done.length === 2, JSON.stringify(res.done));

// An entry with something still to play is NOT completed by an unrelated skip — the rule is
// "nothing left", not "something was skipped". Show A has E3/E4 after the skipped E2.
res = await resolve.nextQueue(client, 'q', cfg(['100002']), [entry('100000')], WATCHED, null);
ok('an entry with items left is not completed by a skip',
  !(res.newlyDone || []).length, JSON.stringify(res.newlyDone));

// 4. The ROUND TRIP, which is why claim 3 costs nothing to undo. `done: true` + a `done_at`
//    (what markDone writes) plus a restored skip = an entry that resolves to something
//    playable, which the stale-done recovery revives and reports for un-flagging.
res = await resolve.nextQueue(
  client, 'q', cfg([]), [entry('200000', null, true)], WATCHED, null,
);
ok('restoring the skip REVIVES the completed entry',
  (res.revived || []).includes('rk:200000'), JSON.stringify(res.revived));
ok('…and it plays the episode that was skipped',
  JSON.stringify(res.play.map((i) => i.ratingKey)) === '["200002"]',
  JSON.stringify(res.play.map((i) => i.ratingKey)));
// Still skipped => still complete, and NOT revived. The control for the pair above.
res = await resolve.nextQueue(
  client, 'q', cfg(['200002']), [entry('200000', null, true)], WATCHED, null,
);
ok('while it stays skipped the entry stays complete',
  !(res.revived || []).length, JSON.stringify(res.revived));

// 5. A skipped collection CHILD goes whole — first the film, then the child show.
r = await resolve.resolveMember(client, collectionEntry(COLLECTION_NAME), cfg([]), WATCHED, null, 9);
ok('control — the collection plays both children',
  JSON.stringify(keys(r!.items)) === '["410001","420000"]', JSON.stringify(keys(r!.items)));

r = await resolve.resolveMember(
  client, collectionEntry(COLLECTION_NAME), cfg(['420000']), WATCHED, null, 9,
);
ok('a skipped collection film is dropped from the collection',
  JSON.stringify(keys(r!.items)) === '["410001"]', JSON.stringify(keys(r!.items)));

r = await resolve.resolveMember(
  client, collectionEntry(COLLECTION_NAME), cfg(['410000']), WATCHED, null, 9,
);
ok('a skipped collection child SHOW goes whole',
  JSON.stringify(keys(r!.items)) === '["420000"]', JSON.stringify(keys(r!.items)));

// …and one of that child show's episodes is skippable on its own.
r = await resolve.resolveMember(
  client, collectionEntry(COLLECTION_NAME), cfg(['410001']), WATCHED, null, 9,
);
ok('a skipped episode INSIDE a collection child is dropped',
  JSON.stringify(keys(r!.items)) === '["420000"]', JSON.stringify(keys(r!.items)));

// A three-film collection with the middle film skipped and the other two watched is OVER —
// the owner's second example, and the collection twin of claim 3.
res = await resolve.nextQueue(
  client, 'q', cfg(['420000']), [collectionEntry(COLLECTION_NAME)],
  new Set(['410001']), null,
);
ok('a collection whose children are all watched or skipped completes',
  (res.newlyDone || []).includes(`title:Collection: ${COLLECTION_NAME}`),
  JSON.stringify(res.newlyDone));

// 6. A MOVIE entry is not skippable — the entry IS the leaf, and Remove is the answer there.
//    Asserted so the rule is a decision the suite defends, not an omission nobody noticed.
r = await resolve.resolveMember(client, entry('420000'), cfg(['420000']), WATCHED, null, 1);
ok('a movie ENTRY ignores the skip list (Remove is its answer)',
  JSON.stringify(keys(r!.items)) === '["420000"]', JSON.stringify(keys(r!.items)));

console.log(FAILS.length ? `\nFAILED: ${FAILS.join(', ')}` : '\nAll skipped-items checks passed.');
process.exit(FAILS.length ? 1 : 0);
