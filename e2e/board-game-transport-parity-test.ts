// THE WP-4e GATE — the same board-game queue produces the same lineup on both transports.
//
// The package's claim is that `providers/board-game-picker-client.ts` can stop speaking HTTP
// and answer out of the book of record instead, and that `providers/board-game-picker.ts` does
// not change. A claim like that is proved by running BOTH and comparing, which is what this
// file does: one shelf, expressed twice, and every answer the provider gives compared value
// for value.
//
// ── The two sides, and why neither one is the other's mirror ─────────────────────────────
//
//   HTTP side        a real `node:http` server implementing the sibling app's four
//                    integration endpoints over HAND-WRITTEN fixture objects. The endpoint
//                    bodies are transcribed from that app's `api/integration.ts`, not called
//                    into this repo — an HTTP stub that served rows out of our own store
//                    would be the store agreeing with itself.
//
//   in-process side  the SAME shelf written into a source database in the sibling app's own
//                    schema, absorbed by `store/migrate/boardgames.ts`, and read back through
//                    `store/db/boardgames.ts`.
//
// So a difference here is a real difference: the migration dropped a column, the fold got a
// field wrong, an ordering moved, or the client's shape drifted.
//
// ── What is compared ─────────────────────────────────────────────────────────────────────
//
//   1. The CLIENT payloads, object for object. `game()` returned the sibling app's whole
//      `Game` over the wire, and it returns the same object now.
//   2. Every PROVIDER answer: `libraries`, `search`, `buckets`, `tiles`, `progressState`,
//      `materialize` and `handoff`. `buckets` is the lineup and is the headline.
//   3. `cover()` — the BYTES and the content type. One reads the staged
//      `board-game-images/` directory, the other fetches `/images/<file>` from the stub.
//   4. That the in-process transport makes ZERO HTTP requests for any read. The stub counts
//      every request it sees.
//
// ── Two things this gate deliberately does NOT let pass ──────────────────────────────────
//
//   `queued_at`. A game with a lifetime of plays behind it and a batch of three must have
//   three plays left the day it is queued. The fixture gives one title twenty old plays and
//   one recent one, and the bound is checked either side.
//
//   The play WRITE is still HTTP, and this file pins that rather than hiding it. `logPlay()`
//   POSTs to the sibling app in both modes, because two books of record are open and the
//   absorb replaces all twelve tables on a fingerprint change. The test asserts the POST goes
//   over the wire AND that the local store did not gain a play row.
//
// ⚠️ Every game title, publisher and person below is INVENTED. This repo is public.
//
// Run:  server/node_modules/.bin/tsx e2e/board-game-transport-parity-test.ts   (repo root)
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';

// ── the scratch config directory, before anything reads an env var ──────────────────────── //

const SCRATCH = mkdtempSync(path.join(tmpdir(), 'qp-bg-transport-'));
const IMAGES = path.join(SCRATCH, 'board-game-images');
mkdirSync(IMAGES, { recursive: true });

process.env.QUEUES_PATH = path.join(SCRATCH, 'queues.yaml');
process.env.SETS_PATH = path.join(SCRATCH, 'sets.yaml');
process.env.GROUPS_PATH = path.join(SCRATCH, 'groups.yaml');
process.env.PENDING_PATH = path.join(SCRATCH, 'pending.yaml');
process.env.STORE_PATH = path.join(SCRATCH, 'queuepilot.sqlite');
process.env.CACHE_PATH = path.join(SCRATCH, 'cache.sqlite');
process.env.PROVIDERS_PATH = path.join(SCRATCH, 'providers.yaml');
process.env.PROVIDERS_SECRETS_PATH = path.join(SCRATCH, 'providers.secrets.yaml');
process.env.STORE_BACKEND = 'sqlite';
// This workspace's shell carries real broker credentials and CI does not. A harness that does
// not blank them dials the household broker and retries forever.
process.env.MQTT_HOST = '';
process.env.MQTT_PASS = '';
process.env.MQTT_PORT = '';
process.env.MQTT_USER = '';
process.env.PLEX_TOKEN = '';
writeFileSync(process.env.QUEUES_PATH, '');
writeFileSync(process.env.SETS_PATH, 'sets: []\n');

let failures = 0;
const ok = (name: string, condition: boolean, extra = ''): void => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!condition) failures += 1;
};

/** Compare by value. ARRAY order is a contract — shelf order, box order, link order, play
 * order — so it is strict. OBJECT key order is not; keys are sorted first. */
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : item,
  ) ?? 'undefined';

const same = (name: string, http: unknown, repo: unknown): void => {
  const a = stable(http);
  const b = stable(repo);
  ok(name, a === b, a === b ? '' : `http ${a}\n     repo ${b}`);
};

// ── the shelf, written once as rows ─────────────────────────────────────────────────────── //
//
// The source app's schema as `PRAGMA table_xinfo` reports it on a RUNNING database, which is
// not what its schema file says — `game_overrides.is_excluded_source` is present here for the
// same reason `board-game-absorb-test.ts` has it.

const SOURCE_SCHEMA = `
CREATE TABLE games (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, min_players INTEGER NOT NULL,
  max_players INTEGER NOT NULL, best_with TEXT NOT NULL DEFAULT '[]',
  recommended_with TEXT NOT NULL DEFAULT '[]', weight REAL, min_playtime INTEGER,
  max_playtime INTEGER, min_age INTEGER,
  interaction_types TEXT NOT NULL DEFAULT '["competitive"]',
  interaction_types_source TEXT NOT NULL DEFAULT 'derived',
  categories TEXT NOT NULL DEFAULT '[]', publishers TEXT NOT NULL DEFAULT '[]',
  year_published INTEGER, bgg_id INTEGER, rating REAL,
  source TEXT NOT NULL DEFAULT 'import', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  image_path TEXT);
CREATE TABLE boxes (
  id TEXT PRIMARY KEY, game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  label TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'standalone', bgg_id INTEGER,
  homebox_entity_id TEXT, location_text TEXT, image_path TEXT, created_at TEXT NOT NULL,
  version_nickname TEXT, version_year INTEGER, version_languages TEXT NOT NULL DEFAULT '[]');
CREATE TABLE game_overrides (
  game_id TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE, min_players INTEGER,
  max_players INTEGER, best_with TEXT, recommended_with TEXT, weight REAL, min_age INTEGER,
  interaction_types TEXT, is_excluded INTEGER, notes TEXT, updated_at TEXT NOT NULL,
  is_excluded_source TEXT, image_path TEXT);
CREATE TABLE game_links (
  id TEXT PRIMARY KEY, game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, label TEXT NOT NULL, url TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'owner', created_at TEXT NOT NULL);
CREATE TABLE game_modules (
  id TEXT PRIMARY KEY, game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  name TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'owner', box_id TEXT,
  is_hidden INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE categories (name TEXT PRIMARY KEY, created_at TEXT NOT NULL);
CREATE TABLE game_categories (
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  name TEXT NOT NULL REFERENCES categories(name) ON DELETE CASCADE,
  PRIMARY KEY (game_id, name));
CREATE TABLE owner_groupings (
  box_label TEXT PRIMARY KEY, game_id TEXT NOT NULL, game_name TEXT NOT NULL,
  created_at TEXT NOT NULL, listing_bgg_id INTEGER);
CREATE TABLE grouping_reviews (
  box_label TEXT PRIMARY KEY, game_id TEXT, status TEXT NOT NULL, reason TEXT,
  reviewed_at TEXT, parent_game_id TEXT);
CREATE TABLE players (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL, birth_year INTEGER, max_weight REAL,
  is_beginner INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE plays (
  id TEXT PRIMARY KEY, game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  played_at TEXT NOT NULL, notes TEXT);
CREATE TABLE play_players (
  play_id TEXT NOT NULL REFERENCES plays(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  PRIMARY KEY (play_id, player_id));
CREATE TABLE player_known_games (
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  confirmed_at TEXT NOT NULL, PRIMARY KEY (player_id, game_id));
`;

const NOW = '2026-01-01T00:00:00.000Z';
/** Twenty plays years ago, each at its OWN minute. Ties on `played_at` have no defined order
 * and the two sides sort them separately, so identical stamps would fail for the wrong reason. */
const OLD_PLAYS = Array.from({ length: 20 }, (_, i) => ({
  id: `play-old-${i}`,
  gameId: 'harbour-lantern',
  playedAt: `2019-01-01T20:${String(i).padStart(2, '0')}:00.000Z`,
}));
const RECENT_PLAY = {
  id: 'play-recent',
  gameId: 'harbour-lantern',
  playedAt: '2026-08-15T20:00:00.000Z',
};
const ORCHARD_PLAY = {
  id: 'play-orchard',
  gameId: 'orchard-run',
  playedAt: '2026-08-20T20:00:00.000Z',
};
const ALL_PLAYS = [...OLD_PLAYS, RECENT_PLAY, ORCHARD_PLAY];

/** Newest first, the ordering the read layer guarantees and the endpoint inherited. */
const PLAYS_NEWEST_FIRST = [...ALL_PLAYS].sort((a, b) =>
  a.playedAt < b.playedAt ? 1 : a.playedAt > b.playedAt ? -1 : 0,
);

const IMAGE_BYTES: Record<string, Buffer> = {
  'aaaa-600.webp': Buffer.from('RIFF----WEBPVP8 harbour', 'utf8'),
  'bbbb-600.webp': Buffer.from('RIFF----WEBPVP8 orchard-box', 'utf8'),
  'cccc-600.webp': Buffer.from('RIFF----WEBPVP8 quarry-owner-art', 'utf8'),
};
for (const [file, bytes] of Object.entries(IMAGE_BYTES)) {
  writeFileSync(path.join(IMAGES, file), bytes);
}

function writeSource(file: string): void {
  const db = new DatabaseSync(file);
  db.exec(SOURCE_SCHEMA);

  const game = db.prepare(
    `INSERT INTO games (id, name, min_players, max_players, best_with, recommended_with, weight,
       min_playtime, max_playtime, min_age, interaction_types, interaction_types_source,
       categories, publishers, year_published, bgg_id, rating, source, created_at, updated_at,
       image_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', ?, ?, ?)`,
  );
  game.run('harbour-lantern', 'Harbour Lantern', 2, 5, '[3,4]', '[2,5]', 2.4, 30, 60, 10,
    '["competitive"]', 'derived', '["Card Game"]', '["Northwind Press"]', 2019, 100001, 7.4,
    NOW, NOW, '/images/aaaa-600.webp');
  // No art of its own — its cover falls back to the first box that has one.
  game.run('orchard-run', 'Orchard Run', 1, 4, '[2]', '[1,3]', 3.6, 45, 90, 12,
    '["cooperative"]', 'owner', '[]', '["Saltmarsh Games"]', 2021, 100002, 8.1, NOW, NOW, null);
  // Taken off the shelf BY HAND. It must never be offered by a search, on either transport.
  game.run('quarry-duel', 'Quarry Duel', 2, 2, '[2]', '[]', 1.8, 15, 20, 8,
    '["competitive"]', 'derived', '[]', '["Northwind Press"]', 2016, null, null, NOW, NOW, null);
  // No art anywhere. `cover()` must fail the same way on both transports.
  game.run('attic-owls', 'Attic Owls', 3, 6, '[]', '[]', null, null, null, null,
    '["competitive"]', 'derived', '[]', '["Saltmarsh Games"]', null, null, null, NOW, NOW, null);

  const box = db.prepare(
    `INSERT INTO boxes (id, game_id, label, kind, bgg_id, homebox_entity_id, location_text,
       image_path, created_at, version_nickname, version_year, version_languages)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
  );
  box.run('box-1', 'harbour-lantern', 'Harbour Lantern', 'standalone', 100001, 'Shelf A',
    '/images/aaaa-600.webp', NOW, 'Deluxe', 2019, '["English"]');
  box.run('box-2', 'harbour-lantern', 'Harbour Lantern: Deep Water', 'expansion', 100003, null,
    null, NOW, null, null, '[]');
  box.run('box-3', 'orchard-run', 'Orchard Run', 'standalone', 100002, 'Shelf B',
    '/images/bbbb-600.webp', NOW, null, null, '[]');
  // An unrecognised kind, which both sides must fold to `standalone`.
  box.run('box-4', 'quarry-duel', 'Quarry Duel', 'nonsense-kind', null, null, null, NOW, null,
    null, '[]');

  const override = db.prepare(
    `INSERT INTO game_overrides (game_id, min_players, max_players, best_with, recommended_with,
       weight, min_age, interaction_types, is_excluded, notes, updated_at, is_excluded_source,
       image_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  override.run('orchard-run', null, 6, '[4]', null, 2.1, null, null, 0, 'Great with four.',
    NOW, null, null);
  override.run('quarry-duel', null, null, null, null, null, null, null, 1, null, NOW, 'owner',
    '/images/cccc-600.webp');

  const link = db.prepare(
    `INSERT INTO game_links (id, game_id, kind, label, url, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  link.run('link-1', 'harbour-lantern', 'howToPlay', 'Watch it', 'https://example.test/2',
    'derived', NOW);
  link.run('link-2', 'harbour-lantern', 'rulebook', 'Rulebook', 'https://example.test/1',
    'owner', NOW);
  // An unrecognised kind, which both sides must fold to `reference`.
  link.run('link-3', 'orchard-run', 'nonsense-kind', 'Player aid', 'https://example.test/3',
    'derived', NOW);

  db.prepare(
    `INSERT INTO game_modules (id, game_id, name, source, box_id, is_hidden, created_at)
     VALUES ('mod-1', 'harbour-lantern', 'Deep Water', 'derived', 'box-2', 0, ?)`,
  ).run(NOW);

  const category = db.prepare('INSERT INTO categories (name, created_at) VALUES (?, ?)');
  category.run('Quick', NOW);
  category.run("Roll 'n Write", NOW);
  db.prepare(
    `INSERT INTO game_categories (game_id, name) VALUES ('harbour-lantern', 'Roll ''n Write')`,
  ).run();

  const play = db.prepare(
    'INSERT INTO plays (id, game_id, played_at, notes) VALUES (?, ?, ?, NULL)',
  );
  for (const row of ALL_PLAYS) play.run(row.id, row.gameId, row.playedAt);

  db.close();
}

writeSource(path.join(SCRATCH, 'board-game-picker-import.sqlite'));

// ── the same shelf, written again as the objects the endpoint served ────────────────────── //
//
// Hand-written on purpose. Deriving these from our own read layer would make the comparison
// below the store agreeing with itself; deriving them with a second copy of the fold would
// only test the copy. Every value here was read off the sibling app's `toGame()` by hand:
// the override wins field by field, `NULL` means "not overridden" rather than "cleared", and
// a cover falls back owner → import → the first box that has art.

interface FixtureGame { [field: string]: unknown }

const ATTIC_OWLS: FixtureGame = {
  bestWith: [], bggId: null, boxes: [], categories: [], id: 'attic-owls',
  imagePath: null, imageSource: null, interactionTypes: ['competitive'],
  interactionTypesSource: 'derived', isExcluded: false, links: [], maxPlayers: 6,
  maxPlaytime: null, minAge: null, minPlayers: 3, minPlaytime: null, modules: [],
  name: 'Attic Owls', notes: null, ownerCategories: [], playCount: 0,
  publishers: ['Saltmarsh Games'], rating: null, recommendedWith: [], weight: null,
  yearPublished: null,
};

const HARBOUR_LANTERN: FixtureGame = {
  bestWith: [3, 4],
  bggId: 100001,
  boxes: [
    {
      bggId: 100001, gameId: 'harbour-lantern', homeboxEntityId: null, id: 'box-1',
      imagePath: '/images/aaaa-600.webp', kind: 'standalone', label: 'Harbour Lantern',
      locationText: 'Shelf A', versionLanguages: ['English'], versionNickname: 'Deluxe',
      versionYear: 2019,
    },
    {
      bggId: 100003, gameId: 'harbour-lantern', homeboxEntityId: null, id: 'box-2',
      imagePath: null, kind: 'expansion', label: 'Harbour Lantern: Deep Water',
      locationText: null, versionLanguages: [], versionNickname: null, versionYear: null,
    },
  ],
  categories: ['Card Game'],
  id: 'harbour-lantern',
  imagePath: '/images/aaaa-600.webp',
  imageSource: 'import',
  interactionTypes: ['competitive'],
  interactionTypesSource: 'derived',
  isExcluded: false,
  // Rulebook, then how-to-play, then everything else.
  links: [
    {
      gameId: 'harbour-lantern', id: 'link-2', kind: 'rulebook', label: 'Rulebook',
      source: 'owner', url: 'https://example.test/1',
    },
    {
      gameId: 'harbour-lantern', id: 'link-1', kind: 'howToPlay', label: 'Watch it',
      source: 'derived', url: 'https://example.test/2',
    },
  ],
  maxPlayers: 5,
  maxPlaytime: 60,
  minAge: 10,
  minPlayers: 2,
  minPlaytime: 30,
  modules: [
    { boxId: 'box-2', gameId: 'harbour-lantern', id: 'mod-1', name: 'Deep Water', source: 'derived' },
  ],
  name: 'Harbour Lantern',
  notes: null,
  ownerCategories: ["Roll 'n Write"],
  playCount: 21,
  publishers: ['Northwind Press'],
  rating: 7.4,
  recommendedWith: [2, 5],
  weight: 2.4,
  yearPublished: 2019,
};

const ORCHARD_RUN: FixtureGame = {
  // The override sets `best_with` and `max_players` and `weight` and leaves the rest NULL,
  // so the imported values survive beside them.
  bestWith: [4],
  bggId: 100002,
  boxes: [
    {
      bggId: 100002, gameId: 'orchard-run', homeboxEntityId: null, id: 'box-3',
      imagePath: '/images/bbbb-600.webp', kind: 'standalone', label: 'Orchard Run',
      locationText: 'Shelf B', versionLanguages: [], versionNickname: null, versionYear: null,
    },
  ],
  categories: [],
  id: 'orchard-run',
  // No art of its own; the first box that has one answers, and the source is still `import`.
  imagePath: '/images/bbbb-600.webp',
  imageSource: 'import',
  interactionTypes: ['cooperative'],
  interactionTypesSource: 'owner',
  isExcluded: false,
  links: [
    {
      gameId: 'orchard-run', id: 'link-3', kind: 'reference', label: 'Player aid',
      source: 'derived', url: 'https://example.test/3',
    },
  ],
  maxPlayers: 6,
  maxPlaytime: 90,
  minAge: 12,
  minPlayers: 1,
  minPlaytime: 45,
  modules: [],
  name: 'Orchard Run',
  notes: 'Great with four.',
  ownerCategories: [],
  playCount: 1,
  publishers: ['Saltmarsh Games'],
  rating: 8.1,
  recommendedWith: [1, 3],
  weight: 2.1,
  yearPublished: 2021,
};

const QUARRY_DUEL: FixtureGame = {
  bestWith: [2],
  bggId: null,
  boxes: [
    {
      bggId: null, gameId: 'quarry-duel', homeboxEntityId: null, id: 'box-4', imagePath: null,
      kind: 'standalone', label: 'Quarry Duel', locationText: null, versionLanguages: [],
      versionNickname: null, versionYear: null,
    },
  ],
  categories: [],
  id: 'quarry-duel',
  imagePath: '/images/cccc-600.webp',
  imageSource: 'owner',
  interactionTypes: ['competitive'],
  interactionTypesSource: 'derived',
  isExcluded: true,
  links: [],
  maxPlayers: 2,
  maxPlaytime: 20,
  minAge: 8,
  minPlayers: 2,
  minPlaytime: 15,
  modules: [],
  name: 'Quarry Duel',
  notes: null,
  ownerCategories: [],
  playCount: 0,
  publishers: ['Northwind Press'],
  rating: null,
  recommendedWith: [],
  weight: 1.8,
  yearPublished: 2016,
};

/** Shelf order — `ORDER BY name COLLATE NOCASE`. */
const SHELF = [ATTIC_OWLS, HARBOUR_LANTERN, ORCHARD_RUN, QUARRY_DUEL];
const MASTER_CATEGORIES = ['Quick', "Roll 'n Write"];

// ── the sibling app's four endpoints, transcribed ───────────────────────────────────────── //
//
// `searchGames`, `parseSince` and `toIntegrationPlays` are copied from that app's
// `api/integration.ts`. Not imported, not re-derived from our rows — this is the OTHER side of
// the comparison and it has to be able to disagree.

const searchGames = (
  games: FixtureGame[],
  { categories = [], query = '' }: { categories?: string[]; query?: string },
): FixtureGame[] => {
  const term = query.trim().toLowerCase();
  if (term === '') return [];

  const wanted = new Set(
    categories.map((category) => category.trim()).filter((category) => category !== ''),
  );

  return games.filter((game) => {
    if (game.isExcluded) return false;
    if (
      wanted.size > 0 &&
      !(game.ownerCategories as string[]).some((category) => wanted.has(category))
    ) {
      return false;
    }
    return (
      (game.name as string).toLowerCase().includes(term) ||
      (game.publishers as string[]).some((publisher) => publisher.toLowerCase().includes(term)) ||
      String((game.yearPublished as number | null) ?? '').includes(term)
    );
  });
};

const parseSince = (since: string | undefined): number | null => {
  if (!since) return null;
  const asEpochSeconds = Number(since);
  if (Number.isFinite(asEpochSeconds)) return asEpochSeconds * 1000;
  const parsed = Date.parse(since);
  return Number.isNaN(parsed) ? null : parsed;
};

const toIntegrationPlays = (
  plays: { id: string; gameId: string; playedAt: string }[],
  { gameId, since }: { gameId?: string; since?: string } = {},
) => {
  const after = parseSince(since);
  return plays
    .filter((play) => {
      if (gameId && play.gameId !== gameId) return false;
      if (after === null) return true;
      const playedAt = Date.parse(play.playedAt);
      return !Number.isNaN(playedAt) && playedAt >= after;
    })
    .map((play) => ({ gameId: play.gameId, id: play.id, playedAt: play.playedAt }));
};

/** Every request the stub saw. The in-process transport must add NOTHING to this for a read. */
const SEEN: string[] = [];
const POSTED: string[] = [];

const handle = (req: IncomingMessage, res: ServerResponse): void => {
  const url = new URL(req.url ?? '/', 'http://stub.invalid');
  SEEN.push(`${req.method ?? 'GET'} ${url.pathname}${url.search}`);

  const json = (body: unknown, status = 200): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (req.method === 'POST' && url.pathname === '/api/plays') {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { gameId?: string };
      POSTED.push(String(body.gameId ?? ''));
      // Three keys, and no people — which is the confirmed live defect WP-8 owns, reproduced
      // here rather than papered over. See
      // `agentic:docs/research/2026-08-25-a-logged-play-records-no-players.md`.
      json({ gameId: body.gameId, id: 'play-new', playedAt: '2026-08-25T20:00:00.000Z' });
    });
    return;
  }

  if (url.pathname === '/api/games') {
    json(searchGames(SHELF, {
      categories: (url.searchParams.get('categories') ?? '')
        .split(',')
        .filter((category) => category !== ''),
      query: url.searchParams.get('q') ?? '',
    }));
    return;
  }

  if (url.pathname.startsWith('/api/games/')) {
    const id = decodeURIComponent(url.pathname.slice('/api/games/'.length));
    const game = SHELF.find((candidate) => candidate.id === id);
    if (!game) { json({ error: 'game not found' }, 404); return; }
    json(game);
    return;
  }

  if (url.pathname === '/api/plays') {
    json(toIntegrationPlays(PLAYS_NEWEST_FIRST, {
      gameId: url.searchParams.get('gameId') ?? undefined,
      since: url.searchParams.get('since') ?? undefined,
    }));
    return;
  }

  if (url.pathname === '/api/categories') { json(MASTER_CATEGORIES); return; }

  if (url.pathname.startsWith('/images/')) {
    const bytes = IMAGE_BYTES[url.pathname.slice('/images/'.length)];
    if (!bytes) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'image/webp' });
    res.end(bytes);
    return;
  }

  res.writeHead(404);
  res.end();
};

const server: Server = createServer(handle);
await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// ── absorb the shelf, then build one provider per transport ─────────────────────────────── //

const { importBoardGames } = await import('../server/src/store/migrate/boardgames.js');
const absorb = importBoardGames();
ok('the fixture collection absorbed', absorb.imported, absorb.reason);
ok('four titles landed', absorb.counts.board_games === 4, `got ${absorb.counts.board_games}`);
ok(
  'twenty-two plays landed and nobody was invented to sit at them',
  absorb.counts.board_game_plays === 22 && absorb.counts.board_game_play_people === 0,
  `plays ${absorb.counts.board_game_plays}, people ${absorb.counts.board_game_play_people}`,
);

/** Known-how claims before any play is logged, so §5 can prove none were invented. */
const KNOWN_HOW_BEFORE = absorb.counts.board_game_known_how;

const { boardGamesHttpClient, boardGamesRepositoryClient } =
  await import('../server/src/providers/board-game-picker-client.js');
const { boardGamesProvider } = await import('../server/src/providers/board-game-picker.js');

const DEF = {
  base_url: BASE,
  id: 'board-game-picker',
  kind: 'board-game-picker',
  label: 'Board Game Picker',
};

// The SAME `base_url` for both, so a difference in `/play/<game>` is a difference and not the
// harness. The in-process client never dials it for a read; the play POST does.
const http = boardGamesHttpClient({ baseUrl: BASE });
const repo = boardGamesRepositoryClient({ baseUrl: BASE });
const viaHttp = boardGamesProvider({ client: http, def: DEF });
const viaRepo = boardGamesProvider({ client: repo, def: DEF });

const epoch = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
/** Before the one recent play — the entry has seen it. */
const QUEUED_BEFORE = epoch('2026-08-01T00:00:00.000Z');
/** After it — the entry has seen nothing, even though the shelf shows 21 lifetime plays. */
const QUEUED_AFTER = epoch('2026-08-16T00:00:00.000Z');

// ── 1. the client payloads ──────────────────────────────────────────────────────────────── //

for (const [name, query, categories] of [
  ['every title with an "a" in it', 'a', []],
  ['an empty term asks for nothing', '', []],
  ['a publisher finds its games', 'northwind', []],
  ['a year is searchable', '2019', []],
  ['scoped to one owner category', 'a', ["Roll 'n Write"]],
  ['an excluded title is never offered', 'quarry', []],
  ['a category nobody carries', 'a', ['Quick']],
] as [string, string, string[]][]) {
  same(`games(): ${name}`, await http.games(query, categories), await repo.games(query, categories));
}

for (const id of ['harbour-lantern', 'orchard-run', 'quarry-duel', 'attic-owls', 'nope']) {
  same(`game('${id}') is the same object`, await http.game(id), await repo.game(id));
}

for (const [name, gameId, since] of [
  ['the whole lifetime log', 'harbour-lantern', null],
  ['since before the recent play', 'harbour-lantern', QUEUED_BEFORE],
  ['since after the recent play', 'harbour-lantern', QUEUED_AFTER],
  ['a bound of zero is a bound, not "no bound"', 'harbour-lantern', 0],
  ['another title', 'orchard-run', QUEUED_BEFORE],
  ['a title with no plays', 'attic-owls', null],
  ['a title that is not there', 'nope', null],
] as [string, string, number | null][]) {
  same(`plays(): ${name}`, await http.plays(gameId, since), await repo.plays(gameId, since));
}

same('categories()', await http.categories(), await repo.categories());

// The privacy rule did not retire with the transport, it moved. `listBoardGamePlays()` carries
// `playerIds` and `notes`; the client must drop both, exactly as the endpoint hand-wrote them
// out.
const repoPlays = await repo.plays('harbour-lantern', null);
ok(
  'a play carries three keys and never a person',
  repoPlays.every((play) => stable(Object.keys(play).sort()) === stable(['gameId', 'id', 'playedAt'])),
  stable(repoPlays[0]),
);

// ── 2. the provider answers ─────────────────────────────────────────────────────────────── //

same('libraries()', await viaHttp.libraries?.(), await viaRepo.libraries?.());

for (const [name, term, libraries] of [
  ['unscoped', 'a', []],
  ['scoped to a category', 'a', ["Roll 'n Write"]],
  ['a stored `collection` id still means the whole shelf', 'a', ['collection', "Roll 'n Write"]],
  ['an empty term', '', []],
  ['an excluded title', 'quarry', []],
] as [string, string, string[]][]) {
  same(
    `search(): ${name}`,
    await viaHttp.search?.(term, { libraries }),
    await viaRepo.search?.(term, { libraries }),
  );
}

const SCENARIOS: [string, Parameters<typeof viaHttp.buckets>[0]][] = [
  [
    'one play since it was queued, of three owed',
    { cfg: {}, entries: [{ id: 'harbour-lantern', batch: 3, queuedAt: QUEUED_BEFORE }] },
  ],
  [
    'QUEUED AFTER the only recent play — twenty lifetime plays count for nothing',
    { cfg: {}, entries: [{ id: 'harbour-lantern', batch: 3, queuedAt: QUEUED_AFTER }] },
  ],
  [
    'no queued_at at all — the pre-stamp state, and the lifetime log does exhaust it',
    { cfg: {}, entries: [{ id: 'harbour-lantern', batch: 3, queuedAt: null }] },
  ],
  [
    'a queue batch of three takes three plays of the head and never spills',
    {
      batch: 3,
      cfg: {},
      entries: [
        { id: 'harbour-lantern', batch: 3, queuedAt: QUEUED_AFTER },
        { id: 'orchard-run', batch: 1, queuedAt: QUEUED_AFTER },
      ],
    },
  ],
  [
    'the head is played out before the next game leads',
    {
      cfg: {},
      entries: [
        { id: 'harbour-lantern', batch: 3, queuedAt: null },
        { id: 'orchard-run', batch: 2, queuedAt: QUEUED_AFTER },
      ],
    },
  ],
  [
    'plays-per-Open off the set config',
    { cfg: { episodes: 2 }, entries: [{ id: 'orchard-run', batch: 4, queuedAt: QUEUED_AFTER }] },
  ],
  [
    'entries beat libraries — no entries is an empty lineup, not the shelf',
    { cfg: {}, entries: [], libraries: ['collection'] },
  ],
  [
    'a game that has vanished resolves to nothing rather than throwing',
    { cfg: {}, entries: [{ id: 'nope', batch: 1, queuedAt: QUEUED_BEFORE }] },
  ],
  [
    'an excluded title still plays — Remove is a search rule, not a queue rule',
    { cfg: {}, entries: [{ id: 'quarry-duel', batch: 2, queuedAt: QUEUED_BEFORE }] },
  ],
];

/** `Provider.progressState` is a union — Kavita answers a richer object. This provider answers
 * a Set of finished game ids, and anything else is the failure rather than an empty answer. */
const doneIds = async (
  provider: typeof viaHttp,
  ctx: Parameters<typeof viaHttp.buckets>[0],
): Promise<string[]> => {
  const state = await provider.progressState?.(ctx);
  if (!(state instanceof Set)) throw new Error(`progressState answered ${stable(state)}`);
  return [...state].sort();
};

for (const [name, ctx] of SCENARIOS) {
  same(`buckets(): ${name}`, await viaHttp.buckets(ctx), await viaRepo.buckets(ctx));
  same(`progressState(): ${name}`, await doneIds(viaHttp, ctx), await doneIds(viaRepo, ctx));
}

const TILE_IDS = ['harbour-lantern', 'orchard-run', 'attic-owls', 'quarry-duel', 'nope'];
const TILE_ENTRIES = [
  { id: 'harbour-lantern', batch: 3, queuedAt: QUEUED_BEFORE },
  { id: 'orchard-run', batch: 1, queuedAt: QUEUED_AFTER },
];
same(
  'tiles() — plays left, the next play and a null for a vanished game',
  await viaHttp.tiles?.(TILE_IDS, TILE_ENTRIES),
  await viaRepo.tiles?.(TILE_IDS, TILE_ENTRIES),
);

const LINEUP = { cfg: {}, entries: [{ id: 'harbour-lantern', batch: 3, queuedAt: QUEUED_BEFORE }] };
const httpArtifact = await viaHttp.materialize((await viaHttp.buckets(LINEUP)).play, { setName: 'games' });
const repoArtifact = await viaRepo.materialize((await viaRepo.buckets(LINEUP)).play, { setName: 'games' });
same('materialize() — the descriptor', httpArtifact, repoArtifact);
same('handoff() — the /play/<game> URL', await viaHttp.handoff(httpArtifact), await viaRepo.handoff(repoArtifact));

const EMPTY = await viaHttp.materialize([], { setName: 'games' });
same(
  'handoff() — an empty lineup is an error sentence, not a URL',
  await viaHttp.handoff(EMPTY),
  await viaRepo.handoff(await viaRepo.materialize([], { setName: 'games' })),
);

// ── 3. the covers — the BYTES, not a status code ────────────────────────────────────────── //

const cover = async (client: typeof http, gameId: string): Promise<unknown> => {
  try {
    const art = await client.cover(gameId);
    return { contentType: art.contentType, sha: art.buffer.toString('base64') };
  } catch {
    // The sentences differ by design — one names a URL, the other names the staged file — so
    // what is compared is THAT it failed, not how.
    return { failed: true };
  }
};

for (const id of ['harbour-lantern', 'orchard-run', 'quarry-duel', 'attic-owls', 'nope']) {
  same(`cover('${id}')`, await cover(http, id), await cover(repo, id));
}

ok(
  'the staged art is what the in-process cover returned, byte for byte',
  (await repo.cover('harbour-lantern')).buffer.equals(IMAGE_BYTES['aaaa-600.webp'] as Buffer),
);
ok(
  'a game with no art fails rather than serving a blank',
  await repo.cover('attic-owls').then(() => false, () => true),
);

// ── 4. the in-process transport makes NO HTTP REQUEST for a read ────────────────────────── //

const before = SEEN.length;
await viaRepo.libraries?.();
await viaRepo.search?.('a', { libraries: [] });
await viaRepo.buckets(LINEUP);
await viaRepo.tiles?.(TILE_IDS, TILE_ENTRIES);
await viaRepo.progressState?.(LINEUP);
await repo.cover('harbour-lantern');
ok(
  'a whole read pass over the in-process transport touched the network zero times',
  SEEN.length === before,
  `${SEEN.length - before} request(s): ${SEEN.slice(before).join(', ')}`,
);
const leaked = SEEN.filter((request) => request.includes('/api/collection'));
ok(
  'and none of them, on either transport, ever asked for /api/collection',
  leaked.length === 0,
  leaked.join(', '),
);

// ── 5. THE WRITE CAME HOME (WP-4d), and the two transports now DIFFER on purpose ────────── //
//
// This section used to pin "neither transport wrote a play row here". That was the correct
// assertion while two books of record were open: the absorb REPLACED all twelve tables on a
// fingerprint change, so a play written locally was erased by the next start.
//
// WP-4d retires the source file in the same change as the first writers, so the erasing cannot
// happen and the write belongs where the reads are. The assertion is not weakened, it is
// INVERTED and made specific — the in-process transport writes exactly one row and the HTTP one
// writes none HERE. A gate that still passed unchanged after a write came home would be a gate
// that was never watching the write.

const { bookOfRecord } = await import('../server/src/store/db/open.js');
const countPlays = (): number =>
  (bookOfRecord().prepare('SELECT COUNT(*) AS c FROM board_game_plays').get() as { c: number }).c;

// ── the HTTP transport: still a POST, still nothing local ──
const httpPlaysBefore = countPlays();
const httpPostsBefore = POSTED.length;
const httpAnswer = await viaHttp.logProgress?.('orchard-run');
ok(
  'BOARD_GAME_TRANSPORT=http still POSTs the play to the sibling app',
  POSTED.length - httpPostsBefore === 1 && POSTED[POSTED.length - 1] === 'orchard-run',
  POSTED.slice(httpPostsBefore).join(', '),
);
ok(
  'and the HTTP transport writes NO row here — it is the rollback, and it stays remote',
  countPlays() === httpPlaysBefore,
  `${httpPlaysBefore} -> ${countPlays()}`,
);

// ── the in-process transport: the write is local now ──
const repoPlaysBefore = countPlays();
const repoPostsBefore = POSTED.length;
const repoAnswer = await viaRepo.logProgress?.('orchard-run');
same('logProgress() answers the same shape on both transports', httpAnswer, repoAnswer);
ok(
  '🐞 THE IN-PROCESS TRANSPORT WRITES THE PLAY HERE, and touches the network zero times',
  countPlays() === repoPlaysBefore + 1 && POSTED.length === repoPostsBefore,
  `plays ${repoPlaysBefore} -> ${countPlays()}, posts ${POSTED.length - repoPostsBefore}`,
);

// ── and it still records nobody, which is the CORRECT answer on this path ──
//
// Not the WP-8 defect. Whoever pressed "we played this" on a tile is not filling in a form, and
// a play may RENEW a known-how claim but must never INVENT one — so guessing the roster here
// would write a claim against a name that appears on no screen. The screen that asks who was at
// the table is the Collection screen, and it posts somewhere else.
const people = (bookOfRecord()
  .prepare('SELECT COUNT(*) AS c FROM board_game_play_people')
  .get() as { c: number }).c;
ok(
  'a play logged from a TILE names nobody, and invents nobody',
  people === 0,
  `board_game_play_people has ${people} rows`,
);

const claims = (bookOfRecord()
  .prepare('SELECT COUNT(*) AS c FROM board_game_known_how')
  .get() as { c: number }).c;
ok(
  'and it created no known-how claim out of a counter',
  claims === KNOWN_HOW_BEFORE,
  `${KNOWN_HOW_BEFORE} -> ${claims}`,
);

server.close();
console.log(failures ? `\n${failures} FAILED` : '\nall green');
process.exit(failures ? 1 : 0);
