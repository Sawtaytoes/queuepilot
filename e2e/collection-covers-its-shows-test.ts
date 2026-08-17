// A collection MEMBER covers its shows: they leave the rule pool instead of ALSO turning up
// in it as standalone shows.
//
// The bug (owner, 2026-08-17, with a screenshot of the Older Kids pool): he added the Batman
// collection as a member so the shows would play in order, and every show inside it stayed in
// the Eligible pool too — free to be picked on its own, mid-run and out of order. The cause is
// that `channelBuckets` deduped members against the rule pool by BUCKET ratingKey, and a
// collection's bucket key is the COLLECTION's, which can never equal a child show's.
//
// Also pins the `collection_members` knob: `whole` (the default) contributes the collection as
// one ordered member, `split` contributes one member per child. In BOTH modes the children are
// gone from the rule pool — that part is the fix, not the choice.
//
// Hermetic: a fake client is the whole Plex surface these paths touch, so this runs offline in
// CI beside collection-batch-cap-test.
import assert from 'node:assert/strict';
import type { Bucket, EngineBinding, PlexClient } from '../server/src/types.js';

process.env.SETS_PATH = '/nonexistent-so-loadSets-is-never-consulted.yaml';
const { channelBuckets } = await import('../server/src/engine/rotation.js');

const SECTION = 5;
const COLLECTION = 'Batman: The Animated Series Collection';

// Three shows in the library. The collection holds the first two; Beast Wars is the control —
// it must survive every mode, or "the children left the pool" would be indistinguishable from
// "the rule pool broke".
const SHOWS = [
  { ratingKey: '600', title: 'Batman: The Animated Series', type: 'show' },
  { ratingKey: '601', title: 'Batman Beyond', type: 'show' },
  { ratingKey: '602', title: 'Beast Wars', type: 'show' },
];
const IN_COLLECTION = ['600', '601'];

const leaves = (showRk: string, showTitle: string) =>
  Array.from({ length: 3 }, (_, i) => ({
    ratingKey: `${showRk}${i + 1}`,
    title: `${showTitle} E${i + 1}`,
    grandparentTitle: showTitle,
    parentIndex: 1,
    index: i + 1,
    type: 'episode',
    duration: 1_400_000,
  }));

const fakeClient = {
  async accountToken() { return null; },
  async container(path: string) {
    if (path.startsWith('/status/sessions/history/all')) return { Metadata: [], totalSize: 0 };
    if (path.startsWith(`/library/sections/${SECTION}/collections`)) {
      return { Metadata: [{ ratingKey: '5000', title: COLLECTION, type: 'collection' }] };
    }
    if (path === '/library/collections/5000/children') {
      return { Metadata: SHOWS.filter((s) => IN_COLLECTION.includes(s.ratingKey)) };
    }
    if (path.startsWith(`/library/sections/${SECTION}/all?type=2`)) return { Metadata: SHOWS };
    // A SPLIT child is resolved as a plain show member, which asks Plex what the ratingKey
    // IS before reading its leaves — the collection branch never takes this path.
    const meta = /^\/library\/metadata\/(\d+)$/.exec(path);
    if (meta) {
      const show = SHOWS.find((s) => s.ratingKey === meta[1]);
      if (show) return { Metadata: [show] };
    }
    const leaf = /^\/library\/metadata\/(\d+)\/allLeaves$/.exec(path);
    if (leaf) {
      const show = SHOWS.find((s) => s.ratingKey === leaf[1]);
      if (show) return { Metadata: leaves(show.ratingKey, show.title) };
    }
    if (path === '/library/sections') return { Directory: [{ key: String(SECTION), type: 'show' }] };
    throw new Error(`unexpected path ${path}`);
  },
} as unknown as PlexClient;

const binding = {
  plex_user: 'Older Kids',
  account_id: 22222222,
  user_uuid: null,
  allowed_ratings: null,
  movie_ratings: null,
  watch_count_accounts: [22222222],
  movie_excludes: [],
} as EngineBinding;

const cfgFor = (collectionMembers?: string) => ({
  episodic_sections: [SECTION],
  queue_sections: [SECTION],
  item_sections: [],
  blocklist: [],
  starts: {},
  weights: {},
  members: [`Collection: ${COLLECTION}`],
  ...(collectionMembers ? { collection_members: collectionMembers } : {}),
});

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
const titles = (bs: Bucket[]) => bs.map((b) => b.show).sort();
const keys = (bs: Bucket[]) => bs.map((b) => String(b.ratingKey)).sort();

// --- default (absent = whole) ------------------------------------------------- //
// THE REGRESSION ASSERTION. Pre-fix this is 4 buckets: the collection PLUS all three shows.
const whole = await channelBuckets(fakeClient, cfgFor(), binding);
check('whole: the collection and the show it does not cover — nothing else',
  titles(whole), ['Beast Wars', `Collection: ${COLLECTION}`]);
check('whole: neither Batman show is a bucket of its own',
  whole.some((b) => IN_COLLECTION.includes(String(b.ratingKey))), false);
check('whole: the collection is ONE member holding both shows in collection order',
  whole.find((b) => b.show.startsWith('Collection:'))!.episodes.map((e) => e.title),
  ['Batman: The Animated Series E1', 'Batman: The Animated Series E2',
    'Batman: The Animated Series E3', 'Batman Beyond E1', 'Batman Beyond E2', 'Batman Beyond E3']);

// `whole` is what an absent key means, so an explicit one must not differ.
const explicitWhole = await channelBuckets(fakeClient, cfgFor('whole'), binding);
check('an explicit `whole` is the same as the absent default', titles(explicitWhole), titles(whole));

// A typo falls back to the DEFAULT rather than to the other behaviour.
const typo = await channelBuckets(fakeClient, cfgFor('splt'), binding);
check('an unrecognised value reads as whole, not as split', titles(typo), titles(whole));

// --- split -------------------------------------------------------------------- //
const split = await channelBuckets(fakeClient, cfgFor('split'), binding);
check('split: one bucket per show, and no collection bucket',
  titles(split), ['Batman Beyond', 'Batman: The Animated Series', 'Beast Wars']);
check('split: the children are keyed by their OWN ratingKeys', keys(split), ['600', '601', '602']);
check('split: each child carries only its own episodes',
  split.find((b) => b.show === 'Batman Beyond')!.episodes.map((e) => e.title),
  ['Batman Beyond E1', 'Batman Beyond E2', 'Batman Beyond E3']);
check('split: no show is listed twice', split.length, new Set(keys(split)).size);

// --- no members at all -------------------------------------------------------- //
// The cover must not reach a pool that named no collection: the rule pool is untouched.
const noMembers = await channelBuckets(
  fakeClient, { ...cfgFor(), members: [] }, binding,
);
check('a pool with no members still gets its whole rule pool',
  titles(noMembers), ['Batman Beyond', 'Batman: The Animated Series', 'Beast Wars']);

console.log(failed ? `collection-covers-its-shows FAILED (${failed})` : 'collection-covers-its-shows OK');
process.exit(failed ? 1 : 0);
