// Offline gate for the KAVITA PROVIDER and the 302 launcher.
//
// Every HTTP call is stubbed, so this runs with no token, no network and no Kavita. The stub
// responses are shaped from the LIVE probes recorded in docs/kavita-feasibility.md §2-§3 and
// re-verified against the instance on 2026-08-13 — including two things the endpoint table
// alone does not tell you, both of which are asserted here:
//
//   * `Reader/continue-point` returns a ChapterDto whose seriesId is NULL. The provider must
//     thread the series back in from the argument rather than trusting the response, or every
//     deep link it builds points at series `null`.
//   * `ReadingList/lists` is a POST, not a GET.
//
// What it guards beyond that:
//   * the reader deep link matches the shape read out of the live Angular bundle, INCLUDING
//     ?readingListId= — which is what makes next/prev resolve through the LIST rather than the
//     series, i.e. the native cross-series auto-advance the whole feature needs.
//   * the manga/book/pdf variant is chosen by seriesFormat. A mixed-format list bounces the
//     reader between variants, so getting this wrong is a silently bad reading experience.
//   * handoff() returns a URL and never a device push. Kavita has NO cast and NO webhooks.
//   * the reading list is REBUILT and REUSED per set, never accumulated — it is the runtime
//     artifact, never the store.
//   * the launcher refuses a push provider, an unconfigured provider and a mixed queue, each
//     with its own status, rather than redirecting somewhere useless.
//
// Run:  server/node_modules/.bin/tsx e2e/kavita-provider-test.ts   (repo root; non-zero on failure)
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { errMessage } from '../server/src/errors.js';
import type {
  BucketsResult, KavitaArtifact, KavitaPlayItem, KavitaProgressState, PlexClient, PullResult,
} from '../server/src/types.js';
import type { KavitaHttpClient } from '../server/src/providers/kavita-client.js';

const SCRATCH = mkdtempSync(path.join(tmpdir(), 'kavita-'));
// Local consts alongside the env assignment: `process.env.X` reads back as
// `string | undefined`, and both files are written below.
const SETS_PATH = path.join(SCRATCH, 'sets.yaml');
const QUEUES_PATH = path.join(SCRATCH, 'queues.yaml');
process.env.PROVIDERS_PATH = path.join(SCRATCH, 'providers.yaml');
process.env.PROVIDERS_SECRETS_PATH = path.join(SCRATCH, 'providers.secrets.yaml');
process.env.SETS_PATH = SETS_PATH;
process.env.QUEUES_PATH = QUEUES_PATH;
process.env.CACHE_PATH = path.join(SCRATCH, 'cache.sqlite');
process.env.KAVITA_API_SERVER_URL = 'https://kavita.invalid';

writeFileSync(QUEUES_PATH, 'reading: []\n');
writeFileSync(
  SETS_PATH,
  'sets:\n'
  + '  - id: reading\n    label: Reading\n    source: rotation\n'
  + '    providers:\n      - provider: kavita\n        libraries: [5]\n'
  + '  - id: tv\n    label: TV\n    source: rotation\n    sections: [5]\n'
  + '  - id: mixed\n    label: Mixed\n    source: rotation\n'
  + '    providers:\n      - provider: plex\n        libraries: [5]\n'
  + '      - provider: kavita\n        libraries: [2]\n',
);

const FAILS: string[] = [];
async function ok(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}  -- ${errMessage(e)}`);
    FAILS.push(name);
  }
}

// --------------------------------------------------------------------------- //
// The shapes this suite reads back. Everything it drives is the Kavita provider, so the
// provider-neutral returns are always their Kavita half — declared once here instead of
// casting at each of the ~40 reads below.
// --------------------------------------------------------------------------- //

/** `buckets()`'s return as the Kavita provider fills it. */
interface KavitaBuckets extends Omit<BucketsResult, 'play' | 'buckets'> {
  play: KavitaPlayItem[];
  buckets: { seriesId: number }[];
}

/** A stubbed chapter — the ChapterDto fields the provider reads, seriesId nullable as live. */
interface StubChapter {
  id: number;
  number: string;
  title?: string;
  pages: number;
  pagesRead: number;
  seriesId?: number | null;
  minNumber?: number;
}

/** A stubbed series row. */
interface StubSeries {
  id: number;
  name: string;
  libraryId: number;
  format: number;
}

/** A recorded call: the method name plus whatever arguments it was given. */
type Call = (string | number)[];

/**
 * The stub speaks the SUBSET of `KavitaHttpClient` these paths touch, plus the `_calls` /
 * `_added` / `_lists` recorders the assertions read. `asClient` is the one place that admits
 * the partial — including for the `{...stubClient(), async seriesForLibrary() {…}}` overrides,
 * whose spread would otherwise have to restate every method.
 */
const asClient = (c: unknown): KavitaHttpClient => c as unknown as KavitaHttpClient;

// --------------------------------------------------------------------------- //
// The stub Kavita. Records every call so the test can assert on the WIRE, not just
// the return value — "is it a POST" is exactly the kind of thing that silently regresses.
// --------------------------------------------------------------------------- //
const CALLS: Call[] = [];
const SERIES: StubSeries[] = [
  { id: 747, name: 'A Flame Reborn', libraryId: 5, format: 1 },
  { id: 3882, name: 'A Hero Who Knows His Stuff', libraryId: 5, format: 1 },
  { id: 900, name: 'Finished Series', libraryId: 5, format: 1 },
  { id: 901, name: 'An EPUB Book', libraryId: 6, format: 3 },
];
// Shaped like the live ChapterDto: note seriesId is NULL, exactly as the real one returns.
const CONTINUE: Record<string, StubChapter | null> = {
  747: { id: 86090, number: '113', title: '113', pages: 152, pagesRead: 0, seriesId: null },
  3882: { id: 90001, number: '42', title: '42', pages: 100, pagesRead: 0, seriesId: null },
  900: null,
  901: { id: 90002, number: '1', title: 'Ch 1', pages: 50, pagesRead: 0, seriesId: null },
};

interface StubList { id: number; title: string; ownerUserName?: string; coverImageLocked?: boolean }
interface AddedChapter { readingListId: number; seriesId: number; chapterId: number }
interface UploadedCover { readingListId: number | string; imageBase64: string }

interface ListPatch { title: string; summary: string; promoted: boolean; coverImageLocked: boolean }

function stubClient(
  { existingLists = [], coverFails = false, renameFails = false }:
  { existingLists?: StubList[]; coverFails?: boolean; renameFails?: boolean } = {},
) {
  const lists: StubList[] = existingLists.map((l) => ({ ...l }));
  let nextListId = 500;
  const added: AddedChapter[] = [];
  const deleted: { readingListId: number | string; readingListItemId: number | string }[] = [];
  const covers: UploadedCover[] = [];
  const renames: { readingListId: number | string; patch: ListPatch }[] = [];
  return {
    _base: 'https://kavita.invalid',
    _calls: CALLS,
    _added: added,
    _deleted: deleted,
    _covers: covers,
    _renames: renames,
    _lists: lists,
    async whoami() { CALLS.push(['whoami']); return 'Sawtaytoes'; },
    async libraries() {
      CALLS.push(['libraries']);
      return [{ id: 5, name: 'Webtoons', type: 0 }, { id: 6, name: 'Books', type: 2 }];
    },
    async seriesForLibrary(libraryId: number | string) {
      CALLS.push(['seriesForLibrary', String(libraryId)]);
      return SERIES.filter((s) => String(s.libraryId) === String(libraryId));
    },
    async continuePoint(seriesId: number | string) {
      CALLS.push(['continuePoint', String(seriesId)]);
      const ch = CONTINUE[String(seriesId)];
      if (!ch) return null;
      // Mirror the real client's contract: it threads seriesId back in.
      return { ...ch, seriesId: ch.seriesId ?? Number(seriesId) };
    },
    // This library has exactly ONE unread chapter per series, so a batch larger than one
    // must cap here rather than invent items.
    async seriesDetail(seriesId: number | string) {
      CALLS.push(['seriesDetail', String(seriesId)]);
      const ch = CONTINUE[String(seriesId)];
      return { chapters: ch ? [{ ...ch, minNumber: Number(ch.number) || 1 }] : [], specials: [], volumes: [] };
    },
    async readingLists() { CALLS.push(['readingLists', 'POST']); return lists; },
    async createList(title: string) {
      CALLS.push(['createList', title]);
      const l = { id: nextListId, title, ownerUserName: 'Sawtaytoes' };
      nextListId += 1;
      lists.push(l);
      return l;
    },
    async addChapter(readingListId: number, seriesId: number, chapterId: number) {
      CALLS.push(['addChapter', readingListId, seriesId, chapterId]);
      added.push({ readingListId, seriesId, chapterId });
    },
    // `id` is the reading-list ITEM's own id, distinct from `chapterId` — it is what
    // `delete-item` addresses, and the two are not interchangeable.
    async readingListItems(id: number | string) {
      CALLS.push(['readingListItems', id]);
      return [
        { id: 9001, chapterId: 86090, seriesId: 747, order: 0, pagesRead: 152, pagesTotal: 152, lastReadingProgressUtc: '2026-08-13T00:00:00Z' },
        { id: 9002, chapterId: 90001, seriesId: 3882, order: 1, pagesRead: 10, pagesTotal: 100, lastReadingProgressUtc: null },
      ];
    },
    async deleteItem(readingListId: number | string, readingListItemId: number | string) {
      CALLS.push(['deleteItem', readingListId, readingListItemId]);
      deleted.push({ readingListId, readingListItemId });
    },
    async updateList(readingListId: number | string, patch: ListPatch) {
      CALLS.push(['updateList', readingListId, patch.title]);
      if (renameFails) throw new Error('kavita POST /api/ReadingList/update -> HTTP 500');
      renames.push({ readingListId, patch });
      const row = lists.find((l) => String(l.id) === String(readingListId));
      // Apply it the way the live endpoint does — the WHOLE DTO, no patch semantics. That is
      // what makes `coverImageLocked: false` here destructive, and the stub must not be kinder
      // than Kavita or the gate below would prove nothing.
      if (row) {
        row.title = patch.title;
        row.coverImageLocked = patch.coverImageLocked;
      }
    },
    async uploadListCover(readingListId: number | string, imageBase64: string) {
      CALLS.push(['uploadListCover', readingListId]);
      // The live endpoint's own failure mode, as a switch: it answers 400 for a payload it
      // cannot decode, and the provider must survive that.
      if (coverFails) throw new Error('kavita POST /api/Upload/reading-list -> HTTP 400');
      covers.push({ readingListId, imageBase64 });
    },
  };
}

const { kavitaProvider, sameLibraryPrefix } = await import('../server/src/providers/kavita.js');
const { readerSegment, FORMAT } = await import('../server/src/providers/kavita-client.js');
const DEF = { id: 'kavita', kind: 'kavita', label: 'Kavita', base_url: 'https://kavita.invalid' };

// --------------------------------------------------------------------------- //
// buckets
// --------------------------------------------------------------------------- //
await ok('buckets skips a series with nothing unread', async () => {
  CALLS.length = 0;
  const p = kavitaProvider({ def: DEF, client: asClient(stubClient()) });
  const { play, buckets } = await p.buckets({ libraries: ['5'] }) as KavitaBuckets;
  const ids = buckets.map((b) => b.seriesId);
  assert.ok(!ids.includes(900), 'the finished series produced a bucket');
  assert.equal(play.length, 2);
});

await ok('continue-point returning a NULL seriesId is repaired, not propagated', async () => {
  const p = kavitaProvider({ def: DEF, client: asClient(stubClient()) });
  const { play } = await p.buckets({ libraries: ['5'] }) as KavitaBuckets;
  for (const it of play) {
    assert.notEqual(it.seriesId, null, 'a null seriesId reached the lineup');
    assert.equal(typeof it.seriesId, 'number');
  }
});

await ok('a FULLY READ series never enters a lineup — continue-point WRAPS', async () => {
  // Reader/continue-point is "where would you resume", not "the next unread chapter". On a
  // finished series it hands back chapter 1 ALREADY READ — verified live on six Webtoons
  // series (e.g. "Ultimate Shut-in": chapter 1 at 183/183 pages, unreadCount 0). Trusting it
  // re-queues finished series forever, which breaks the property the whole design leans on:
  // that Kavita's read state IS the done store.
  const c = {
    ...stubClient(),
    async seriesForLibrary() {
      return [
        { id: 10, name: 'Finished', libraryId: 9, format: 1 },
        { id: 11, name: 'Has More', libraryId: 9, format: 1 },
      ];
    },
    async continuePoint(id: number | string) {
      return Number(id) === 10
        // The wrap: chapter 1, fully read.
        ? { id: 1001, number: '1', pages: 183, pagesRead: 183, seriesId: 10 }
        : { id: 1101, number: '42', pages: 20, pagesRead: 0, seriesId: 11 };
    },
  };
  const p = kavitaProvider({ def: DEF, client: asClient(c) });
  const { play, buckets } = await p.buckets({ libraries: ['9'], batch: 1, limit: 12 }) as KavitaBuckets;
  assert.deepEqual(buckets.map((b) => b.seriesId), [11], 'a finished series entered the lineup');
  assert.equal(play.length, 1);
});

await ok('a chapter of UNKNOWN length is kept, not silently dropped', async () => {
  // pages: 0 means Kavita does not know the length. Treating that as "read" would make a
  // whole series vanish from the rotation for a metadata gap.
  const c = {
    ...stubClient(),
    async seriesForLibrary() { return [{ id: 12, name: 'Unknown', libraryId: 9, format: 1 }]; },
    async continuePoint() { return { id: 1200, number: '1', pages: 0, pagesRead: 0, seriesId: 12 }; },
  };
  const p = kavitaProvider({ def: DEF, client: asClient(c) });
  const { play } = await p.buckets({ libraries: ['9'], batch: 1, limit: 12 }) as KavitaBuckets;
  assert.equal(play.length, 1);
});

await ok('a batch of 1 still caps at what exists (no invented items)', async () => {
  const p = kavitaProvider({ def: DEF, client: asClient(stubClient()) });
  const { play } = await p.buckets({ libraries: ['5'], batch: 3 }) as KavitaBuckets;
  // This stub exposes ONE unread chapter per series, so 3 must not become 3.
  assert.equal(play.length, 2);
});

// --------------------------------------------------------------------------- //
// The batch knob, against a series that actually HAS a run of chapters.
//
// The original test for this asserted only the cap-at-what-exists case above, against a stub
// with one chapter per series — so it passed while `buckets` was structurally incapable of
// ever returning more than one chapter, and "read 3 chapters, then switch series" (the
// opening ask in the feasibility record) did not work at all. A knob's test has to give it
// something to actually do.
// --------------------------------------------------------------------------- //
function runStub() {
  const many: StubSeries[] = [
    { id: 1, name: 'Series A', libraryId: 9, format: 1 },
    { id: 2, name: 'Series B', libraryId: 9, format: 1 },
  ];
  const chapters = (sid: number): StubChapter[] => Array.from({ length: 6 }, (_, i) => ({
    id: sid * 1000 + i, number: String(i + 1), minNumber: i + 1,
    // First two of each series are fully read, so the unread run starts at chapter 3.
    pages: 20, pagesRead: i < 2 ? 20 : 0,
  }));
  const calls: Call[] = [];
  return {
    ...stubClient(),
    _calls: calls,
    async seriesForLibrary() { return many; },
    async continuePoint(id: number | string) {
      calls.push(['continuePoint', Number(id)]);
      return { id: Number(id) * 1000 + 2, number: '3', pages: 20, pagesRead: 0, seriesId: Number(id) };
    },
    async seriesDetail(id: number | string) {
      calls.push(['seriesDetail', Number(id)]);
      return { chapters: chapters(Number(id)), specials: [], volumes: [] };
    },
  };
}

await ok('batch: 3 queues THREE chapters of A, then three of B', async () => {
  const c = runStub();
  const p = kavitaProvider({ def: DEF, client: asClient(c) });
  const { play } = await p.buckets({ libraries: ['9'], batch: 3, limit: 12 }) as KavitaBuckets;
  assert.equal(play.length, 6, `got ${play.length} items`);
  assert.deepEqual(play.map((i) => i.seriesId), [1, 1, 1, 2, 2, 2]);
  // …and they are consecutive UNREAD chapters, starting after the two already read.
  assert.deepEqual(play.slice(0, 3).map((i) => i.number), ['3', '4', '5']);
});

await ok('already-read chapters are skipped, not queued', async () => {
  const c = runStub();
  const p = kavitaProvider({ def: DEF, client: asClient(c) });
  const { play } = await p.buckets({ libraries: ['9'], batch: 6, limit: 12 }) as KavitaBuckets;
  for (const it of play) {
    assert.notEqual(it.number, '1', 'a fully-read chapter was queued');
    assert.notEqual(it.number, '2', 'a fully-read chapter was queued');
  }
});

await ok('batch: 1 uses continue-point, NOT the heavier series-detail call', async () => {
  // One chapter is the common case and continue-point answers it in a single call; paying
  // for the full chapter list per series would be a needless fan-out on every launch.
  const c = runStub();
  const p = kavitaProvider({ def: DEF, client: asClient(c) });
  await p.buckets({ libraries: ['9'], batch: 1, limit: 12 }) as KavitaBuckets;
  assert.ok(c._calls.some((x) => x[0] === 'continuePoint'), 'continue-point was not used');
  assert.ok(!c._calls.some((x) => x[0] === 'seriesDetail'), 'series-detail was called for a batch of 1');
});

await ok('a fully-read series yields no bucket even with a batch', async () => {
  const c = {
    ...runStub(),
    async seriesDetail() { return { chapters: [{ id: 1, number: '1', minNumber: 1, pages: 20, pagesRead: 20 }] }; },
  };
  const p = kavitaProvider({ def: DEF, client: asClient(c) });
  const { play } = await p.buckets({ libraries: ['9'], batch: 3, limit: 12 }) as KavitaBuckets;
  assert.equal(play.length, 0);
});

await ok('no libraries selected reads EVERY library, not none', async () => {
  // Reversal of the old "yields nothing" rule (decision
  // 2026-08-17-no-libraries-checked-means-every-library): an empty checkbox group means
  // all of them, and the editor now says so. A rule-based queue with no scope therefore
  // asks Kavita what its libraries are and draws from the lot.
  CALLS.length = 0;
  const p = kavitaProvider({ def: DEF, client: asClient(stubClient()) });
  const { play } = await p.buckets({ libraries: [] }) as KavitaBuckets;
  assert.ok(play.length > 0, 'an unscoped queue drew nothing');
  assert.ok(
    CALLS.some(([fn]) => fn === 'libraries'),
    'the library list was never asked for, so the scope cannot have been widened',
  );
  // Both stub libraries, not just the first.
  assert.deepEqual(
    CALLS.filter(([fn]) => fn === 'seriesForLibrary').map(([, id]) => id).sort(),
    ['5', '6'],
  );
});

await ok('a CURATED queue never widens: entries beat libraries', async () => {
  // The widening above is the rule-based branch only. A queue with entries must not
  // enumerate a shelf — that is the 93-entry reading-list bug, and asking for the library
  // list here would be a request per launch that nothing reads.
  CALLS.length = 0;
  const p = kavitaProvider({ def: DEF, client: asClient(stubClient()) });
  await p.buckets({ entries: [{ id: '1' }], libraries: [] }) as KavitaBuckets;
  assert.ok(
    CALLS.every(([fn]) => fn !== 'libraries' && fn !== 'seriesForLibrary'),
    `a curated queue enumerated libraries: ${JSON.stringify(CALLS)}`,
  );
});

await ok('the lineup is CAPPED — a big library does not queue its whole backlog', async () => {
  // Measured against the live instance: Webtoons alone has 103 series with something
  // unread. Uncapped that is 103 sequential writes per launch, for a reading list nobody
  // reaches the end of. The Plex rotation has always capped; so does this.
  const many: StubSeries[] = Array.from({ length: 50 }, (_, i) => ({
    id: 1000 + i, name: `S${i}`, libraryId: 9, format: 1,
  }));
  const c = {
    ...stubClient(),
    async seriesForLibrary() { return many; },
    async continuePoint(id: number | string) { return { id: Number(id) * 10, number: '1', pages: 10, pagesRead: 0, seriesId: Number(id) }; },
  };
  const p = kavitaProvider({ def: DEF, client: asClient(c) });
  const { play, buckets } = await p.buckets({ libraries: ['9'], limit: 12 }) as KavitaBuckets;
  assert.equal(buckets.length, 50, 'every series should still be surveyed');
  assert.equal(play.length, 12, `capped lineup was ${play.length}`);
});

await ok('the cap never loops forever when buckets run dry early', async () => {
  // A library with fewer unread chapters than the cap must terminate, not spin.
  const p = kavitaProvider({ def: DEF, client: asClient(stubClient()) });
  const { play } = await p.buckets({ libraries: ['5'], limit: 100 }) as KavitaBuckets;
  assert.equal(play.length, 2);
});

await ok('the lineup INTERLEAVES series rather than draining one', async () => {
  // Rolling into a different series is the entire feature. If a queue drained series A
  // before touching B, it would be a single-series binge with extra steps.
  const many: StubSeries[] = [
    { id: 1, name: 'A', libraryId: 9, format: 1 },
    { id: 2, name: 'B', libraryId: 9, format: 1 },
  ];
  const c = {
    ...stubClient(),
    async seriesForLibrary() { return many; },
    async continuePoint(id: number | string) { return { id: Number(id) * 100, number: '1', pages: 10, pagesRead: 0, seriesId: Number(id) }; },
  };
  const p = kavitaProvider({ def: DEF, client: asClient(c) });
  const { play } = await p.buckets({ libraries: ['9'], limit: 2 }) as KavitaBuckets;
  assert.deepEqual(play.map((i) => i.seriesId), [1, 2], 'series were not interleaved');
});

// --------------------------------------------------------------------------- //
// materialize — the reading list is the runtime artifact, never the store
// --------------------------------------------------------------------------- //
await ok('materialize creates one list per set and adds chapters IN ORDER', async () => {
  CALLS.length = 0;
  const c = stubClient();
  const p = kavitaProvider({ def: DEF, client: asClient(c) });
  const { play } = await p.buckets({ libraries: ['5'] }) as KavitaBuckets;
  const art = await p.materialize(play, { setName: 'reading' }) as KavitaArtifact;
  assert.equal(art.kind, 'kavita');
  assert.match(art.title, /QueuePilot/);
  assert.match(art.title, /reading/);
  assert.equal(c._added.length, 2);
  assert.deepEqual(c._added.map((a) => a.chapterId), play.map((i) => i.chapterId));
});

await ok('materialize REUSES the set\'s existing list instead of littering new ones', async () => {
  const c = stubClient({ existingLists: [{ id: 42, title: 'QueuePilot — reading' }] });
  const p = kavitaProvider({ def: DEF, client: asClient(c) });
  const { play } = await p.buckets({ libraries: ['5'] }) as KavitaBuckets;
  const art = await p.materialize(play, { setName: 'reading' }) as KavitaArtifact;
  assert.equal(art.readingListId, 42);
  assert.equal(c._lists.length, 1, 'a duplicate list was created');
});

/**
 * The reuse assertion above was TRUE and not enough: it proved the list was not duplicated
 * and said nothing about its CONTENTS, so it stayed green while every launch appended to the
 * same list forever. The live list reached 23 series — every lineup ever built for that set,
 * unioned — and the owner reported it as "stuff I absolutely did NOT add".
 *
 * The docstring on materialize() had claimed "rebuilt on launch … rather than accumulated"
 * since the day it was written. This is that sentence, as a gate.
 */
await ok('materialize REBUILDS the list — last launch\'s items are removed first', async () => {
  CALLS.length = 0;
  const c = stubClient({ existingLists: [{ id: 42, title: 'QueuePilot — reading' }] });
  const p = kavitaProvider({ def: DEF, client: asClient(c) });
  const { play } = await p.buckets({ libraries: ['5'] }) as KavitaBuckets;
  await p.materialize(play, { setName: 'reading' });

  // Both pre-existing rows are addressed by their ITEM id (9001/9002), never by chapterId.
  assert.deepEqual(
    c._deleted.map((d) => d.readingListItemId).sort(),
    [9001, 9002],
    'the stale items were not cleared — the list accumulates',
  );
  assert.ok(c._deleted.every((d) => d.readingListId === 42), 'cleared the wrong list');

  // ORDER is the invariant, not just the presence of both calls: clearing AFTER adding would
  // delete this launch's own lineup and hand the reader an empty list.
  const lastDelete = CALLS.map((x) => x[0]).lastIndexOf('deleteItem');
  const firstAdd = CALLS.map((x) => x[0]).indexOf('addChapter');
  assert.ok(lastDelete < firstAdd, 'the clear ran after the rebuild, emptying the new lineup');
});

await ok('a BRAND-NEW list is not cleared — there is nothing to clear', async () => {
  const c = stubClient();
  const p = kavitaProvider({ def: DEF, client: asClient(c) });
  const { play } = await p.buckets({ libraries: ['5'] }) as KavitaBuckets;
  await p.materialize(play, { setName: 'reading' });
  assert.equal(c._deleted.length, 0, 'a freshly created list was pointlessly enumerated + cleared');
});

// ---------------------------------------------------------------------------
// the cover — the one part of the artifact that is NOT rebuilt per launch
//
// Kavita generates a list's cover from its first item and REGENERATES it whenever the items
// change, so a list this app rebuilds every launch wears a different interior page every time.
// These gates are about the artwork's LIFECYCLE, not its looks: written once, then left alone.

await ok('a brand-new list gets QueuePilot artwork, as RAW base64 SVG', async () => {
  const c = stubClient();
  const p = kavitaProvider({ def: DEF, client: asClient(c) });
  const { play } = await p.buckets({ libraries: ['5'] }) as KavitaBuckets;
  const art = await p.materialize(play, { setName: 'reading', setLabel: 'Reading' }) as KavitaArtifact;

  assert.equal(c._covers.length, 1, 'a new list was left with Kavita\'s auto-generated cover');
  const [cover] = c._covers;
  assert.ok(cover, 'no cover was uploaded');
  assert.equal(cover.readingListId, art.readingListId, 'the cover went to another list');
  // The `data:image/png;base64,` spelling is a 400 from the live endpoint. Asserting the
  // ABSENCE of the prefix is the only way this stays true — a stub cannot reject it for us.
  assert.ok(
    !cover.imageBase64.startsWith('data:'),
    'the payload carries a data: prefix, which the live endpoint answers 400 to',
  );
  const svg = Buffer.from(cover.imageBase64, 'base64').toString('utf8');
  assert.ok(svg.startsWith('<svg'), 'the payload did not decode to SVG markup');
  assert.ok(svg.includes('<path'), 'the SVG has no glyph paths — the label was not rendered');
});

/**
 * The label reaches the artwork. Satori converts glyphs to PATHS, so no assertion can look for
 * the text inside the SVG; two labels that render IDENTICALLY is the observable form of "the
 * cover ignored the label and drew something generic".
 */
await ok('the cover is drawn from the set LABEL, not its id', async () => {
  const draw = async (setLabel: string) => {
    const c = stubClient();
    const p = kavitaProvider({ def: DEF, client: asClient(c) });
    const { play } = await p.buckets({ libraries: ['5'] }) as KavitaBuckets;
    await p.materialize(play, { setName: 'reading', setLabel });
    return c._covers[0]?.imageBase64 ?? '';
  };
  assert.notEqual(
    await draw('Manga & Webtoons'),
    await draw('Bob — Anime'),
    'two different labels rendered the same cover',
  );
});

await ok('a list whose cover is already ours is left alone', async () => {
  const c = stubClient({
    existingLists: [{ id: 42, title: 'QueuePilot — reading', coverImageLocked: true }],
  });
  const p = kavitaProvider({ def: DEF, client: asClient(c) });
  const { play } = await p.buckets({ libraries: ['5'] }) as KavitaBuckets;
  await p.materialize(play, { setName: 'reading', setLabel: 'Reading' });
  assert.equal(c._covers.length, 0, 'the cover was re-uploaded on a launch that did not need it');
});

/**
 * `coverImageLocked: false` on an EXISTING list means Kavita is still generating that art
 * itself — a list built before this shipped. Uploading then is what heals it on the next
 * launch instead of requiring the owner to delete the list.
 */
await ok('an existing list still wearing Kavita\'s art gets ours', async () => {
  const c = stubClient({
    existingLists: [{ id: 42, title: 'QueuePilot — reading', coverImageLocked: false }],
  });
  const p = kavitaProvider({ def: DEF, client: asClient(c) });
  const { play } = await p.buckets({ libraries: ['5'] }) as KavitaBuckets;
  await p.materialize(play, { setName: 'reading', setLabel: 'Reading' });
  assert.equal(c._covers.length, 1, 'an unlocked list kept Kavita\'s per-launch cover');
  assert.equal(c._covers[0]?.readingListId, 42);
});

/**
 * A cover is decoration; a lineup is the point. This is the same best-effort rule the stale-
 * item clear follows, and for the same reason: a throw here would be a dead card.
 */
await ok('a cover that fails to upload does not cost the reader their lineup', async () => {
  CALLS.length = 0;
  const c = stubClient({ coverFails: true });
  const p = kavitaProvider({ def: DEF, client: asClient(c) });
  const { play } = await p.buckets({ libraries: ['5'] }) as KavitaBuckets;
  const art = await p.materialize(play, { setName: 'reading', setLabel: 'Reading' }) as KavitaArtifact;
  assert.ok(art.readingListId != null, 'materialize did not return a usable artifact');
  assert.ok(c._added.length > 0, 'the chapters never went on the list');
  // And it was TRIED — a green test here must not be "the upload was quietly skipped".
  assert.ok(
    CALLS.some((x) => x[0] === 'uploadListCover'),
    'no cover upload was attempted at all',
  );
});

// ---------------------------------------------------------------------------
// the title — the set's LABEL, on a list that keeps its id
//
// Lists were titled with the set ID until 2026-08-17 ("QueuePilot — manga_webtoons"). They
// carry the label now, and the existing ones are renamed IN PLACE, because the id is the
// `/lists/153` the owner has open and every link Kavita's own UI renders points at it.

await ok('a new list is titled with the set LABEL, not its id', async () => {
  const c = stubClient();
  const p = kavitaProvider({ def: DEF, client: asClient(c) });
  const { play } = await p.buckets({ libraries: ['5'] }) as KavitaBuckets;
  const art = await p.materialize(play, { setName: 'reading', setLabel: 'Manga & Webtoons' }) as KavitaArtifact;
  assert.equal(art.title, 'QueuePilot — Manga & Webtoons');
  assert.equal(c._lists[0]?.title, 'QueuePilot — Manga & Webtoons');
});

await ok('a list under the OLD id-title is renamed in place, keeping its id', async () => {
  CALLS.length = 0;
  const c = stubClient({ existingLists: [{ id: 42, title: 'QueuePilot — reading' }] });
  const p = kavitaProvider({ def: DEF, client: asClient(c) });
  const { play } = await p.buckets({ libraries: ['5'] }) as KavitaBuckets;
  const art = await p.materialize(play, { setName: 'reading', setLabel: 'Manga & Webtoons' }) as KavitaArtifact;

  assert.equal(art.readingListId, 42, 'the list id changed — every bookmark to it is now wrong');
  assert.ok(!CALLS.some((x) => x[0] === 'createList'), 'a second list was minted under the new title');
  assert.equal(c._lists.length, 1, 'the old list was left behind as a duplicate');
  assert.equal(c._renames.length, 1, 'the list kept its old id-title');
  assert.equal(c._renames[0]?.patch.title, 'QueuePilot — Manga & Webtoons');
});

/**
 * The one that actually costs something if it regresses. `POST /api/ReadingList/update` takes
 * the WHOLE DTO and applies every field: renaming with `coverImageLocked: false` on a list
 * that HAS an uploaded cover answers 200 and comes back `coverImage: ''` — Kavita drops the
 * artwork and starts generating one from the items again. Probed live, 2026-08-17.
 */
await ok('the rename ECHOES coverImageLocked — it does not wipe the artwork', async () => {
  const c = stubClient({
    existingLists: [{ id: 42, title: 'QueuePilot — reading', coverImageLocked: true }],
  });
  const p = kavitaProvider({ def: DEF, client: asClient(c) });
  const { play } = await p.buckets({ libraries: ['5'] }) as KavitaBuckets;
  await p.materialize(play, { setName: 'reading', setLabel: 'Manga & Webtoons' });

  assert.equal(
    c._renames[0]?.patch.coverImageLocked,
    true,
    'the rename sent coverImageLocked: false, which unlocks AND clears the cover',
  );
  // And the end state agrees: still locked, and no cover was re-uploaded to paper over it.
  assert.equal(c._lists[0]?.coverImageLocked, true, 'the list came out of the rename unlocked');
  assert.equal(c._covers.length, 0, 'the artwork was re-uploaded, hiding a destructive rename');
});

await ok('a list already titled with the label is not renamed', async () => {
  const c = stubClient({ existingLists: [{ id: 42, title: 'QueuePilot — Reading' }] });
  const p = kavitaProvider({ def: DEF, client: asClient(c) });
  const { play } = await p.buckets({ libraries: ['5'] }) as KavitaBuckets;
  await p.materialize(play, { setName: 'reading', setLabel: 'Reading' });
  assert.equal(c._renames.length, 0, 'a list already correctly titled was renamed anyway');
});

await ok('a rename that fails does not cost the reader their lineup', async () => {
  const c = stubClient({
    existingLists: [{ id: 42, title: 'QueuePilot — reading' }],
    renameFails: true,
  });
  const p = kavitaProvider({ def: DEF, client: asClient(c) });
  const { play } = await p.buckets({ libraries: ['5'] }) as KavitaBuckets;
  const art = await p.materialize(play, { setName: 'reading', setLabel: 'Manga & Webtoons' }) as KavitaArtifact;
  assert.equal(art.readingListId, 42);
  assert.ok(c._added.length > 0, 'the chapters never went on the list');
});

/**
 * `topupList` finds the list by title too, and it is NOT the same code path as materialize's —
 * it was a separate `.find(l => l.title === listTitleFor(setName))`. Left alone, a renamed
 * list would come back "nothing was ever launched for this set" and refilling would stop dead,
 * silently, on the one queue shape that depends on it.
 */
await ok('topupList finds the list under EITHER title', async () => {
  const build = async () => [];
  for (const [label, title] of [
    ['Manga & Webtoons', 'QueuePilot — reading'],            // not renamed yet
    ['Manga & Webtoons', 'QueuePilot — Manga & Webtoons'],   // renamed
  ] as const) {
    const c = stubClient({ existingLists: [{ id: 42, title }] });
    const p = kavitaProvider({ def: DEF, client: asClient(c) });
    const res = await p.topupList!({ setName: 'reading', setLabel: label, window: 3, at: 1, build });
    assert.notEqual(
      res.reason,
      'no reading list for this set yet',
      `top-up lost the list titled '${title}'`,
    );
  }
});

await ok('sameLibraryPrefix keeps one library and stops at the next', async () => {
  const a = { chapterId: 1, seriesId: 10, title: 'A', libraryId: 5 };
  const b = { chapterId: 2, seriesId: 10, title: 'B', libraryId: 5 };
  const c = { chapterId: 3, seriesId: 20, title: 'C', libraryId: 6 };
  assert.deepEqual(
    sameLibraryPrefix([a, b, c]).map((i) => i.chapterId),
    [1, 2],
  );
  assert.deepEqual(sameLibraryPrefix([a, b]).map((i) => i.chapterId), [1, 2]);
  assert.deepEqual(sameLibraryPrefix([]), []);
});

await ok('sameLibraryPrefix cannot split when the head has no library', async () => {
  const a = { chapterId: 1, seriesId: 10, title: 'A' };
  const b = { chapterId: 2, seriesId: 20, title: 'B', libraryId: 6 };
  assert.deepEqual(
    sameLibraryPrefix([a, b]).map((i) => i.chapterId),
    [1, 2],
  );
});

await ok('materialize does not put a second library on the reading list', async () => {
  // Kavita's manga reader applies a library reading profile only on first open.
  // Auto-advance is replaceState + init(), so a manga after a webtoon keeps
  // scroll + custom width. The list must stop at the library boundary.
  const c = stubClient();
  const p = kavitaProvider({ def: DEF, client: asClient(c) });
  const play: KavitaPlayItem[] = [
    { chapterId: 11, seriesId: 1, title: 'webtoon 1', libraryId: 5 },
    { chapterId: 12, seriesId: 1, title: 'webtoon 2', libraryId: 5 },
    { chapterId: 21, seriesId: 2, title: 'manga vol 1', libraryId: 6 },
  ];
  const art = await p.materialize(play, { setName: 'reading' }) as KavitaArtifact;
  assert.deepEqual(c._added.map((a) => a.chapterId), [11, 12]);
  assert.equal(art.count, 2);
  assert.equal(art.head?.chapterId, 11);
});

await ok('reading lists are enumerated with a POST, not a GET', async () => {
  CALLS.length = 0;
  const c = stubClient();
  const p = kavitaProvider({ def: DEF, client: asClient(c) });
  // The two fields materialize() reads. `as KavitaPlayItem` documents that `title` is
  // deliberately absent — the same one-field item the suite has always passed.
  await p.materialize([{ seriesId: 747, chapterId: 1 } as KavitaPlayItem], { setName: 'reading' });
  const call = CALLS.find((x) => x[0] === 'readingLists');
  assert.ok(call, 'reading lists were never enumerated');
  assert.equal(call[1], 'POST');  // the method, recorded alongside the call
});

// --------------------------------------------------------------------------- //
// handoff — a URL, never a push
// --------------------------------------------------------------------------- //
await ok('handoff returns a pull URL and no device push', async () => {
  const c = stubClient();
  const p = kavitaProvider({ def: DEF, client: asClient(c) });
  assert.equal(p.delivery, 'pull');
  const { play } = await p.buckets({ libraries: ['5'] }) as KavitaBuckets;
  const art = await p.materialize(play, { setName: 'reading' }) as KavitaArtifact;
  // `handoff()` is declared `HandoffResult | Promise<HandoffResult>` because Plex's is
  // async; Kavita's is sync and always the PULL half — the one narrowing, stated once here
  // and reused by the URL assertions below.
  const out = await p.handoff(art) as PullResult;
  assert.equal(out.mode, 'pull');
  assert.ok(out.url);
  assert.equal(out.awaiting, null);
  assert.equal('device' in out, false);
});

await ok('the deep link matches the shape read out of the live reader bundle', async () => {
  const c = stubClient();
  const p = kavitaProvider({ def: DEF, client: asClient(c) });
  const { play } = await p.buckets({ libraries: ['5'] }) as KavitaBuckets;
  const art = await p.materialize(play, { setName: 'reading' }) as KavitaArtifact;
  const { url } = await p.handoff(art) as PullResult;
  const head = play[0];
  assert.ok(head, 'the lineup was empty');
  assert.equal(
    url,
    `https://kavita.invalid/library/${head.libraryId}/series/${head.seriesId}`
    + `/manga/${head.chapterId}?incognitoMode=false&readingListId=${art.readingListId}`,
  );
});

await ok('?readingListId= is present — it is what makes next/prev cross series', async () => {
  // Without it the reader resolves next/prev through the SERIES, and the queue stops being
  // a queue: you would read series A forever instead of rolling into series B.
  const c = stubClient();
  const p = kavitaProvider({ def: DEF, client: asClient(c) });
  const { play } = await p.buckets({ libraries: ['5'] }) as KavitaBuckets;
  const art = await p.materialize(play, { setName: 'reading' }) as KavitaArtifact;
  assert.match(String((await p.handoff(art) as PullResult).url), /[?&]readingListId=\d+/);
});

await ok('the reader variant follows seriesFormat: manga / book / pdf', async () => {
  assert.equal(readerSegment(FORMAT.EPUB), 'book');
  assert.equal(readerSegment(FORMAT.PDF), 'pdf');
  assert.equal(readerSegment(FORMAT.ARCHIVE), 'manga');
  assert.equal(readerSegment(FORMAT.IMAGE), 'manga');
  // An EPUB library routes to the book reader, per feasibility §3/§7.
  const c = stubClient();
  const p = kavitaProvider({ def: DEF, client: asClient(c) });
  const { play } = await p.buckets({ libraries: ['6'] }) as KavitaBuckets;
  const art = await p.materialize(play, { setName: 'books' }) as KavitaArtifact;
  assert.match(String((await p.handoff(art) as PullResult).url), /\/book\//);
});

await ok('an empty artifact reports an error instead of a broken URL', async () => {
  const c = stubClient();
  const p = kavitaProvider({ def: DEF, client: asClient(c) });
  const art = await p.materialize([], { setName: 'reading' }) as KavitaArtifact;
  const out = await p.handoff(art) as PullResult;
  assert.equal(out.url, null);
  assert.match(String(out.error), /empty/);
});

// --------------------------------------------------------------------------- //
// progressState — polled, one call for the whole queue
// --------------------------------------------------------------------------- //
await ok('progressState reports completion for the whole queue in ONE call', async () => {
  CALLS.length = 0;
  const c = stubClient();
  const p = kavitaProvider({ def: DEF, client: asClient(c) });
  // `progressState` is declared as a union (Plex answers a watched-ratingKey Set); Kavita's
  // half is the per-item read state.
  const st = await p.progressState({ artifactId: 42 }) as KavitaProgressState;
  assert.equal(st.items.length, 2);
  assert.equal(st.items[0]?.done, true);
  assert.equal(st.items[1]?.done, false);
  assert.equal(CALLS.filter((x) => x[0] === 'readingListItems').length, 1);
});

await ok('the POOL and a LAUNCH agree on which series are eligible', async () => {
  // These are two different Kavita calls — the pool reads series-detail (it needs a COUNT,
  // and the series list carries no chapter count at all), a launch reads continue-point
  // (cheaper, and it only needs the next one). They disagreed live, 97 vs 103, because
  // continue-point wraps on a finished series. A preview that lists more series than a
  // launch will draw from is a preview that lies, so this pins them together.
  const series: StubSeries[] = [
    { id: 20, name: 'Finished', libraryId: 9, format: 1 },
    { id: 21, name: 'Partly read', libraryId: 9, format: 1 },
    { id: 22, name: 'Untouched', libraryId: 9, format: 1 },
  ];
  const detail: Record<string, { unreadCount: number; chapters: StubChapter[] }> = {
    20: { unreadCount: 0, chapters: [{ id: 2001, number: '1', minNumber: 1, pages: 10, pagesRead: 10 }] },
    21: { unreadCount: 2, chapters: [
      { id: 2101, number: '1', minNumber: 1, pages: 10, pagesRead: 10 },
      { id: 2102, number: '2', minNumber: 2, pages: 10, pagesRead: 0 },
      { id: 2103, number: '3', minNumber: 3, pages: 10, pagesRead: 0 },
    ] },
    22: { unreadCount: 1, chapters: [{ id: 2201, number: '1', minNumber: 1, pages: 10, pagesRead: 0 }] },
  };
  const c = {
    ...stubClient(),
    async seriesForLibrary() { return series; },
    async seriesDetail(id: number | string) { return detail[String(id)]; },
    async continuePoint(id: number | string) {
      // The wrap: a finished series still answers, with an already-read chapter.
      const chs = detail[String(id)]?.chapters ?? [];
      const next = chs.find((x) => x.pagesRead < x.pages) || chs[0];
      return { ...next, seriesId: Number(id) };
    },
  };
  const p = kavitaProvider({ def: DEF, client: asClient(c) });
  const { buckets } = await p.buckets({ libraries: ['9'], batch: 1, limit: 99 }) as KavitaBuckets;
  // `pool` is optional on the Provider seam (only the pull path reaches it), so it is
  // asserted present rather than assumed.
  assert.ok(p.pool, 'the Kavita provider lost its pool()');
  const pool = await p.pool({ libraries: ['9'] });
  assert.deepEqual(
    buckets.map((b) => b.seriesId).sort(),
    pool.map((x) => Number(x.ratingKey)).sort(),
    'the pool and a launch disagree about which series are eligible',
  );
  assert.deepEqual(pool.map((x) => x.show).sort(), ['Partly read', 'Untouched']);
});

await ok('the pool reports CHAPTERS left, not series or pages', async () => {
  const c = {
    ...stubClient(),
    async seriesForLibrary() { return [{ id: 30, name: 'S', libraryId: 9, format: 1 }]; },
    async seriesDetail() {
      return { unreadCount: 38, chapters: [{ id: 3001, number: '49', minNumber: 49, pages: 10, pagesRead: 0 }] };
    },
  };
  const p = kavitaProvider({ def: DEF, client: asClient(c) });
  assert.ok(p.pool, 'the Kavita provider lost its pool()');
  const pool = await p.pool({ libraries: ['9'] });
  assert.equal(pool[0]?.unwatched, 38);
});

// --------------------------------------------------------------------------- //
// The launcher
// --------------------------------------------------------------------------- //
const { launchDescriptor } = await import('../server/src/providers/launcher.js');

await ok('the launcher 302s a reading queue to its deep link', async () => {
  // `launchDescriptor`'s injected client is declared `PlexClient` — the seam names one
  // client type — and what it forwards to a Kavita queue is a Kavita client. The cast is
  // that (pre-existing) mismatch, not a stub shortcut.
  const d = await launchDescriptor('reading', { client: stubClient() as unknown as PlexClient });
  assert.equal(d.status, 302);
  assert.match(String(d.url), /^https:\/\/kavita\.invalid\/library\/5\/series\/747\/manga\/86090\?/);
  assert.match(String(d.url), /readingListId=/);
});

await ok('the launcher refuses a PUSH provider rather than redirecting nowhere', async () => {
  const d = await launchDescriptor('tv');
  assert.equal(d.status, 409);
  assert.match(String(d.error), /pushed to a device/);
});

await ok('the launcher refuses a MIXED queue with 501, not a guess', async () => {
  const d = await launchDescriptor('mixed');
  assert.equal(d.status, 501);
  assert.match(String(d.error), /more than one provider/);
});

await ok('the launcher surfaces NOT CONFIGURED as 503, by name', async () => {
  // No stub client and no token: the real instantiation path must refuse loudly.
  const d = await launchDescriptor('reading');
  assert.equal(d.status, 503);
  assert.match(String(d.error), /NOT CONFIGURED/);
});

await ok('an unknown queue is a 404', async () => {
  const d = await launchDescriptor('nope');
  assert.equal(d.status, 404);
});

console.log(FAILS.length ? `\n${FAILS.length} FAILED` : '\nkavita provider OK');
process.exit(FAILS.length ? 1 : 0);
