// PENDING: what arrived that nothing is going to play.
//
// "a 'Pending' or 'New' area to show if there are new movies or shows added and allow me to
// specify the queues to add them IF they're not already picked up by one" — the `if` is the
// feature. A list of everything recently added is Plex's own Recently Added; the useful list
// is the one that has already subtracted everything the household will see anyway.
//
// So the assertions here are about SUBTRACTION, not about listing. Hermetic: a fake section
// lister and a fake Plex client, no server and no network.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import type { PlexClient, PlexMetadata } from '../server/src/types.js';

const SETS = '/tmp/sets-pending-test.yaml';
const QUEUES = '/tmp/queues-pending-test.yaml';
const STATE = '/tmp/pending-test.yaml';

// A filtered pool over Shows (5) capped at TV-Y, a curated queue naming one film by
// ratingKey, and a curated pool naming a COLLECTION.
await fs.writeFile(SETS, `sets:
- id: kid_pool
  label: Kid Pool
  kind: cartoons
  source: rotation
  behavior: progress
  sections: [ 5 ]
  item_sections: []
  blocklist: [ "708" ]
  profiles:
  - plex_user: Younger Kids
    account_id: 11111111
    allowed_ratings: [ TV-Y ]
- id: my_movies
  label: My Movies
  kind: movies
  source: queue
  sections: [ 1 ]
- id: franchise
  label: Franchise
  kind: anime
  source: queue
  sections: [ 1 ]
`);
await fs.writeFile(QUEUES, 'my_movies:\n- ratingKey: "901"\n  title: Named Film (2020)\nfranchise:\n- "Collection: Bunny Films"\n');
// A REAL watermark, not an empty file: with `seen_through: 0` every item is after it, so
// "added before the watermark" would not be under test at all. `903` sits exactly ON it,
// which pins the boundary as `<=` — the moment you mark everything seen, everything you just
// saw must stay gone.
await fs.writeFile(STATE, `seen_through: ${1_800_000_000 - 10_000}\ndismissed: []\n`);

process.env.SETS_PATH = SETS;
process.env.QUEUES_PATH = QUEUES;
process.env.PENDING_PATH = STATE;

const pending = await import('../server/src/pending.js');

const NOW = 1_800_000_000;
const OLD = NOW - 10_000;

// Every item is NEW (added after the watermark of 0). What differs is whether something
// already covers it.
const SHOWS: PlexMetadata[] = [
  { ratingKey: '700', title: 'Covered By Rule', contentRating: 'TV-Y', addedAt: NOW, type: 'show' },
  { ratingKey: '701', title: 'Too Old For The Pool', contentRating: 'TV-MA', addedAt: NOW, type: 'show' },
  { ratingKey: '708', title: 'Blocked By That Pool', contentRating: 'TV-Y', addedAt: NOW, type: 'show' },
];
const MOVIES: PlexMetadata[] = [
  { ratingKey: '900', title: 'Nobody Wants Me', year: 2024, contentRating: 'PG', addedAt: NOW, type: 'movie' },
  { ratingKey: '901', title: 'Named Film', year: 2020, contentRating: 'PG', addedAt: NOW, type: 'movie' },
  { ratingKey: '902', title: 'In The Collection', year: 2019, contentRating: 'PG', addedAt: NOW, type: 'movie' },
  { ratingKey: '903', title: 'Added Ages Ago', year: 2001, contentRating: 'PG', addedAt: OLD, type: 'movie' },
];

const DEMOS: PlexMetadata[] = [
  { ratingKey: '990', title: '[QC] test encode x265-10bit', addedAt: NOW, type: 'movie' },
];

const listSection = async (sectionId: number, type: 1 | 2): Promise<PlexMetadata[]> => {
  if (sectionId === 5 && type === 2) return SHOWS;
  if (sectionId === 1 && type === 1) return MOVIES;
  if (sectionId === 8 && type === 1) return DEMOS;
  return [];
};

const fakeClient = {
  async accountToken() { return null; },
  async container(path: string) {
    if (path.startsWith('/library/sections/1/collections')) {
      return { Metadata: [{ ratingKey: '5500', title: 'Bunny Films', type: 'collection' }] };
    }
    if (path === '/library/collections/5500/children') {
      return { Metadata: [{ ratingKey: '902', title: 'In The Collection', type: 'movie' }] };
    }
    return { Metadata: [] };
  },
} as unknown as PlexClient;

// The libraries are a PARAMETER, so this needs no server and no stubbing of an ES module.
// Music Videos is here to prove a non-video library is never scanned at all.
const LIBRARIES = [
  { id: 5, title: 'Shows', video: true, type: 'show' },
  { id: 1, title: 'Movies', video: true, type: 'movie' },
  { id: 7, title: 'Music Videos', video: false, type: 'movie' },
  // "Other Videos" — Personal Media. Nothing draws from it, so it must not be reported:
  // on the first real run these were 7 of 11 rows, every one a test encode of one clip.
  { id: 8, title: 'Demos', video: true, type: 'movie', other: true },
];

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

const keysNow = async () =>
  (await pending.pendingItems(fakeClient, LIBRARIES, listSection)).items.map((i) => i.ratingKey);

// --- the subtraction ----------------------------------------------------------- //
const first = await keysNow();
check('only what nothing plays is pending', first.sort(), ['701', '708', '900']);
check('a show the pool RULE already sweeps up is not pending', first.includes('700'), false);
check('a film a queue names by ratingKey is not pending', first.includes('901'), false);
check('a film inside a named COLLECTION is not pending', first.includes('902'), false);
check('an item added ON the watermark is not pending (the boundary is <=)', first.includes('903'), false);
// The two that SHOULD surface, and why each one is not covered:
check('a show outside the pool\'s rating cap IS pending', first.includes('701'), true);
check('a show the pool BLOCKED is pending — blocked means nothing plays it', first.includes('708'), true);
check('a library no set draws from is pending', first.includes('900'), true);

// A non-video library is never listed at all.
check('a non-video library is not scanned', first.includes('999'), false);
check('an Other Videos library nothing draws from is not reported', first.includes('990'), false);

// --- dismiss ------------------------------------------------------------------- //
await pending.dismiss('900');
check('a dismissed item leaves the list', (await keysNow()).includes('900'), false);
check('…and its neighbours stay', (await keysNow()).sort(), ['701', '708']);
await pending.dismiss('900');
check('dismissing twice is a double-click, not an error',
  (await pending.readState()).dismissed.filter((k) => k === '900').length, 1);

// --- mark all seen ------------------------------------------------------------- //
await pending.markSeen(NOW);
check('marking seen empties the list in one gesture', await keysNow(), []);
check('the watermark is what did it', (await pending.readState()).seen_through, NOW);

// Something that arrives AFTER the watermark is new again — the watermark is a floor, not an
// off switch.
MOVIES.push({ ratingKey: '910', title: 'Arrived Later', year: 2025, contentRating: 'PG', addedAt: NOW + 500, type: 'movie' });
check('a later arrival is new again', await keysNow(), ['910']);

console.log(failed ? `pending FAILED (${failed})` : 'pending OK');
process.exit(failed ? 1 : 0);
