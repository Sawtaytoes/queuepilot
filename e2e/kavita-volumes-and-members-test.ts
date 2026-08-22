// Offline gate for two live bugs in the Kavita provider, both found on the real
// "Manga & Webtoons" queue on 2026-08-15. Every HTTP call is stubbed — no token, no network.
//
// 1. A VOLUME-BASED series read as fully read.
//    `series-detail` puts NOTHING in `chapters`/`specials` for a manga; every chapter hangs
//    off `volumes[].chapters[]`. The reader only looked at the first two, so "Alice in
//    Borderland" (0 of 328 pages read) rendered "All read" and never entered a lineup. The
//    stub below reproduces the live shape exactly: chapters 0, specials 0, volumes 9.
//    A chapter-based WEBTOON returns the same chapters in BOTH places, so the union must
//    dedupe by chapter id or every webtoon chapter queues twice — also asserted.
//
// 2. A CURATED queue played the library shelf.
//    `buckets()` enumerated `seriesForLibrary` and never read the queue's own entries, so a
//    93-entry reading queue produced a reading list of 12 series in alphabetical order, ONE
//    of which the owner had actually added.
//
// Run:  server/node_modules/.bin/tsx e2e/kavita-volumes-and-members-test.ts
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { errMessage } from '../server/src/errors.js';
import type { BucketsResult, KavitaPlayItem } from '../server/src/types.js';
import type { KavitaHttpClient } from '../server/src/providers/kavita-client.js';

const SCRATCH = mkdtempSync(path.join(tmpdir(), 'kavita-vol-'));
process.env.PROVIDERS_PATH = path.join(SCRATCH, 'providers.yaml');
process.env.PROVIDERS_SECRETS_PATH = path.join(SCRATCH, 'providers.secrets.yaml');
process.env.SETS_PATH = path.join(SCRATCH, 'sets.yaml');
process.env.QUEUES_PATH = path.join(SCRATCH, 'queues.yaml');
process.env.CACHE_PATH = path.join(SCRATCH, 'cache.sqlite');
process.env.KAVITA_API_SERVER_URL = 'https://kavita.invalid';
writeFileSync(process.env.SETS_PATH, 'sets: []\n');
writeFileSync(process.env.QUEUES_PATH, '{}\n');

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

interface KavitaBuckets extends Omit<BucketsResult, 'play' | 'buckets'> {
  play: KavitaPlayItem[];
  buckets: { seriesId: number; title: string }[];
}
const asClient = (c: unknown): KavitaHttpClient => c as unknown as KavitaHttpClient;

// --------------------------------------------------------------------------- //
// The stub, shaped from the LIVE instance (kavita.example.com, 2026-08-15).
// --------------------------------------------------------------------------- //

/** 4672 "Alice in Borderland" — a MANGA. chapters 0 / specials 0 / volumes 9, none read. */
const ALICE_DETAIL = {
  chapters: [],
  specials: [],
  unreadCount: 9,
  volumes: Array.from({ length: 9 }, (_, i) => ({
    id: 7800 + i,
    name: `Volume ${i + 1}`,
    number: i + 1,
    minNumber: i + 1,
    pages: 300 + i,
    pagesRead: 0,
    // Kavita's no-chapter-subdivision sentinel, verbatim off the wire.
    chapters: [{
      id: 68270 + i, number: '-100000', minNumber: -100000, title: 'Chapter -100000',
      titleName: '', range: '-100000', pages: 300 + i, pagesRead: 0,
    }],
  })),
};

/** 4577 "The Sword-Eating Swordmaster" — a WEBTOON. The SAME chapters appear twice: loose
 *  at the top level AND under volume 1. Live behaviour; the reason dedupe is required. */
const SWORD_CHAPTERS = Array.from({ length: 4 }, (_, i) => ({
  id: 67094 + i, number: String(i + 1), minNumber: i + 1, title: `Chapter ${i + 1}`,
  titleName: '', range: String(i + 1), pages: 150, pagesRead: i === 0 ? 150 : 0,
}));
const SWORD_DETAIL = {
  chapters: SWORD_CHAPTERS,
  specials: [],
  unreadCount: 3,
  volumes: [{
    id: 7586, name: 'Volume 1', number: 1, minNumber: 1, pages: 600, pagesRead: 150,
    chapters: SWORD_CHAPTERS,
  }],
};

/**
 * 5100 — a TANKOBON series whose volume files were parsed as `number: '1'` / "Chapter 1"
 * rather than the `-100000` sentinel. Live shape (Otherworldly Munchkin): each volume has
 * exactly one chapter, those chapters ALSO appear in the top-level `chapters[]`, and there
 * are loose weekly releases ahead of the volumes. Without the sole-chapter + volume-wins
 * rules every volume labelled itself "Chapter 1".
 */
const SOLO_VOL_CHAPTERS = Array.from({ length: 3 }, (_, i) => ({
  id: 81000 + i, number: '1', minNumber: 1, title: 'Chapter 1',
  titleName: '', range: '1', pages: 190, pagesRead: i < 1 ? 190 : 0,
}));
const SOLO_LOOSE_AHEAD = [
  { id: 82001, number: '134', minNumber: 134, title: 'Chapter 134', titleName: '', range: '134', pages: 16, pagesRead: 0 },
  { id: 82002, number: '135', minNumber: 135, title: 'Chapter 135', titleName: '', range: '135', pages: 16, pagesRead: 0 },
];
const SOLO_DETAIL = {
  chapters: [...SOLO_VOL_CHAPTERS, ...SOLO_LOOSE_AHEAD],
  specials: [],
  unreadCount: 4,
  volumes: SOLO_VOL_CHAPTERS.map((ch, i) => ({
    id: 9100 + i, name: `Volume ${i + 1}`, number: i + 1, minNumber: i + 1,
    pages: ch.pages, pagesRead: ch.pagesRead, chapters: [ch],
  })),
};

/**
 * 5200 — MIXED: sentinel volumes AND loose weekly chapters ahead of them. Live shape
 * (Red Ranger): Volume 1 still unread, but a `batch: 3` queue opened on chapter 48.5
 * because loose chapters sorted as "volume 0" and therefore FIRST.
 */
const MIXED_VOLUMES = Array.from({ length: 3 }, (_, i) => ({
  id: 9300 + i, name: `Volume ${i + 1}`, number: i + 1, minNumber: i + 1,
  pages: 400, pagesRead: 0,
  chapters: [{
    id: 83000 + i, number: '-100000', minNumber: -100000, title: 'Chapter -100000',
    titleName: '', range: '-100000', pages: 400, pagesRead: 0,
  }],
}));
const MIXED_LOOSE = [
  { id: 84001, number: '48.5', minNumber: 48.5, title: 'Chapter 48.5', titleName: '', range: '48.5', pages: 38, pagesRead: 0 },
  { id: 84002, number: '50', minNumber: 50, title: 'Chapter 50', titleName: '', range: '50', pages: 50, pagesRead: 0 },
  { id: 84003, number: '51', minNumber: 51, title: 'Chapter 51', titleName: '', range: '51', pages: 26, pagesRead: 0 },
];
const MIXED_DETAIL = {
  chapters: MIXED_LOOSE,
  specials: [],
  unreadCount: 6,
  volumes: MIXED_VOLUMES,
};

const DETAILS: Record<string, unknown> = {
  4672: ALICE_DETAIL, 4577: SWORD_DETAIL, 5100: SOLO_DETAIL, 5200: MIXED_DETAIL,
};
const SERIES: Record<string, { id: number; name: string; libraryId: number; format: number }> = {
  4672: { id: 4672, name: 'Alice in Borderland', libraryId: 2, format: 1 },
  4577: { id: 4577, name: 'The Sword-Eating Swordmaster', libraryId: 5, format: 1 },
  5100: { id: 5100, name: 'Solo Chapter Volumes', libraryId: 2, format: 1 },
  5200: { id: 5200, name: 'Mixed Volumes And Chapters', libraryId: 2, format: 1 },
  99: { id: 99, name: 'Shelf Filler', libraryId: 5, format: 1 },
};

function stubClient() {
  const calls: string[][] = [];
  return {
    _calls: calls,
    async whoami() { return 'Sawtaytoes'; },
    async series(id: number | string) {
      calls.push(['series', String(id)]);
      return SERIES[String(id)] ?? null;
    },
    async seriesDetail(id: number | string) {
      calls.push(['seriesDetail', String(id)]);
      return DETAILS[String(id)] ?? { chapters: [], specials: [], volumes: [] };
    },
    async continuePoint(id: number | string) {
      calls.push(['continuePoint', String(id)]);
      // What the real endpoint answers: the single next unread chapter, seriesId NULL.
      if (String(id) === '4672') {
        return { id: 68270, number: '-100000', minNumber: -100000, pages: 300, pagesRead: 0, seriesId: Number(id) };
      }
      if (String(id) === '4577') {
        return { id: 67095, number: '2', minNumber: 2, pages: 150, pagesRead: 0, seriesId: Number(id) };
      }
      return { id: 1, number: '1', minNumber: 1, pages: 10, pagesRead: 0, seriesId: Number(id) };
    },
    async seriesForLibrary(libraryId: number | string) {
      calls.push(['seriesForLibrary', String(libraryId)]);
      return Object.values(SERIES).filter((s) => String(s.libraryId) === String(libraryId));
    },
  };
}

const { kavitaProvider } = await import('../server/src/providers/kavita.js');
const DEF = { id: 'kavita', kind: 'kavita', label: 'Kavita', base_url: 'https://kavita.invalid' };

// --------------------------------------------------------------------------- //
// 1. Volume-based series
// --------------------------------------------------------------------------- //

await ok('a VOLUME-based manga is not reported as fully read', async () => {
  const p = kavitaProvider({ def: DEF, client: asClient(stubClient()) });
  const [tile] = await p.tiles!(['4672']);
  assert.ok(tile, 'Alice in Borderland resolved to no tile at all');
  // The bug: `next: null` here is what the frontend renders as "All read".
  assert.ok(tile.next, 'a series with 9 unread volumes reported nothing next — the "All read" bug');
  assert.equal(tile.unreadCount, 9);
});

await ok('a whole volume is labelled as a VOLUME, never "Ch -100000"', async () => {
  const p = kavitaProvider({ def: DEF, client: asClient(stubClient()) });
  const [tile] = await p.tiles!(['4672']);
  // `ProviderTileRow.next` is a union since board games joined the seam (a play carries no
  // chapter id). This is the Kavita gate, so it asserts the Kavita shape by name.
  const next = tile!.next! as KavitaPlayItem;
  assert.equal(next.unit, 'volume', 'a whole-volume item must carry unit "volume"');
  assert.equal(next.number, 1, 'the VOLUME number, not the -100000 chapter sentinel');
  assert.equal(next.title, 'Volume 1');
  // The chapter id is still Kavita's real one — that is what the reader opens.
  assert.equal(next.chapterId, 68270);
});

await ok('volumes are read in volume order, not wire order', async () => {
  const p = kavitaProvider({ def: DEF, client: asClient(stubClient()) });
  const { play } = await p.buckets({
    entries: [{ id: '4672', volumes: 3 }], limit: 3,
  }) as KavitaBuckets;
  assert.deepEqual(play.map((i) => i.number), [1, 2, 3]);
  assert.deepEqual(play.map((i) => i.title), ['Volume 1', 'Volume 2', 'Volume 3']);
});

await ok('a WEBTOON chapter is never queued twice (loose + volume dedupe)', async () => {
  const p = kavitaProvider({ def: DEF, client: asClient(stubClient()) });
  const { play } = await p.buckets({
    entries: [{ id: '4577', batch: 10 }], limit: 10,
  }) as KavitaBuckets;
  const ids = play.map((i) => i.chapterId);
  assert.equal(new Set(ids).size, ids.length, `duplicate chapters queued: ${ids.join(', ')}`);
  // Chapter 1 is fully read; 2/3/4 are not. The read one must not come back.
  assert.deepEqual(ids, [67095, 67096, 67097]);
  // A loose chapter keeps chapter wording — the volume path must not relabel a webtoon.
  assert.equal(play[0]!.unit, 'chapter');
  assert.equal(play[0]!.number, '2');
});

// --------------------------------------------------------------------------- //
// 2. Curated entries vs the library shelf
// --------------------------------------------------------------------------- //

await ok('curated entries ARE the lineup — the library is not consulted', async () => {
  const client = stubClient();
  const p = kavitaProvider({ def: DEF, client: asClient(client) });
  const { play } = await p.buckets({
    entries: [{ id: '4672' }],
    // A library is offered too. The entries must win, or a curated queue plays the shelf.
    libraries: ['5'],
    limit: 5,
  }) as KavitaBuckets;
  assert.ok(play.length > 0);
  assert.ok(
    play.every((i) => String(i.seriesId) === '4672'),
    `a curated queue drew from outside its entries: ${play.map((i) => i.seriesId).join(', ')}`,
  );
  assert.equal(
    client._calls.some((c) => c[0] === 'seriesForLibrary'), false,
    'the library shelf was enumerated even though the queue has entries',
  );
});

await ok('a set with NO entries still falls back to its libraries', async () => {
  const client = stubClient();
  const p = kavitaProvider({ def: DEF, client: asClient(client) });
  const { play } = await p.buckets({ entries: [], libraries: ['5'], limit: 5 }) as KavitaBuckets;
  assert.ok(play.length > 0, 'a rule-based reading channel lost its pool');
  assert.ok(client._calls.some((c) => c[0] === 'seriesForLibrary'));
});

await ok('a per-entry batch overrides the queue default, per series', async () => {
  const p = kavitaProvider({ def: DEF, client: asClient(stubClient()) });
  const { play } = await p.buckets({
    // Alice takes 3 VOLUMES per round by her own override; the webtoon takes the queue's 1 chapter.
    entries: [{ id: '4672', volumes: 3 }, { id: '4577' }],
    batch: 1,
    limit: 4,
  }) as KavitaBuckets;
  const first = play.slice(0, 3).map((i) => String(i.seriesId));
  assert.deepEqual(first, ['4672', '4672', '4672'], 'the entry override did not widen its own slice');
  assert.equal(String(play[3]!.seriesId), '4577', 'the next series did not get its turn after the batch');
});

await ok('an entry naming a series Kavita no longer has is skipped, not fatal', async () => {
  const p = kavitaProvider({ def: DEF, client: asClient(stubClient()) });
  const { play } = await p.buckets({
    entries: [{ id: '999999' }, { id: '4672' }], limit: 3,
  }) as KavitaBuckets;
  assert.ok(play.length > 0, 'one deleted series made the whole queue unlaunchable');
  assert.ok(play.every((i) => String(i.seriesId) === '4672'));
});

// --------------------------------------------------------------------------- //
// 3. The "Start from…" picker + the start floor
// --------------------------------------------------------------------------- //

await ok('listUnits lists a WEBTOON\'s chapters, including already-read ones', async () => {
  const p = kavitaProvider({ def: DEF, client: asClient(stubClient()) });
  const out = await p.listUnits!('4577');
  assert.ok(out, 'Swordmaster listed no chapters');
  assert.equal(out.multiSeason, false, 'a webtoon must not grow a season row');
  assert.equal(out.seasons.length, 1);
  const eps = out.seasons[0]!.episodes;
  assert.equal(eps.length, 4, 'loose+volume chapters must be deduped');
  assert.deepEqual(eps.map((e) => e.episode), [1, 2, 3, 4]);
  assert.equal(eps[0]!.watched, true, 'chapter 1 is fully read');
  assert.equal(eps[1]!.watched, false);
  assert.equal(eps[0]!.title, 'Chapter 1');
});

await ok('listUnits lists a VOLUME-based manga as volumes, never Ch -100000', async () => {
  const p = kavitaProvider({ def: DEF, client: asClient(stubClient()) });
  const out = await p.listUnits!('4672');
  assert.ok(out, 'Alice listed no units');
  const eps = out.seasons[0]!.episodes;
  assert.equal(eps.length, 9);
  assert.deepEqual(eps.map((e) => e.episode), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(eps.map((e) => e.title), [
    'Volume 1', 'Volume 2', 'Volume 3', 'Volume 4', 'Volume 5',
    'Volume 6', 'Volume 7', 'Volume 8', 'Volume 9',
  ]);
  assert.ok(eps.every((e) => e.watched === false));
});

await ok('a start floor skips earlier unread chapters without marking them read', async () => {
  const p = kavitaProvider({ def: DEF, client: asClient(stubClient()) });
  const { play } = await p.buckets({
    entries: [{ id: '4577', batch: 10, start: { season: 1, episode: 3 } }],
    limit: 10,
  }) as KavitaBuckets;
  // Chapter 1 is already read; 2 is unread but BEFORE the floor; 3 and 4 remain.
  assert.deepEqual(play.map((i) => i.number), ['3', '4']);
});

await ok('a start floor on a volume-based series starts at that volume', async () => {
  const p = kavitaProvider({ def: DEF, client: asClient(stubClient()) });
  const { play } = await p.buckets({
    entries: [{ id: '4672', volumes: 3, start: { season: 1, episode: 5 } }],
    limit: 3,
  }) as KavitaBuckets;
  assert.deepEqual(play.map((i) => i.number), [5, 6, 7]);
});

// --------------------------------------------------------------------------- //
// 4. A volume is not a chapter — the chapter count must not apply
// --------------------------------------------------------------------------- //

await ok('a chapter batch of 3 does NOT dump 3 volumes', async () => {
  const p = kavitaProvider({ def: DEF, client: asClient(stubClient()) });
  const { play } = await p.buckets({
    entries: [{ id: '4672', batch: 3 }],
    batch: 3,
    limit: 5,
  }) as KavitaBuckets;
  // Alice is volume-based. The chapter count is 3; the volume count was not set, so
  // the default of 1 must win. The live bug was "3 chapters" queuing 3 volumes.
  assert.deepEqual(play.map((i) => i.number), [1]);
  assert.equal(play[0]!.unit, 'volume');
});

await ok('a volume-based series uses the volume count, not the chapter count', async () => {
  const p = kavitaProvider({ def: DEF, client: asClient(stubClient()) });
  const { play } = await p.buckets({
    entries: [{ id: '4672' }],
    batch: 3,
    volumeBatch: 2,
    limit: 5,
  }) as KavitaBuckets;
  assert.deepEqual(play.map((i) => i.number), [1, 2]);
});

await ok('a chapter-based WEBTOON still uses the chapter count', async () => {
  const p = kavitaProvider({ def: DEF, client: asClient(stubClient()) });
  const { play } = await p.buckets({
    entries: [{ id: '4577' }],
    batch: 2,
    volumeBatch: 9,
    limit: 5,
  }) as KavitaBuckets;
  // Chapters 2 and 3 (1 is read). The volume count of 9 must not apply.
  assert.deepEqual(play.map((i) => i.number), ['2', '3']);
  assert.equal(play[0]!.unit, 'chapter');
});

await ok('a per-entry volumes override wins over the queue volume default', async () => {
  const p = kavitaProvider({ def: DEF, client: asClient(stubClient()) });
  const { play } = await p.buckets({
    entries: [{ id: '4672', volumes: 4 }],
    volumeBatch: 2,
    limit: 5,
  }) as KavitaBuckets;
  assert.deepEqual(play.map((i) => i.number), [1, 2, 3, 4]);
});

// --------------------------------------------------------------------------- //
// 5. Sole-chapter volumes (no -100000 sentinel) + volumes before loose chapters
// --------------------------------------------------------------------------- //

await ok('a sole-chapter volume numbered "1" is labelled Volume N, not Chapter 1', async () => {
  const p = kavitaProvider({ def: DEF, client: asClient(stubClient()) });
  const [tile] = await p.tiles!(['5100']);
  assert.ok(tile?.next, 'Solo Chapter Volumes resolved to nothing next');
  const next = tile!.next! as KavitaPlayItem;
  // Volume 1 is fully read; next unread is Volume 2 — NEVER "Chapter 1" / "Chapter 134".
  assert.equal(next.unit, 'volume');
  assert.equal(next.number, 2);
  assert.equal(next.title, 'Volume 2');
});

await ok('sole-chapter volumes keep volume labels even when they also appear loose', async () => {
  const p = kavitaProvider({ def: DEF, client: asClient(stubClient()) });
  const out = await p.listUnits!('5100');
  assert.ok(out);
  const eps = out.seasons[0]!.episodes;
  // 3 volumes + 2 loose weekly chapters. Volumes lead; the "Chapter 1" title never surfaces.
  assert.deepEqual(eps.map((e) => e.title), [
    'Volume 1', 'Volume 2', 'Volume 3', 'Chapter 134', 'Chapter 135',
  ]);
  assert.deepEqual(eps.map((e) => e.episode), [1, 2, 3, 134, 135]);
});

await ok('a MIXED series queues volumes BEFORE loose weekly chapters', async () => {
  const p = kavitaProvider({ def: DEF, client: asClient(stubClient()) });
  const { play } = await p.buckets({
    // The live bug: chapter batch 3 drew 48.5 / 50 / 51 and never reached Volume 1.
    entries: [{ id: '5200' }],
    batch: 3,
    volumeBatch: 3,
    limit: 5,
  }) as KavitaBuckets;
  assert.deepEqual(play.map((i) => i.unit), ['volume', 'volume', 'volume']);
  assert.deepEqual(play.map((i) => i.number), [1, 2, 3]);
  assert.deepEqual(play.map((i) => i.title), ['Volume 1', 'Volume 2', 'Volume 3']);
});

await ok('loose chapters of a MIXED series follow after every volume', async () => {
  const p = kavitaProvider({ def: DEF, client: asClient(stubClient()) });
  const { play } = await p.buckets({
    entries: [{ id: '5200', volumes: 10 }],
    batch: 10,
    limit: 10,
  }) as KavitaBuckets;
  assert.deepEqual(
    play.map((i) => ({ unit: i.unit, number: i.number })),
    [
      { unit: 'volume', number: 1 },
      { unit: 'volume', number: 2 },
      { unit: 'volume', number: 3 },
      { unit: 'chapter', number: '48.5' },
      { unit: 'chapter', number: '50' },
      { unit: 'chapter', number: '51' },
    ],
  );
});

await ok('a WEBTOON still queues as chapters after the volume-wins dedupe', async () => {
  // Preferring the volume copy must not relabel a many-chapter volume-1 webtoon as volumes.
  const p = kavitaProvider({ def: DEF, client: asClient(stubClient()) });
  const { play } = await p.buckets({
    entries: [{ id: '4577', batch: 10 }], limit: 10,
  }) as KavitaBuckets;
  assert.deepEqual(play.map((i) => i.chapterId), [67095, 67096, 67097]);
  assert.ok(play.every((i) => i.unit === 'chapter'));
});

console.log(FAILS.length ? `\n${FAILS.length} FAILED: ${FAILS.join(', ')}` : '\nall passed');
process.exit(FAILS.length ? 1 : 0);
