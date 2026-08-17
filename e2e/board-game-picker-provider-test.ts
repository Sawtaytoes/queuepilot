// Board Game Picker provider — OFFLINE. No network, no token, no picker.
//
// What this pins, in order of how badly it would hurt to get wrong:
//
//   1. PRIVACY. The provider never calls `/api/collection`. That payload carries players,
//      groups and who was at the table; this repo is public. Every request the stub sees is
//      recorded, and one assertion is simply "none of them was that URL".
//   2. `queued_at`. Progress is counted from when an entry was QUEUED, never from the
//      picker's lifetime play log. A game with twenty plays behind it and a batch of three
//      must have three plays left the day it is queued, not zero.
//   3. Entries beat libraries — the bug Kavita shipped once already.
//   4. `/go/<set>` 302s into `/play/<head>`, and answers 409 rather than the next game when
//      the queue is played out.
//
// Run:  server/node_modules/.bin/tsx e2e/board-game-picker-provider-test.ts   (repo root)
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { errMessage } from '../server/src/errors.js';
import type { BoardGamesArtifact, BucketsResult, PullResult } from '../server/src/types.js';
import type { BoardGamesHttpClient } from '../server/src/providers/board-game-picker-client.js';

const SCRATCH = mkdtempSync(path.join(tmpdir(), 'board-game-picker-'));
const SETS_PATH = path.join(SCRATCH, 'sets.yaml');
const QUEUES_PATH = path.join(SCRATCH, 'queues.yaml');
process.env.PROVIDERS_PATH = path.join(SCRATCH, 'providers.yaml');
process.env.PROVIDERS_SECRETS_PATH = path.join(SCRATCH, 'providers.secrets.yaml');
process.env.SETS_PATH = SETS_PATH;
process.env.QUEUES_PATH = QUEUES_PATH;
process.env.CACHE_PATH = path.join(SCRATCH, 'cache.sqlite');
process.env.BOARD_GAME_PICKER_URL = 'https://board-game-picker.invalid';
// Deliberately NO BOARD_GAME_PICKER_API_TOKEN: an unset token is the normal deployment for
// this kind, and the suite proves the provider is `configured` anyway.

// Invented shelf. `harbour-lantern` is the one with a lifetime of plays behind it.
writeFileSync(
  QUEUES_PATH,
  'games:\n'
  + '  - ratingKey: harbour-lantern\n    title: Harbour Lantern\n    episodes: 3\n'
  + '  - ratingKey: orchard\n    title: Orchard\n    episodes: 1\n',
);
writeFileSync(
  SETS_PATH,
  'sets:\n'
  + '  - id: games\n    label: Board games\n    source: queue\n'
  + '    providers:\n      - provider: board-game-picker\n        libraries: [collection]\n'
  + '  - id: tv\n    label: TV\n    source: rotation\n    sections: [5]\n',
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

const DEF = {
  id: 'board-game-picker',
  kind: 'board-game-picker',
  label: 'Board Game Picker',
  base_url: 'https://board-game-picker.invalid',
};

const NOW = Math.floor(Date.parse('2026-08-16T12:00:00.000Z') / 1000);
const YEARS_AGO = '2019-01-01T20:00:00.000Z';
const YESTERDAY = '2026-08-15T20:00:00.000Z';

interface StubGame { id: string; name: string; imagePath?: string | null; ownerCategories?: string[] }
interface StubPlay { id: string; gameId: string; playedAt: string }

const GAMES: StubGame[] = [
  { id: 'harbour-lantern', name: 'Harbour Lantern', imagePath: '/images/lantern.png', ownerCategories: ["Roll 'n Write"] },
  { id: 'orchard', name: 'Orchard', imagePath: null, ownerCategories: [] },
];

/**
 * A lifetime of plays on Harbour Lantern (twenty, years ago) plus ONE since it was queued.
 * With `episodes: 3` that is two plays left — and zero if anything ever counts `playCount`.
 */
const PLAYS: StubPlay[] = [
  ...Array.from({ length: 20 }, (_, i) => ({ id: `old-${i}`, gameId: 'harbour-lantern', playedAt: YEARS_AGO })),
  { id: 'recent', gameId: 'harbour-lantern', playedAt: YESTERDAY },
];

/** Every path the provider asked for, in order. The privacy assertion reads this. */
let CALLS: string[] = [];
let POSTED: string[] = [];

const asClient = (c: unknown) => c as unknown as BoardGamesHttpClient;

function stubClient({ plays = PLAYS }: { plays?: StubPlay[] } = {}) {
  return {
    _base: DEF.base_url,
    games(query: string, categories: string[] = []) {
      CALLS.push(`/api/games?q=${query}&categories=${categories.join(',')}`);
      const term = query.toLowerCase();
      return Promise.resolve(
        GAMES.filter((g) => g.name.toLowerCase().includes(term))
          .filter((g) => !categories.length || (g.ownerCategories || []).some((cat) => categories.includes(cat))),
      );
    },
    game(id: string) {
      CALLS.push(`/api/games/${id}`);
      return Promise.resolve(GAMES.find((g) => g.id === id) || null);
    },
    plays(gameId: string, since: number | null = null) {
      CALLS.push(`/api/plays?gameId=${gameId}&since=${since ?? ''}`);
      return Promise.resolve(
        plays.filter((p) => p.gameId === gameId)
          .filter((p) => since == null || Date.parse(p.playedAt) >= since * 1000),
      );
    },
    categories() {
      CALLS.push('/api/categories');
      return Promise.resolve(["Roll 'n Write"]);
    },
    logPlay(gameId: string) {
      POSTED.push(gameId);
      return Promise.resolve({ id: 'new-play', gameId, playedAt: '2026-08-16T20:00:00.000Z' });
    },
    cover() {
      return Promise.resolve({ buffer: Buffer.from('png'), contentType: 'image/png' });
    },
  };
}

const { boardGamesProvider } = await import('../server/src/providers/board-game-picker.js');
const { publicView, definitionFor, isConfigured } = await import('../server/src/providers/config.js');

const provider = () => boardGamesProvider({ def: DEF, client: asClient(stubClient()) });

// --- privacy ----------------------------------------------------------------- //

await ok('never asks the picker for /api/collection', async () => {
  CALLS = [];
  const p = provider();
  await p.libraries?.();
  await p.search?.('lantern', { libraries: [] });
  await p.buckets({
    cfg: {},
    entries: [{ id: 'harbour-lantern', batch: 3, queuedAt: NOW - 86400 * 2 }],
  });
  assert.ok(CALLS.length > 0, 'the stub saw no calls at all');
  assert.ok(
    !CALLS.some((c) => c.includes('/api/collection')),
    `a call reached /api/collection: ${CALLS.join(', ')}`,
  );
});

// --- configuration ------------------------------------------------------------ //

await ok('is configured by URL alone — the picker issues no token', async () => {
  assert.equal(isConfigured('board-game-picker', 'board-game-picker'), true);
  const def = definitionFor('board-game-picker');
  assert.ok(def, 'no implicit board-game-picker definition');
  const view = publicView(def);
  assert.equal(view.configured, true);
  assert.equal(view.supported, true);
  assert.equal(view.delivery, 'pull');
  assert.equal(view.vocabulary.unit, 'play');
  assert.equal(view.vocabulary.units, 'plays');
  assert.equal(view.vocabulary.unitShort, 'plays');
  assert.equal(view.vocabulary.member, 'game');
});

// --- search ------------------------------------------------------------------- //

await ok('search scopes to categories, and an empty term asks nothing', async () => {
  CALLS = [];
  const p = provider();
  assert.deepEqual(await p.search?.('', { libraries: [] }), []);
  assert.equal(CALLS.length, 0, 'an empty term still hit the picker');

  const hits = await p.search?.('lantern', { libraries: ["Roll 'n Write"] });
  assert.deepEqual(hits?.map((h) => h.id), ['harbour-lantern']);
});

await ok('the implicit collection scope is not sent as a category', async () => {
  CALLS = [];
  await provider().search?.('lantern', { libraries: ['collection'] });
  assert.ok(
    CALLS.some((c) => c.startsWith('/api/games?q=lantern&categories=')) && CALLS.every((c) => !c.includes('categories=collection')),
    `collection leaked into the category filter: ${CALLS.join(', ')}`,
  );
});

// --- the load-bearing one ------------------------------------------------------ //

await ok('counts plays since queued_at, never the lifetime play log', async () => {
  const res: BucketsResult = await provider().buckets({
    cfg: {},
    entries: [{ id: 'harbour-lantern', batch: 3, queuedAt: Math.floor(Date.parse('2026-08-01T00:00:00.000Z') / 1000) }],
  });

  // 20 plays years ago + 1 since it was queued, of 3 owed => 2 left, and the next one is #2.
  const buckets = res.buckets as { gameId: string; owed: number; played: number; remaining: number }[];
  assert.equal(buckets[0]?.played, 1, 'the lifetime log was counted');
  assert.equal(buckets[0]?.remaining, 2);
  assert.equal(res.play.length, 1, 'one Open is one play by default');
  const head = res.play[0] as { gameId: string; number: number; of: number };
  assert.equal(head.gameId, 'harbour-lantern');
  assert.equal(head.number, 2);
  assert.equal(head.of, 3);
});

await ok('an entry with no queued_at counts every play it can see', async () => {
  // The stamp is written on first read (launcher), so this is the pre-stamp state and it is
  // deliberately NOT treated as "since the beginning of time is fine".
  const res = await provider().buckets({
    cfg: {},
    entries: [{ id: 'harbour-lantern', batch: 3, queuedAt: null }],
  });
  assert.equal(res.play.length, 0, 'a lifetime of plays should exhaust a batch of 3');
});

await ok('entries beat libraries: no entries is an empty lineup, not the shelf', async () => {
  const res = await provider().buckets({ cfg: {}, entries: [], libraries: ['collection'] });
  assert.deepEqual(res.play, []);
});

await ok('the head is played out before the next game leads', async () => {
  const res = await provider().buckets({
    cfg: {},
    entries: [
      { id: 'harbour-lantern', batch: 3, queuedAt: NOW },
      { id: 'orchard', batch: 1, queuedAt: NOW },
    ],
  });
  assert.equal((res.play[0] as { gameId: string }).gameId, 'harbour-lantern');
});

await ok('a queue batch of 3 takes three plays of the head, and never spills into the next game', async () => {
  const res = await provider().buckets({
    batch: 3,
    cfg: {},
    entries: [
      { id: 'harbour-lantern', batch: 3, queuedAt: NOW },
      { id: 'orchard', batch: 1, queuedAt: NOW },
    ],
  });
  assert.equal(res.play.length, 3);
  assert.ok(
    (res.play as { gameId: string }[]).every((i) => i.gameId === 'harbour-lantern'),
    'a night crossed into the next game',
  );
});

// --- tiles --------------------------------------------------------------------- //

await ok('a tile counts plays left and names the next play', async () => {
  const rows = await provider().tiles?.(['harbour-lantern', 'nope']);
  assert.equal(rows?.length, 2);
  assert.equal(rows?.[0]?.title, 'Harbour Lantern');
  assert.equal(rows?.[1], null, 'a vanished game must resolve to null, not throw');
});

// --- writing a play ------------------------------------------------------------ //

await ok('logProgress posts a play and attaches no people', async () => {
  POSTED = [];
  const res = await provider().logProgress?.('orchard');
  assert.deepEqual(POSTED, ['orchard']);
  assert.equal(res?.ok, true);
});

// --- handoff ------------------------------------------------------------------- //

await ok('materialize is a descriptor and handoff opens /play/<game>', async () => {
  const p = provider();
  const res = await p.buckets({ cfg: {}, entries: [{ id: 'orchard', batch: 1, queuedAt: NOW }] });
  const artifact = await p.materialize(res.play, { setName: 'games' }) as BoardGamesArtifact;
  assert.equal(artifact.kind, 'board-game-picker');
  assert.equal(artifact.gameId, 'orchard');
  assert.equal(artifact.url, 'https://board-game-picker.invalid/play/orchard');

  const handoff = await p.handoff(artifact) as PullResult;
  assert.equal(handoff.mode, 'pull');
  assert.equal(handoff.url, 'https://board-game-picker.invalid/play/orchard');
});

await ok('an empty lineup hands off an error rather than a URL', async () => {
  const p = provider();
  const artifact = await p.materialize([], { setName: 'games' }) as BoardGamesArtifact;
  const handoff = await p.handoff(artifact) as PullResult;
  assert.equal(handoff.url, null);
  assert.ok(handoff.error, 'no error sentence on an empty handoff');
});

// --- the launcher -------------------------------------------------------------- //

const { launchDescriptor } = await import('../server/src/providers/launcher.js');

await ok('/go/<set> 302s into the picker, and stamps queued_at on the way', async () => {
  const d = await launchDescriptor('games', { client: asClient(stubClient()) as never });
  assert.equal(d.status, 302);
  assert.ok(
    /^https:\/\/board-game-picker\.invalid\/play\/[a-z-]+$/.test(String(d.url)),
    `not a /play deep link: ${String(d.url)}`,
  );
  // The stamp is the whole reason a lifetime play log does not finish a queue on day one.
  const yaml = readFileSync(QUEUES_PATH, 'utf8');
  assert.ok(yaml.includes('queued_at'), 'no queued_at was written to queues.yaml');
});

await ok('a played-out queue answers 409, never the next library game', async () => {
  // Logged NOW, deliberately: the previous case stamped `queued_at` at the real clock, and
  // a play dated before that stamp is exactly the play this provider must not count. Using
  // a fixed past timestamp here would pass for the wrong reason.
  const justNow = new Date().toISOString();
  const spent = [
    ...PLAYS,
    ...Array.from({ length: 5 }, (_, i) => ({ id: `spent-${i}`, gameId: 'harbour-lantern', playedAt: justNow })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: `spent-o-${i}`, gameId: 'orchard', playedAt: justNow })),
  ];
  const d = await launchDescriptor('games', { client: asClient(stubClient({ plays: spent })) as never });
  assert.equal(d.status, 409);
  assert.equal(d.url, undefined);
});

await ok('a Plex queue still refuses to be opened by a link', async () => {
  const d = await launchDescriptor('tv');
  assert.equal(d.status, 409);
});

console.log(FAILS.length ? `\n${FAILS.length} FAILED: ${FAILS.join(', ')}` : '\nall green');
process.exit(FAILS.length ? 1 : 0);
