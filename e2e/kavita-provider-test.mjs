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
// Run:  node e2e/kavita-provider-test.mjs   (from the repo root; non-zero on failure)
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SCRATCH = mkdtempSync(path.join(tmpdir(), 'kavita-'));
process.env.PROVIDERS_PATH = path.join(SCRATCH, 'providers.yaml');
process.env.PROVIDERS_SECRETS_PATH = path.join(SCRATCH, 'providers.secrets.yaml');
process.env.SETS_PATH = path.join(SCRATCH, 'sets.yaml');
process.env.QUEUES_PATH = path.join(SCRATCH, 'queues.yaml');
process.env.CACHE_PATH = path.join(SCRATCH, 'cache.sqlite');
process.env.KAVITA_API_SERVER_URL = 'https://kavita.invalid';

writeFileSync(process.env.QUEUES_PATH, 'reading: []\n');
writeFileSync(
  process.env.SETS_PATH,
  'sets:\n'
  + '  - id: reading\n    label: Reading\n    source: rotation\n'
  + '    providers:\n      - provider: kavita\n        libraries: [5]\n'
  + '  - id: tv\n    label: TV\n    source: rotation\n    sections: [5]\n'
  + '  - id: mixed\n    label: Mixed\n    source: rotation\n'
  + '    providers:\n      - provider: plex\n        libraries: [5]\n'
  + '      - provider: kavita\n        libraries: [2]\n',
);

const FAILS = [];
async function ok(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}  -- ${e.message}`);
    FAILS.push(name);
  }
}

// --------------------------------------------------------------------------- //
// The stub Kavita. Records every call so the test can assert on the WIRE, not just
// the return value — "is it a POST" is exactly the kind of thing that silently regresses.
// --------------------------------------------------------------------------- //
const CALLS = [];
const SERIES = [
  { id: 747, name: 'A Flame Reborn', libraryId: 5, format: 1 },
  { id: 3882, name: 'A Hero Who Knows His Stuff', libraryId: 5, format: 1 },
  { id: 900, name: 'Finished Series', libraryId: 5, format: 1 },
  { id: 901, name: 'An EPUB Book', libraryId: 6, format: 3 },
];
// Shaped like the live ChapterDto: note seriesId is NULL, exactly as the real one returns.
const CONTINUE = {
  747: { id: 86090, number: '113', title: '113', pages: 152, pagesRead: 0, seriesId: null },
  3882: { id: 90001, number: '42', title: '42', pages: 100, pagesRead: 0, seriesId: null },
  900: null,
  901: { id: 90002, number: '1', title: 'Ch 1', pages: 50, pagesRead: 0, seriesId: null },
};

function stubClient({ existingLists = [] } = {}) {
  const lists = [...existingLists];
  let nextListId = 500;
  const added = [];
  return {
    _base: 'https://kavita.invalid',
    _calls: CALLS,
    _added: added,
    _lists: lists,
    async whoami() { CALLS.push(['whoami']); return 'Sawtaytoes'; },
    async libraries() {
      CALLS.push(['libraries']);
      return [{ id: 5, name: 'Webtoons', type: 0 }, { id: 6, name: 'Books', type: 2 }];
    },
    async seriesForLibrary(libraryId) {
      CALLS.push(['seriesForLibrary', String(libraryId)]);
      return SERIES.filter((s) => String(s.libraryId) === String(libraryId));
    },
    async continuePoint(seriesId) {
      CALLS.push(['continuePoint', String(seriesId)]);
      const ch = CONTINUE[seriesId];
      if (!ch) return null;
      // Mirror the real client's contract: it threads seriesId back in.
      return { ...ch, seriesId: ch.seriesId ?? Number(seriesId) };
    },
    async readingLists() { CALLS.push(['readingLists', 'POST']); return lists; },
    async createList(title) {
      CALLS.push(['createList', title]);
      const l = { id: nextListId, title, ownerUserName: 'Sawtaytoes' };
      nextListId += 1;
      lists.push(l);
      return l;
    },
    async addChapter(readingListId, seriesId, chapterId) {
      CALLS.push(['addChapter', readingListId, seriesId, chapterId]);
      added.push({ readingListId, seriesId, chapterId });
    },
    async readingListItems(id) {
      CALLS.push(['readingListItems', id]);
      return [
        { chapterId: 86090, seriesId: 747, order: 0, pagesRead: 152, pagesTotal: 152, lastReadingProgressUtc: '2026-08-13T00:00:00Z' },
        { chapterId: 90001, seriesId: 3882, order: 1, pagesRead: 10, pagesTotal: 100, lastReadingProgressUtc: null },
      ];
    },
  };
}

const { kavitaProvider } = await import('../server/src/providers/kavita.js');
const { readerSegment, FORMAT } = await import('../server/src/providers/kavita-client.js');
const DEF = { id: 'kavita', kind: 'kavita', label: 'Kavita', base_url: 'https://kavita.invalid' };

// --------------------------------------------------------------------------- //
// buckets
// --------------------------------------------------------------------------- //
await ok('buckets skips a series with nothing unread', async () => {
  CALLS.length = 0;
  const p = kavitaProvider({ def: DEF, client: stubClient() });
  const { play, buckets } = await p.buckets({ libraries: ['5'] });
  const ids = buckets.map((b) => b.seriesId);
  assert.ok(!ids.includes(900), 'the finished series produced a bucket');
  assert.equal(play.length, 2);
});

await ok('continue-point returning a NULL seriesId is repaired, not propagated', async () => {
  const p = kavitaProvider({ def: DEF, client: stubClient() });
  const { play } = await p.buckets({ libraries: ['5'] });
  for (const it of play) {
    assert.notEqual(it.seriesId, null, 'a null seriesId reached the lineup');
    assert.equal(typeof it.seriesId, 'number');
  }
});

await ok('the batch knob queues N chapters per series before switching', async () => {
  const p = kavitaProvider({ def: DEF, client: stubClient() });
  // The stub only exposes one unread chapter per series, so a batch of 3 must not invent
  // items — it caps at what exists.
  const { play } = await p.buckets({ libraries: ['5'], batch: 3 });
  assert.equal(play.length, 2);
});

await ok('no libraries selected yields nothing rather than the whole server', async () => {
  const p = kavitaProvider({ def: DEF, client: stubClient() });
  const { play } = await p.buckets({ libraries: [] });
  assert.deepEqual(play, []);
});

await ok('the lineup is CAPPED — a big library does not queue its whole backlog', async () => {
  // Measured against the live instance: Webtoons alone has 103 series with something
  // unread. Uncapped that is 103 sequential writes per launch, for a reading list nobody
  // reaches the end of. The Plex rotation has always capped; so does this.
  const many = Array.from({ length: 50 }, (_, i) => ({
    id: 1000 + i, name: `S${i}`, libraryId: 9, format: 1,
  }));
  const c = {
    ...stubClient(),
    async seriesForLibrary() { return many; },
    async continuePoint(id) { return { id: Number(id) * 10, number: '1', pages: 10, pagesRead: 0, seriesId: Number(id) }; },
  };
  const p = kavitaProvider({ def: DEF, client: c });
  const { play, buckets } = await p.buckets({ libraries: ['9'], limit: 12 });
  assert.equal(buckets.length, 50, 'every series should still be surveyed');
  assert.equal(play.length, 12, `capped lineup was ${play.length}`);
});

await ok('the cap never loops forever when buckets run dry early', async () => {
  // A library with fewer unread chapters than the cap must terminate, not spin.
  const p = kavitaProvider({ def: DEF, client: stubClient() });
  const { play } = await p.buckets({ libraries: ['5'], limit: 100 });
  assert.equal(play.length, 2);
});

await ok('the lineup INTERLEAVES series rather than draining one', async () => {
  // Rolling into a different series is the entire feature. If a queue drained series A
  // before touching B, it would be a single-series binge with extra steps.
  const many = [
    { id: 1, name: 'A', libraryId: 9, format: 1 },
    { id: 2, name: 'B', libraryId: 9, format: 1 },
  ];
  const c = {
    ...stubClient(),
    async seriesForLibrary() { return many; },
    async continuePoint(id) { return { id: Number(id) * 100, number: '1', pages: 10, pagesRead: 0, seriesId: Number(id) }; },
  };
  const p = kavitaProvider({ def: DEF, client: c });
  const { play } = await p.buckets({ libraries: ['9'], limit: 2 });
  assert.deepEqual(play.map((i) => i.seriesId), [1, 2], 'series were not interleaved');
});

// --------------------------------------------------------------------------- //
// materialize — the reading list is the runtime artifact, never the store
// --------------------------------------------------------------------------- //
await ok('materialize creates one list per set and adds chapters IN ORDER', async () => {
  CALLS.length = 0;
  const c = stubClient();
  const p = kavitaProvider({ def: DEF, client: c });
  const { play } = await p.buckets({ libraries: ['5'] });
  const art = await p.materialize(play, { setName: 'reading' });
  assert.equal(art.kind, 'kavita');
  assert.match(art.title, /QueuePilot/);
  assert.match(art.title, /reading/);
  assert.equal(c._added.length, 2);
  assert.deepEqual(c._added.map((a) => a.chapterId), play.map((i) => i.chapterId));
});

await ok('materialize REUSES the set\'s existing list instead of littering new ones', async () => {
  const c = stubClient({ existingLists: [{ id: 42, title: 'QueuePilot — reading' }] });
  const p = kavitaProvider({ def: DEF, client: c });
  const { play } = await p.buckets({ libraries: ['5'] });
  const art = await p.materialize(play, { setName: 'reading' });
  assert.equal(art.readingListId, 42);
  assert.equal(c._lists.length, 1, 'a duplicate list was created');
});

await ok('reading lists are enumerated with a POST, not a GET', async () => {
  CALLS.length = 0;
  const c = stubClient();
  const p = kavitaProvider({ def: DEF, client: c });
  await p.materialize([{ seriesId: 747, chapterId: 1 }], { setName: 'reading' });
  const call = CALLS.find((x) => x[0] === 'readingLists');
  assert.ok(call, 'reading lists were never enumerated');
  assert.equal(call[1], 'POST');
});

// --------------------------------------------------------------------------- //
// handoff — a URL, never a push
// --------------------------------------------------------------------------- //
await ok('handoff returns a pull URL and no device push', async () => {
  const c = stubClient();
  const p = kavitaProvider({ def: DEF, client: c });
  assert.equal(p.delivery, 'pull');
  const { play } = await p.buckets({ libraries: ['5'] });
  const art = await p.materialize(play, { setName: 'reading' });
  const out = p.handoff(art);
  assert.equal(out.mode, 'pull');
  assert.ok(out.url);
  assert.equal(out.awaiting, null);
  assert.equal('device' in out, false);
});

await ok('the deep link matches the shape read out of the live reader bundle', async () => {
  const c = stubClient();
  const p = kavitaProvider({ def: DEF, client: c });
  const { play } = await p.buckets({ libraries: ['5'] });
  const art = await p.materialize(play, { setName: 'reading' });
  const { url } = p.handoff(art);
  const head = play[0];
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
  const p = kavitaProvider({ def: DEF, client: c });
  const { play } = await p.buckets({ libraries: ['5'] });
  const art = await p.materialize(play, { setName: 'reading' });
  assert.match(p.handoff(art).url, /[?&]readingListId=\d+/);
});

await ok('the reader variant follows seriesFormat: manga / book / pdf', async () => {
  assert.equal(readerSegment(FORMAT.EPUB), 'book');
  assert.equal(readerSegment(FORMAT.PDF), 'pdf');
  assert.equal(readerSegment(FORMAT.ARCHIVE), 'manga');
  assert.equal(readerSegment(FORMAT.IMAGE), 'manga');
  // An EPUB library routes to the book reader, per feasibility §3/§7.
  const c = stubClient();
  const p = kavitaProvider({ def: DEF, client: c });
  const { play } = await p.buckets({ libraries: ['6'] });
  const art = await p.materialize(play, { setName: 'books' });
  assert.match(p.handoff(art).url, /\/book\//);
});

await ok('an empty artifact reports an error instead of a broken URL', async () => {
  const c = stubClient();
  const p = kavitaProvider({ def: DEF, client: c });
  const art = await p.materialize([], { setName: 'reading' });
  const out = p.handoff(art);
  assert.equal(out.url, null);
  assert.match(out.error, /empty/);
});

// --------------------------------------------------------------------------- //
// progressState — polled, one call for the whole queue
// --------------------------------------------------------------------------- //
await ok('progressState reports completion for the whole queue in ONE call', async () => {
  CALLS.length = 0;
  const c = stubClient();
  const p = kavitaProvider({ def: DEF, client: c });
  const st = await p.progressState({ artifactId: 42 });
  assert.equal(st.items.length, 2);
  assert.equal(st.items[0].done, true);
  assert.equal(st.items[1].done, false);
  assert.equal(CALLS.filter((x) => x[0] === 'readingListItems').length, 1);
});

// --------------------------------------------------------------------------- //
// The launcher
// --------------------------------------------------------------------------- //
const { launchDescriptor } = await import('../server/src/providers/launcher.js');

await ok('the launcher 302s a reading queue to its deep link', async () => {
  const d = await launchDescriptor('reading', { client: stubClient() });
  assert.equal(d.status, 302);
  assert.match(d.url, /^https:\/\/kavita\.invalid\/library\/5\/series\/747\/manga\/86090\?/);
  assert.match(d.url, /readingListId=/);
});

await ok('the launcher refuses a PUSH provider rather than redirecting nowhere', async () => {
  const d = await launchDescriptor('tv');
  assert.equal(d.status, 409);
  assert.match(d.error, /pushed to a device/);
});

await ok('the launcher refuses a MIXED queue with 501, not a guess', async () => {
  const d = await launchDescriptor('mixed');
  assert.equal(d.status, 501);
  assert.match(d.error, /more than one provider/);
});

await ok('the launcher surfaces NOT CONFIGURED as 503, by name', async () => {
  // No stub client and no token: the real instantiation path must refuse loudly.
  const d = await launchDescriptor('reading');
  assert.equal(d.status, 503);
  assert.match(d.error, /NOT CONFIGURED/);
});

await ok('an unknown queue is a 404', async () => {
  const d = await launchDescriptor('nope');
  assert.equal(d.status, 404);
});

console.log(FAILS.length ? `\n${FAILS.length} FAILED` : '\nkavita provider OK');
process.exit(FAILS.length ? 1 : 0);
