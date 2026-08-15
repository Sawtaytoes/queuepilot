// A `Collection:` entry is ONE member and must contribute ONE batch — the same cap a show
// entry gets — so an anime channel rotates shows instead of emptying one series into a scan.
//
// The bug (2026-08-11): resolveMember's collection branch returned collectionItems() raw while
// the show branch sliced to `episodes || defaultBatch`. Live, bob_anime built a 12-item
// "rotation" of 9 consecutive Chaika episodes + 2 Nadesico + 1 Gleipnir — three shows, and one
// of them nine deep. Decision 2026-07-21-plex-collections-as-ordered-queue-entries is explicit
// that a collection gets "the same footing as show entries".
//
// Why this is an ASSERTION test and not a parity case: the fix lands in both engines
// identically, so a Node↔Python diff stays green either way and proves nothing. The existing
// corpus also can't discriminate — its one collection has a single unwatched child, so capped
// and uncapped agree. This pins the behaviour directly, with a hermetic fake client
// (client.container is the whole surface the collection path touches).
import assert from 'node:assert/strict';
import type { EntryDescriptor } from '../server/src/engine/resolve.js';
import type { PlexClient } from '../server/src/types.js';

process.env.SETS_PATH = '/nonexistent-so-loadSets-is-never-consulted.yaml';
const { resolveMember } = await import('../server/src/engine/resolve.js');

const SECTION = 11;
// One collection, one child show, five unwatched episodes. Uncapped this yields all five.
const EPISODES = Array.from({ length: 5 }, (_, i) => ({
  ratingKey: String(900 + i),
  title: `Episode ${i + 1}`,
  grandparentTitle: 'Chaika',
  parentIndex: 1,
  index: i + 1,
  type: 'episode',
  duration: 1_400_000,
}));

// `container` is the whole surface the collection path touches (the comment above says so, and
// a null token is passed throughout), so the double deliberately has no `accountToken`. One
// cast keeps it that way instead of adding an unreachable method to satisfy the seam.
const fakeClient = {
  async container(path: string) {
    if (path.startsWith(`/library/sections/${SECTION}/collections`)) {
      return { Metadata: [{ ratingKey: '5000', title: 'Chaika: The Coffin Princess' }] };
    }
    if (path === '/library/collections/5000/children') {
      return { Metadata: [{ ratingKey: '600', title: 'Chaika', type: 'show' }] };
    }
    if (path === '/library/metadata/600/allLeaves') return { Metadata: EPISODES };
    throw new Error(`unexpected path ${path}`);
  },
} as PlexClient;

const cfg = { queue_sections: [SECTION], episodic_sections: [SECTION], item_sections: [] };
// The harness builds only the fields the collection branch reads; `resolveMember` takes the
// full descriptor, so the partial fixture is widened once here rather than at each call.
const desc = { collection: 'Chaika: The Coffin Princess', key: 'collection' } as EntryDescriptor;
const resolveWith = (d: EntryDescriptor, defaultBatch: number | null) =>
  resolveMember(fakeClient, d, cfg, new Set(), null, defaultBatch, true);

let failed = 0;
const check = (label: string, actual: unknown, expected: unknown): void => {
  try {
    assert.deepEqual(actual, expected);
    console.log(`PASS ${label} — ${JSON.stringify(actual)}`);
  } catch {
    console.log(`FAIL ${label} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
    failed++;
  }
};

// 1. The queue path (QUEUE_SERIES_DEFAULT = 1) takes ONE episode, not the whole run. This is
//    the assertion that fails on the pre-fix code with 5.
// Every `!` below asserts a member the fake client always resolves — `resolveMember` returns
// null only for a collection it cannot FIND, which case 4 covers separately.
const queued = await resolveWith(desc, 1);
check('queue path: collection contributes ONE episode', queued!.items.length, 1);
check('…and it is the FIRST unwatched, so order/resume is preserved', queued!.items[0]!.episode, 1);
check('type is still collection', queued!.type, 'collection');

// 2. A per-entry `episodes:` override wins, exactly as it does for a show entry.
const three = await resolveWith({ ...desc, episodes: 3 }, 1);
check('episodes: 3 override yields three', three!.items.length, 3);
check('override keeps collection order', three!.items.map((e) => e.episode), [1, 2, 3]);

// 3. The rotation / member-bucket callers pass NO default batch and must stay uncapped — their
//    round-robin advances a member across rounds and would regress if this capped too.
const uncapped = await resolveWith(desc, null);
check('rotation path (no default batch) stays uncapped', uncapped!.items.length, 5);

// 4. A missing collection is UNRESOLVED (null), not an empty batch — empty means FINISHED and
//    would wrongly mark the entry done.
const missing = await resolveMember(
  fakeClient, { collection: 'No Such Collection', key: 'collection' } as EntryDescriptor,
  cfg, new Set(), null, 1, true,
);
check('unknown collection stays unresolved (null)', missing, null);

console.log(failed ? `collection-batch-cap FAILED (${failed})` : 'collection-batch-cap OK');
process.exit(failed ? 1 : 0);
