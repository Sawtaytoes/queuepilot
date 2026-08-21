// PENDING: what arrived that nothing is going to play.
//
// "a 'Pending' or 'New' area to show if there are new movies or shows added and allow me to
// specify the queues to add them IF they're not already picked up by one" — the `if` is the
// feature. A list of everything recently added is Plex's own Recently Added; the useful list
// is the one that has already subtracted everything the household will see anyway.
//
// So the assertions here are about SUBTRACTION, not about listing. Hermetic: a fake section
// lister and a fake Plex client, no server and no network.
//
// 2026-08-21 — three symptoms of ONE identity bug, reported together by the owner: "that page
// shouldn't show stuff I've watched already nor stuff already in another queue. I was able to
// double-add [a show] to my anime queue (and removed one) because I had 2 copies in there."
// A queue entry has two possible identities — a ratingKey or a bare TITLE — and nothing
// reconciled them, so a title-only entry covered nothing and the duplicate check could not see
// it. Watch state was never subtracted at all. All three are pinned below.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import type { PlexClient, PlexMetadata } from '../server/src/types.js';

const SETS = '/tmp/sets-pending-test.yaml';
const QUEUES = '/tmp/queues-pending-test.yaml';
const STATE = '/tmp/pending-test.yaml';

// A filtered pool over Shows (5) capped at TV-Y, a curated queue naming one film by
// ratingKey, a curated pool naming a COLLECTION, and an anime queue over Shows (5) whose
// entries name their shows by TITLE ALONE — the shape 84 of the owner's live entries use.
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
- id: anime
  label: Anime
  kind: anime
  source: queue
  sections: [ 5 ]
`);
await fs.writeFile(
  QUEUES,
  [
    'my_movies:',
    '- ratingKey: "901"',
    '  title: Named Film (2020)',
    // A TITLE with no rating key, for a film that two library items answer to (see
    // COPY_OLD / COPY_NEW). Still a legal entry: a hand-added line has no key until the
    // editor writes one back.
    '- {title: "Copy Cat"}',
    // A title Plex no longer answers to — the fail-safe case.
    '- {title: "Gone From The Library"}',
    'franchise:',
    '- {collection: "Bunny Films"}',
    'anime:',
    // The reported shape: a title, no ratingKey. This is the entry that covered nothing.
    '- {title: "Detective Days"}',
    // The same thing spelled as a block mapping, which is how the live file writes it.
    '- title: Kurozuka',
    '',
  ].join('\n'),
);
// A REAL watermark, not an empty file: with `seen_through: 0` every item is after it, so
// "added before the watermark" would not be under test at all. `903` sits exactly ON it,
// which pins the boundary as `<=` — the moment you mark everything seen, everything you just
// saw must stay gone.
await fs.writeFile(STATE, `seen_through: ${1_800_000_000 - 10_000}\ndismissed: []\n`);

process.env.SETS_PATH = SETS;
process.env.QUEUES_PATH = QUEUES;
process.env.PENDING_PATH = STATE;

const pending = await import('../server/src/pending.js');
const queues = await import('../server/src/queues.js');
const routing = await import('../server/src/engine/routing.js');
const { findDuplicateItem } = await import('../server/src/entryIdentity.js');

const NOW = 1_800_000_000;
const OLD = NOW - 10_000;

// Every item is NEW (added after the watermark of 0). What differs is whether something
// already covers it — or whether it has already been watched.
const SHOWS: PlexMetadata[] = [
  { ratingKey: '700', title: 'Covered By Rule', contentRating: 'TV-Y', addedAt: NOW, type: 'show' },
  { ratingKey: '701', title: 'Too Old For The Pool', contentRating: 'TV-MA', addedAt: NOW, type: 'show' },
  { ratingKey: '708', title: 'Blocked By That Pool', contentRating: 'TV-Y', addedAt: NOW, type: 'show' },
  // Named by a bare-title entry and by a {title:} mapping respectively. Both TV-MA, so the
  // kid pool's rating cap does not cover them and only the title lookup can.
  { ratingKey: '705', title: 'Detective Days', contentRating: 'TV-MA', addedAt: NOW, type: 'show' },
  { ratingKey: '706', title: 'Kurozuka', contentRating: 'TV-MA', addedAt: NOW, type: 'show' },
  // Watch state. Nothing names either, so ONLY the watched rule can remove one.
  { ratingKey: '709', title: 'Every Episode Seen', contentRating: 'TV-MA', addedAt: NOW, type: 'show', leafCount: 12, viewedLeafCount: 12 },
  { ratingKey: '710', title: 'One Episode Left', contentRating: 'TV-MA', addedAt: NOW, type: 'show', leafCount: 12, viewedLeafCount: 11 },
];
/** Two library items answer to "Copy Cat"; the engine resolves the entry to the LOWER key. */
const COPY_OLD = '904';
const COPY_NEW = '905';
const MOVIES: PlexMetadata[] = [
  { ratingKey: '900', title: 'Nobody Wants Me', year: 2024, contentRating: 'PG', addedAt: NOW, type: 'movie' },
  { ratingKey: '901', title: 'Named Film', year: 2020, contentRating: 'PG', addedAt: NOW, type: 'movie' },
  { ratingKey: '902', title: 'In The Collection', year: 2019, contentRating: 'PG', addedAt: NOW, type: 'movie' },
  { ratingKey: '903', title: 'Added Ages Ago', year: 2001, contentRating: 'PG', addedAt: OLD, type: 'movie' },
  { ratingKey: COPY_OLD, title: 'Copy Cat', year: 1995, contentRating: 'PG', addedAt: NOW, type: 'movie' },
  { ratingKey: COPY_NEW, title: 'Copy Cat', year: 2024, contentRating: 'PG', addedAt: NOW, type: 'movie' },
  // The fail-safe: the queue names this by title, and the title search below never answers.
  { ratingKey: '906', title: 'Gone From The Library', year: 2010, contentRating: 'PG', addedAt: NOW, type: 'movie' },
  // Watch state. Plex OMITS a count at 0, so an unwatched film simply has no viewCount.
  { ratingKey: '907', title: 'Seen It', year: 2023, contentRating: 'PG', addedAt: NOW, type: 'movie', viewCount: 1 },
  { ratingKey: '908', title: 'Started And Left', year: 2023, contentRating: 'PG', addedAt: NOW, type: 'movie', viewOffset: 900_000 },
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

/**
 * Titles Plex does NOT answer to, however they got into queues.yaml — a hand-typed entry, a
 * metadata-agent rename, a deleted-and-re-added item. The fail-safe under test is that such an
 * entry covers NOTHING, so its item stays on the list rather than being hidden by a guess.
 */
const UNANSWERED = new Set(['gone from the library']);

/** Every title lookup the resolver makes, so a "costs no Plex call" claim can be asserted. */
const titleLookups: string[] = [];

const fakeClient = {
  async accountToken() { return null; },
  async container(path: string) {
    if (path.startsWith('/library/sections/1/collections')) {
      return { Metadata: [{ ratingKey: '5500', title: 'Bunny Films', type: 'collection' }] };
    }
    if (path === '/library/collections/5500/children') {
      return { Metadata: [{ ratingKey: '902', title: 'In The Collection', type: 'movie' }] };
    }
    // The section title search `resolve.resolveTitle` makes. Plex matches loosely and the
    // resolver scores the candidates, so this answers with a substring match and lets the
    // real scoring (exact title, year, lowest-ratingKey tie-break) do the deciding.
    const sec = /^\/library\/sections\/(\d+)\/all\?/.exec(path);
    if (sec) {
      const wanted = String(new URL(`http://x${path}`).searchParams.get('title') || '').toLowerCase();
      titleLookups.push(wanted);
      if (!wanted || UNANSWERED.has(wanted)) return { Metadata: [] };
      const pool = sec[1] === '5' ? SHOWS : sec[1] === '1' ? MOVIES : [];
      return { Metadata: pool.filter((m) => String(m.title).toLowerCase().includes(wanted)) };
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
check('only what nothing plays is pending', first.sort(),
  ['701', '708', '710', '900', COPY_NEW, '906']);
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

// --- coverage by TITLE (the reported bug) -------------------------------------- //
// The entry is `- "Detective Days"`: a bare string, no ratingKey. It used to contribute
// nothing at all, so the show it names was reported as new and could be added a second time.
check('a BARE TITLE entry covers the show it names', first.includes('705'), false);
check('a {title:} mapping with no ratingKey covers its show too', first.includes('706'), false);
// The collection arm has to keep working, unchanged — it is the other title-shaped entry.
check('a collection entry still covers its children', first.includes('902'), false);

// COVERED means what the ENGINE would play, not "some item shares this title". Two films
// answer to "Copy Cat"; the resolver's tie-break takes the LOWER ratingKey, so the new
// arrival is genuinely not what that entry plays and stays on the list.
check('a title entry covers the item the engine resolves it to', first.includes(COPY_OLD), false);
check('…and not a same-titled NEW arrival the engine would never pick', first.includes(COPY_NEW), true);

// FAIL-SAFE: a title nothing in Plex answers to covers nothing, so its item stays visible.
// A hand-typed title that no longer matches the library is a broken entry — nothing is going
// to play it, which is exactly what this screen reports.
check('a title Plex cannot resolve leaves its item PENDING', first.includes('906'), true);

// The pre-filter is what keeps this affordable: a title entry is only looked up when some new
// arrival could plausibly be the thing it names.
check('only the title entries a new arrival could match are looked up',
  [...new Set(titleLookups)].sort(), ['copy cat', 'detective days', 'gone from the library', 'kurozuka']);

// --- already watched ----------------------------------------------------------- //
check('a watched MOVIE is not pending', first.includes('907'), false);
check('a movie left at a resume point is not pending either', first.includes('908'), false);
check('a FULLY watched show is not pending', first.includes('709'), false);
check('a show with one unplayed episode IS still pending', first.includes('710'), true);

// --- dismiss ------------------------------------------------------------------- //
await pending.dismiss('900');
check('a dismissed item leaves the list', (await keysNow()).includes('900'), false);
check('…and its neighbours stay', (await keysNow()).sort(), ['701', '708', '710', COPY_NEW, '906']);
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

// --- the double-add ------------------------------------------------------------ //
// The owner added a show his anime queue ALREADY held, because the queue named it by title
// (`title:Detective Days`) and the Pending tile posted a ratingKey (`rk:705`). Two different
// `entryKey`s, so `addItem`'s exact-key check passed and a second copy landed.
//
// `entryKey` is unchanged and must stay so — the Python writer addresses the same lines by it
// and the golden parity oracles record what it returns. The duplicate test is a SECOND,
// looser identity check that asks which ITEM an entry names.
const animeCfg = routing.loadSets()!.sets.anime!;
const asAdded = { ratingKey: '705', title: 'Detective Days' };

const dup = await findDuplicateItem(fakeClient, animeCfg, await queues.listSet('anime'), asAdded);
check('adding a ratingKey a TITLE entry already names is a duplicate', dup?.key, 'title:Detective Days');
check('…and it reports the item both entries resolve to', dup?.ratingKey, '705');

const notDup = await findDuplicateItem(
  fakeClient, animeCfg, await queues.listSet('anime'), { ratingKey: '710', title: 'One Episode Left' },
);
check('a show the queue does NOT hold is not a duplicate', notDup, null);

// `entryKey` alone still cannot see it — which is the whole reason the second check exists.
check('entryKey still keys the two forms differently (unchanged, on purpose)',
  [queues.entryKey('Detective Days'), queues.entryKey(asAdded)],
  ['title:Detective Days', 'rk:705']);

// And the file: one copy before, one copy after. The route refuses the add; `addItem` is
// never reached, so nothing is written.
const beforeAdd = await queues.listSet('anime');
if (!dup) await queues.addItem('anime', asAdded, 'bottom');
const afterAdd = await queues.listSet('anime');
check('the queue still holds ONE copy of the show', afterAdd.length, beforeAdd.length);
check('…and it is still the original title line', afterAdd.map((e) => e.key).includes('title:Detective Days'), true);

// A genuinely new item still lands.
await queues.addItem('anime', { ratingKey: '710', title: 'One Episode Left' }, 'bottom');
check('a show the queue did not hold is still added',
  (await queues.listSet('anime')).map((e) => e.key).includes('rk:710'), true);

// A COLLECTION is not an item, and adding one is never reported as a duplicate: whether a
// queued collection should block adding one of its films is a coverage question, not an
// identity one, and answering it here would refuse an add the owner may well mean.
const collDup = await findDuplicateItem(
  fakeClient, routing.loadSets()!.sets.franchise!, await queues.listSet('franchise'), 'Collection: Bunny Films',
);
check('a collection add is never an item duplicate', collDup, null);

console.log(failed ? `pending FAILED (${failed})` : 'pending OK');
process.exit(failed ? 1 : 0);
