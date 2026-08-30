// Per-entry Shuffle for Picks shows and Collections.
//
// The Picks Random pool shuffles ENTRIES. This feature is the independent inner axis: once
// a show or Collection is selected, it can draw any playable leaf, including watched ones.
// The fake Plex client pins the whole contract without a server or a live library.
import assert from 'node:assert/strict';

import type { PlexClient } from '../server/src/types.js';

process.env.SETS_PATH = '/nonexistent-so-loadSets-is-never-consulted.yaml';

const { describe, nextQueue, resolveMember } = await import('../server/src/engine/resolve.js');

const SHOW = '100';
const COLLECTION = '900';
const COLLECTION_SHOW = '200';
const COLLECTION_MOVIE = '300';

const episodes = (show: string) => [1, 2, 3, 4].map((episode) => ({
  ratingKey: `${show}${episode}`,
  title: `Episode ${episode}`,
  grandparentTitle: show === SHOW ? 'Example Show' : 'Collection Show',
  parentIndex: episode === 4 ? 2 : 1,
  index: episode === 4 ? 1 : episode,
  type: 'episode',
  duration: 1_200_000,
  viewCount: 1,
  viewOffset: 0,
}));

let providerResume = '';
const client: PlexClient = {
  async container(path) {
    if (path.startsWith('/library/sections/1/collections')) {
      return { Metadata: [{ ratingKey: COLLECTION, type: 'collection', title: 'Example Collection' }] };
    }
    if (path === `/library/collections/${COLLECTION}/children`) {
      return {
        Metadata: [
          { ratingKey: COLLECTION_SHOW, type: 'show', title: 'Collection Show' },
          { ratingKey: COLLECTION_MOVIE, type: 'movie', title: 'Collection Movie' },
        ],
      };
    }
    const leaves = /^\/library\/metadata\/(\d+)\/allLeaves$/.exec(path);
    if (leaves) {
      return {
        Metadata: episodes(leaves[1]!).map((item) => ({
          ...item,
          viewCount: item.ratingKey === providerResume ? 0 : 1,
          viewOffset: item.ratingKey === providerResume ? 600_000 : 0,
        })),
      };
    }
    const metadata = /^\/library\/metadata\/(\d+)$/.exec(path);
    if (metadata) {
      const ratingKey = metadata[1]!;
      if (ratingKey === SHOW) {
        return { Metadata: [{ ratingKey, type: 'show', title: 'Example Show' }] };
      }
      if (ratingKey === COLLECTION_MOVIE) {
        return {
          Metadata: [{
            ratingKey,
            type: 'movie',
            title: 'Collection Movie',
            viewCount: 1,
            viewOffset: 0,
          }],
        };
      }
    }
    return { Metadata: [] };
  },
  async accountToken() { return null; },
};

const cfg = (skipped: string[] = []) => ({
  source: 'queue',
  queue_sections: [1],
  skipped,
  included_specials: [],
});
const watched = new Set([
  ...episodes(SHOW).map((item) => item.ratingKey),
  ...episodes(COLLECTION_SHOW).map((item) => item.ratingKey),
  COLLECTION_MOVIE,
]);
const reversingRng = { shuffle: (items: unknown[]) => { items.reverse(); } };
const keys = (value: Awaited<ReturnType<typeof resolveMember>>) =>
  value?.items.map((item) => item.ratingKey) ?? [];

let failed = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  try {
    assert.deepEqual(actual, expected);
    console.log(`PASS ${label} — ${JSON.stringify(actual)}`);
  } catch {
    console.log(`FAIL ${label} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
    failed += 1;
  }
}

const inOrder = describe({ ratingKey: SHOW, title: 'Example Show', episodes: 2 });
check(
  'in-order still removes watched episodes',
  keys(await resolveMember(client, inOrder, cfg(), watched, null, 1, true, reversingRng)),
  [],
);

const shuffled = describe({
  ratingKey: SHOW,
  title: 'Example Show',
  episodes: 2,
  item_order: 'shuffle',
});
check('descriptor normalizes the stored mode', shuffled.itemOrder, 'shuffle');
check(
  'Shuffle includes watched episodes and applies the batch after shuffling',
  keys(await resolveMember(client, shuffled, cfg(), watched, null, 1, true, reversingRng)),
  ['1004', '1003'],
);
check(
  'Skipped leaves stay out of the Shuffle pool',
  keys(await resolveMember(client, shuffled, cfg(['1003']), watched, null, 1, true, reversingRng)),
  ['1004', '1002'],
);

const floored = describe({
  ratingKey: SHOW,
  title: 'Example Show',
  episodes: 2,
  item_order: 'shuffle',
  start: { season: 1, episode: 2 },
});
check(
  'a manual start remains a lower bound',
  keys(await resolveMember(client, floored, cfg(), watched, null, 1, true, reversingRng)),
  ['1004', '1003'],
);

providerResume = '1002';
check(
  'a provider in-progress episode resumes before the shuffled remainder',
  keys(await resolveMember(client, shuffled, cfg(), watched, null, 1, true, reversingRng)),
  ['1002', '1004'],
);
providerResume = '';

const ownProgress = new Map([
  ['1003', { isCompleted: false, positionMs: 300_000 }],
]);
check(
  'queue-owned progress also resumes before the shuffled remainder',
  keys(await resolveMember(
    client, shuffled, cfg(), watched, null, 1, true, reversingRng, ownProgress,
  )),
  ['1003', '1004'],
);

const collection = describe({
  collection: 'Example Collection',
  episodes: 2,
  item_order: 'shuffle',
  batch_stops_at: 'member',
});
check(
  'a Collection flattens watched show episodes and movies before Shuffle',
  keys(await resolveMember(client, collection, cfg(), watched, null, 1, true, reversingRng)),
  [COLLECTION_MOVIE, '2004'],
);

const queueCfg = {
  ...cfg(), kind: 'picks', add_as: 'priority', length: 1, episodes: 2,
};
const autoDone = describe({
  ratingKey: SHOW,
  title: 'Example Show',
  item_order: 'shuffle',
  done: true,
  done_at: 1_788_048_000,
});
const revived = await nextQueue(
  client, 'example', queueCfg, [autoDone], watched, null, reversingRng,
);
check('an automatically finished Shuffle entry revives for reruns', revived.revived, ['rk:100']);
check(
  'the revived entry supplies a shuffled batch',
  revived.play.map((item) => item.ratingKey),
  ['1004', '1003'],
);

const handDone = describe({
  ratingKey: SHOW,
  title: 'Example Show',
  item_order: 'shuffle',
  done: true,
});
const held = await nextQueue(
  client, 'example', queueCfg, [handDone], watched, null, reversingRng,
);
check('a hand-finished Shuffle entry stays finished', held.revived, []);
check('a hand-finished Shuffle entry does not play', held.play, []);

console.log(failed ? `per-entry-shuffle FAILED (${failed})` : 'per-entry-shuffle OK');
process.exit(failed ? 1 : 0);
