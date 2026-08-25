// THE WP-4b GATE — the collection arrives without disturbing a single wire id, and the same
// four questions get the same answers through the absorbed rows as through the source.
//
// Two servers, over two copies of ONE fixture directory. The first boots with NO collection
// file beside it; the second boots with a synthetic collection and a grouping seed sitting in
// the config directory. Between them, everything that already worked is compared as EXACT
// STRINGS.
//
// ── Why the assertions are strings and not counts ────────────────────────────────────────
//
// A count of four sets passes even if all four were replaced. A set id is what a physical NFC
// card carries and what Home Assistant puts in an MQTT `{"set": "<id>"}` payload, and a group
// id is a bookmarked `/g/<id>` URL. There is no redeploy that fixes a card on a wall.
//
// ── The lineup half, and how it is proved offline ────────────────────────────────────────
//
// The plan's gate is "the same board-game queue produces the same lineup through the absorbed
// data". The transport swap is WP-4e's, so what WP-4b owns is the half underneath it: for each
// of the FOUR calls the board-game provider makes, the migrated rows must answer with the same
// ids in the same order as the source does.
//
// So the reference answers here are computed STRAIGHT OFF THE SOURCE DATABASE, in this file,
// with plain SQL — not by calling the store's own read layer, which would be the store agreeing
// with itself. The three-layer fold (imported row, owner override, play count), the box and
// link orderings, the excluded-game rule and the empty-query rule are all re-derived
// independently and compared.
//
// ── The play bound is the point, not a detail ────────────────────────────────────────────
//
// A queue entry counts plays SINCE IT WAS QUEUED, never the lifetime `playCount` — otherwise a
// game with twenty lifetime plays and a batch of three is finished the moment it is queued. So
// the fixture gives one game two plays at known times, and the bound is checked either side of
// each of them.
//
// Nothing here reaches the network: Plex is a closed port and there is no picker to call.
//
// Run:  server/node_modules/.bin/tsx e2e/board-game-absorb-test.ts   (repo root; non-zero on failure)
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ChildProcess } from 'node:child_process';

import { killServer, spawnServer } from './stubs/server-process.mjs';

let failures = 0;
const ok = (name: string, condition: boolean, extra = ''): void => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!condition) failures += 1;
};

/** Compare by value. ARRAY order is a contract here and is compared strictly — it is shelf
 * order, box order and link order. OBJECT key order is not, so keys are sorted first; a row
 * off `node:sqlite` carries its keys in SELECT order and would otherwise fail on that alone. */
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : item,
  );

const same = (name: string, actual: unknown, expected: unknown): void =>
  ok(
    name,
    stable(actual) === stable(expected),
    stable(actual) === stable(expected)
      ? ''
      : `got ${stable(actual)} want ${stable(expected)}`,
  );

// ── the fixture ───────────────────────────────────────────────────────────────────────── //
//
// The existing e2e cast — Bob, Alice, Carol, Dave, Erin — is kept for the sets and groups.
// EVERY GAME TITLE, PUBLISHER AND PERSON BELOW IS INVENTED. This repo is public, and seeding a
// fixture from the live collection is exactly the shortcut this package's own rules forbid.

const SET_IDS = ['bob_movies', 'carol_shows'] as const;
const GROUP_IDS = ['bob', 'carol'] as const;

const SETS = `sets:
- id: bob_movies
  label: Bob — Movies
  kind: picks
  source: queue
  requires_profile: bob_plex
  sections: [1]
- id: carol_shows
  label: Carol — Shows
  kind: cartoons
  source: rotation
  sections: [5]
`;

const QUEUES = `bob_movies:
- {ratingKey: "1", title: "A Movie (2001)"}
`;

const GROUPS = `groups:
- id: bob
  label: Bob
  accounts:
    plex: [bob_plex]
- id: carol
  label: Carol
  accounts:
    plex: [carol_plex]
`;

/**
 * The source app's schema as `PRAGMA table_xinfo` reports it on a RUNNING database, which is
 * not what its schema file says. `game_overrides.is_excluded_source` and `game_modules.is_hidden`
 * are both here on purpose: the first is the column a schema-driven copy would have dropped,
 * the second is the one the absorb drops deliberately.
 */
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
/** Two plays of ONE game, at known times. The bound is checked either side of each. */
const PLAY_TIMES = ['2026-02-01T20:00:00.000Z', '2026-03-01T20:00:00.000Z'] as const;

const SEED = `version: 1
groupings:
- prefix: harbour lantern voyages
  game_id: harbour-lantern-voyages
  game_name: "Harbour Lantern: Voyages"
  is_game_from_expansions: true
- prefix: harbour lantern
  game_id: harbour-lantern
  game_name: Harbour Lantern
  listing_bgg_id: 100001
- prefix: quarry duel amber
  game_id: quarry-duel-amber
  game_name: "Quarry Duel: Amber"
  except_contains: solo challenger
reviews:
- box_label: tidewright expeditions
- box_label: quarry duel skirmish
`;

/** Build the synthetic collection. Three titles, five boxes, and one of everything that can go
 * wrong: an owner exclusion, a sync exclusion, an override that widens a player count, an
 * unrecognised box kind and link kind, a module carrying the vestigial column, and two people
 * with claims. */
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
  game.run('tidewright', 'Tidewright', 1, 4, '[2]', '[1,3]', 3.6, 45, 90, 12,
    '["cooperative"]', 'owner', '[]', '["Saltmarsh Games"]', 2021, 100002, 8.1, NOW, NOW, null);
  game.run('quarry-duel', 'Quarry Duel', 2, 2, '[2]', '[]', 1.8, 15, 20, 8,
    '["competitive"]', 'derived', '[]', '["Northwind Press"]', 2016, null, null, NOW, NOW, null);

  const box = db.prepare(
    `INSERT INTO boxes (id, game_id, label, kind, bgg_id, homebox_entity_id, location_text,
       image_path, created_at, version_nickname, version_year, version_languages)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
  );
  box.run('box-1', 'harbour-lantern', 'Harbour Lantern', 'standalone', 100001,
    '/images/aaaa-600.webp', NOW, 'Deluxe', 2019, '["English"]');
  box.run('box-2', 'harbour-lantern', 'Harbour Lantern: Deep Water', 'expansion', 100003, null,
    NOW, null, null, '[]');
  box.run('box-3', 'tidewright', 'Tidewright', 'standalone', 100002, '/images/bbbb-600.webp',
    NOW, null, null, '[]');
  box.run('box-4', 'quarry-duel', 'Quarry Duel', 'nonsense-kind', null, null, NOW, null, null,
    '[]');
  box.run('box-5', 'quarry-duel', 'Quarry Duel: Amber', 'expansion', null, null, NOW, null,
    null, '[]');

  const override = db.prepare(
    `INSERT INTO game_overrides (game_id, min_players, max_players, best_with, recommended_with,
       weight, min_age, interaction_types, is_excluded, notes, updated_at, is_excluded_source,
       image_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Off the shelf BY HAND — the row the whole `is_excluded_source` argument is about.
  override.run('harbour-lantern', null, null, null, null, null, null, null, 1, null, NOW,
    'owner', '/images/cccc-600.webp');
  // Removed by a sync, which is the one a sync is allowed to take back.
  override.run('tidewright', null, null, null, null, null, null, null, 1, null, NOW, 'sync',
    null);
  override.run('quarry-duel', 2, 6, '[4]', null, 2.1, null, '["team"]', 0, 'Great with four.',
    NOW, null, null);

  const link = db.prepare(
    `INSERT INTO game_links (id, game_id, kind, label, url, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  link.run('link-1', 'harbour-lantern', 'howToPlay', 'Watch it', 'https://example.test/2',
    'derived', NOW);
  link.run('link-2', 'harbour-lantern', 'rulebook', 'Rulebook', 'https://example.test/1',
    'owner', NOW);
  link.run('link-3', 'tidewright', 'nonsense-kind', 'Player aid', 'https://example.test/3',
    'derived', NOW);

  db.prepare(
    `INSERT INTO game_modules (id, game_id, name, source, box_id, is_hidden, created_at)
     VALUES ('mod-1', 'harbour-lantern', 'Deep Water', 'derived', 'box-2', 1, ?)`,
  ).run(NOW);

  db.prepare("INSERT INTO categories (name, created_at) VALUES ('Two Player', ?)").run(NOW);
  db.prepare("INSERT INTO categories (name, created_at) VALUES ('Quick', ?)").run(NOW);
  db.prepare(
    "INSERT INTO game_categories (game_id, name) VALUES ('quarry-duel', 'Two Player')",
  ).run();

  const grouping = db.prepare(
    `INSERT INTO owner_groupings (box_label, game_id, game_name, created_at, listing_bgg_id)
     VALUES (?, ?, ?, ?, ?)`,
  );
  grouping.run('Harbour Lantern: Deep Water', 'harbour-lantern', 'Harbour Lantern', NOW, 100001);
  // A box a SEEDED prefix rule also matches, and disagrees about. The owner's answer must win.
  grouping.run('Quarry Duel: Amber', 'quarry-duel', 'Quarry Duel', NOW, null);

  db.prepare(
    `INSERT INTO grouping_reviews (box_label, game_id, status, reason, reviewed_at, parent_game_id)
     VALUES ('Tidewright Expeditions', NULL, 'possibleEdition', 'Shares a prefix.', NULL,
             'tidewright')`,
  ).run();

  const player = db.prepare(
    `INSERT INTO players (id, display_name, birth_year, max_weight, is_beginner, created_at)
     VALUES (?, ?, NULL, ?, 0, ?)`,
  );
  player.run('player-ada', 'Ada', 4.5, NOW);
  player.run('player-grace', 'Grace', null, NOW);

  const play = db.prepare(
    'INSERT INTO plays (id, game_id, played_at, notes) VALUES (?, ?, ?, NULL)',
  );
  play.run('play-1', 'quarry-duel', PLAY_TIMES[0]);
  play.run('play-2', 'quarry-duel', PLAY_TIMES[1]);
  db.prepare(
    "INSERT INTO play_players (play_id, player_id) VALUES ('play-1', 'player-ada')",
  ).run();

  const known = db.prepare(
    'INSERT INTO player_known_games (player_id, game_id, confirmed_at) VALUES (?, ?, ?)',
  );
  known.run('player-ada', 'quarry-duel', NOW);
  known.run('player-grace', 'tidewright', NOW);

  db.close();
}

interface Capture {
  setIds: string[];
  groupIds: string[];
  queueIds: string[];
  entryCount: number;
  requiresProfile: Record<string, string | null>;
  groupPageStatus: Record<string, number>;
  storePath: string;
  sourcePath: string;
}

async function boot(label: string, port: number, withCollection: boolean): Promise<Capture> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), `qp-bg-${label}-`));
  await fs.writeFile(path.join(dir, 'sets.yaml'), SETS);
  await fs.writeFile(path.join(dir, 'queues.yaml'), QUEUES);
  await fs.writeFile(path.join(dir, 'groups.yaml'), GROUPS);
  await fs.writeFile(path.join(dir, 'pending.yaml'), 'seen_through: 0\n');

  const sourcePath = path.join(dir, 'board-game-picker-import.sqlite');
  if (withCollection) {
    writeSource(sourcePath);
    await fs.writeFile(path.join(dir, 'board-game-grouping-seed.yaml'), SEED);
  }

  const child: ChildProcess = spawnServer({
    env: {
      ...process.env,
      CACHE_PATH: path.join(dir, 'cache.sqlite'),
      GROUPS_PATH: path.join(dir, 'groups.yaml'),
      HISTORY_PATH: path.join(dir, '.history.json'),
      MQTT_HOST: '',
      MQTT_PASS: '',
      MQTT_PORT: '',
      MQTT_USER: '',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      PENDING_PATH: path.join(dir, 'pending.yaml'),
      PLEX_API_SERVER_URL: 'https://127.0.0.1:1',
      PLEX_TOKEN: '',
      QUEUES_PATH: path.join(dir, 'queues.yaml'),
      SETS_PATH: path.join(dir, 'sets.yaml'),
      STORE_BACKEND: 'sqlite',
      WEB_PORT: String(port),
    },
    stdio: 'ignore',
  });

  try {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        await fetch(`http://localhost:${port}/api/history`);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    const registry = (await (await fetch(`http://localhost:${port}/api/sets`)).json()) as {
      sets: { id: string; requires_profile?: string }[];
    };
    const groups = (await (await fetch(`http://localhost:${port}/api/groups`)).json()) as {
      groups: { id: string }[];
    };
    const queues = (await (await fetch(`http://localhost:${port}/api/queues`)).json()) as
      Record<string, unknown[]>;

    const groupPageStatus: Record<string, number> = {};
    for (const id of GROUP_IDS) {
      groupPageStatus[id] = (await fetch(`http://localhost:${port}/g/${id}`)).status;
    }

    return {
      entryCount: Object.values(queues).reduce(
        (sum, list) => sum + (Array.isArray(list) ? list.length : 0),
        0,
      ),
      groupIds: groups.groups.map((group) => group.id),
      groupPageStatus,
      queueIds: Object.keys(queues).sort(),
      requiresProfile: Object.fromEntries(
        registry.sets.map((set) => [set.id, set.requires_profile ?? null]),
      ),
      setIds: registry.sets.map((set) => set.id),
      sourcePath,
      storePath: path.join(dir, 'queues.queuepilot.sqlite'),
    };
  } finally {
    await new Promise((resolve) => {
      child.once('exit', resolve);
      killServer(child);
    });
  }
}

// ── 1. NO collection file — the absorb does nothing at all ────────────────────────────── //

const before = await boot('empty', 18841, false);

same('the set ids are exactly the registry, in file order', before.setIds, [...SET_IDS]);
same('the group ids are exactly the file, `all` first', before.groupIds, ['all', ...GROUP_IDS]);
same('every `requires_profile` survived verbatim', before.requiresProfile, {
  bob_movies: 'bob_plex',
  carol_shows: null,
});

{
  const db = new DatabaseSync(before.storePath, { readOnly: true });
  const rows = db
    .prepare('SELECT COUNT(*) AS c FROM board_games')
    .get() as { c: number };
  ok('with no collection file the tables exist and are EMPTY', rows.c === 0, `got ${rows.c}`);
  db.close();
}

// ── 2. WITH a collection — every wire id is untouched ─────────────────────────────────── //

const after = await boot('absorbed', 18842, true);

same('the set ids are IDENTICAL after the absorb', after.setIds, before.setIds);
same('the group ids are IDENTICAL after the absorb', after.groupIds, before.groupIds);
same('the queue ids are IDENTICAL after the absorb', after.queueIds, before.queueIds);
same('the entry count is IDENTICAL after the absorb', after.entryCount, before.entryCount);
same('every `requires_profile` is IDENTICAL after the absorb',
  after.requiresProfile, before.requiresProfile);
same('every `/g/<id>` still opens', after.groupPageStatus, before.groupPageStatus);
// …and 200, not merely the same code twice. Without `web/dist` the SPA fallback answers 404 on
// BOTH runs, and the comparison above passes while proving nothing about a bookmarked group
// URL. CI builds the web bundle before this job, so the only reader this line catches is a
// developer running the gate by hand — which is exactly who over-trusts a green run.
ok(
  'every `/g/<id>` answers 200, not the same 404 twice',
  Object.values(after.groupPageStatus).every((status) => status === 200),
  JSON.stringify(after.groupPageStatus),
);

// ── 3. the rows, read straight off the store the server left behind ───────────────────── //

const store = new DatabaseSync(after.storePath, { readOnly: true });
const source = new DatabaseSync(after.sourcePath, { readOnly: true });

const count = (db: DatabaseSync, sql: string): number =>
  (db.prepare(`SELECT COUNT(*) AS c FROM ${sql}`).get() as { c: number }).c;

same('board_games == games', count(store, 'board_games'), count(source, 'games'));
same('board_game_boxes == boxes', count(store, 'board_game_boxes'), count(source, 'boxes'));
same('board_game_overrides == game_overrides',
  count(store, 'board_game_overrides'), count(source, 'game_overrides'));
same('board_game_links == game_links',
  count(store, 'board_game_links'), count(source, 'game_links'));
same('board_game_modules == game_modules',
  count(store, 'board_game_modules'), count(source, 'game_modules'));
same('board_game_categories == categories',
  count(store, 'board_game_categories'), count(source, 'categories'));
same('board_game_category_members == game_categories',
  count(store, 'board_game_category_members'), count(source, 'game_categories'));
same('board_game_plays == plays', count(store, 'board_game_plays'), count(source, 'plays'));
same('board_game_play_people == play_players',
  count(store, 'board_game_play_people'), count(source, 'play_players'));
same('board_game_known_how == player_known_games',
  count(store, 'board_game_known_how'), count(source, 'player_known_games'));

// The column a schema-driven copy would have dropped, with its values kept apart.
same('an owner exclusion is still an OWNER exclusion',
  count(store, "board_game_overrides WHERE is_excluded_source = 'owner'"),
  count(source, "game_overrides WHERE is_excluded_source = 'owner'"));
same('a sync exclusion is still a SYNC exclusion',
  count(store, "board_game_overrides WHERE is_excluded_source = 'sync'"),
  count(source, "game_overrides WHERE is_excluded_source = 'sync'"));
same('an unstated exclusion source stayed unstated',
  count(store, 'board_game_overrides WHERE is_excluded_source IS NULL'),
  count(source, 'game_overrides WHERE is_excluded_source IS NULL'));

ok(
  'the vestigial `is_hidden` column did not come across',
  !(store.prepare('PRAGMA table_xinfo(board_game_modules)').all() as { name: string }[]).some(
    (column) => column.name === 'is_hidden',
  ),
);

// The rule tables: the owner's rows are the source's, and the seed only ADDS.
same('the owner grouping rules are the source rules',
  (store
    .prepare("SELECT box_label, game_id FROM board_game_groupings WHERE source = 'owner' ORDER BY box_label")
    .all() as { box_label: string; game_id: string }[]),
  (source
    .prepare('SELECT box_label, game_id FROM owner_groupings ORDER BY box_label')
    .all() as { box_label: string; game_id: string }[]));
same('the seed added one row per PREFIX, in file order',
  (store
    .prepare("SELECT prefix FROM board_game_groupings WHERE source = 'migration' ORDER BY position")
    .all() as { prefix: string }[]).map((row) => row.prefix),
  ['harbour lantern voyages', 'harbour lantern', 'quarry duel amber']);
same('the rule carrying an exception kept it',
  (store
    .prepare("SELECT except_contains FROM board_game_groupings WHERE prefix = 'quarry duel amber'")
    .get() as { except_contains: string | null }).except_contains,
  'solo challenger');
// The owner's open question is not answered by a seed that names the same box in comparison
// form — the two are different strings and a primary-key conflict would never have fired.
same('an open owner review is still open, and the seed only answered the other one',
  (store
    .prepare('SELECT box_label, source, status, reviewed_at IS NULL AS is_open FROM board_game_grouping_reviews ORDER BY box_label')
    .all() as unknown[]),
  [
    { box_label: 'Tidewright Expeditions', is_open: 1, source: 'owner', status: 'possibleEdition' },
    { box_label: 'quarry duel skirmish', is_open: 0, source: 'migration', status: 'confirmedSeparate' },
  ]);

// The people-keyed rows hold the SOURCE app's player ids, because the people import is gated
// and has not run. That is the expected state, not a fault.
same('known-how arrived holding the source app’s own player ids',
  (store
    .prepare('SELECT person_id, game_id FROM board_game_known_how ORDER BY person_id')
    .all() as { person_id: string; game_id: string }[]),
  (source
    .prepare('SELECT player_id AS person_id, game_id FROM player_known_games ORDER BY player_id')
    .all() as { person_id: string; game_id: string }[]));
same('no person resolves yet, because the people import is gated',
  count(store, 'people'), 0);

// ── 4. THE LINEUP GATE — the four provider calls, both paths ──────────────────────────── //
//
// The reference side is computed here, off the SOURCE database, with plain SQL. It is a second
// implementation of the same rules on purpose: comparing the store's read layer against itself
// would prove nothing.

interface RefGame {
  id: string;
  name: string;
  publishers: string[];
  yearPublished: number | null;
  isExcluded: boolean;
  ownerCategories: string[];
  boxes: string[];
  links: string[];
  playCount: number;
  imagePath: string | null;
}

const referenceGames: RefGame[] = (
  source
    .prepare(
      `SELECT g.id, g.name, g.publishers, g.year_published, g.image_path,
              o.is_excluded, o.image_path AS o_image_path
       FROM games g LEFT JOIN game_overrides o ON o.game_id = g.id
       ORDER BY g.name COLLATE NOCASE`,
    )
    .all() as {
    id: string;
    name: string;
    publishers: string;
    year_published: number | null;
    image_path: string | null;
    is_excluded: number | null;
    o_image_path: string | null;
  }[]
).map((row) => {
  const boxes = (
    source
      .prepare('SELECT id, image_path FROM boxes WHERE game_id = ? ORDER BY label COLLATE NOCASE')
      .all(row.id) as { id: string; image_path: string | null }[]
  );
  return {
    boxes: boxes.map((box) => box.id),
    id: row.id,
    imagePath:
      row.o_image_path ?? row.image_path ?? boxes.find((box) => box.image_path)?.image_path ?? null,
    isExcluded: row.is_excluded === 1,
    links: (
      source
        .prepare(
          `SELECT id FROM game_links WHERE game_id = ?
           ORDER BY CASE kind WHEN 'rulebook' THEN 0 WHEN 'howToPlay' THEN 1 ELSE 2 END,
                    label COLLATE NOCASE`,
        )
        .all(row.id) as { id: string }[]
    ).map((link) => link.id),
    name: row.name,
    ownerCategories: (
      source
        .prepare('SELECT name FROM game_categories WHERE game_id = ? ORDER BY name COLLATE NOCASE')
        .all(row.id) as { name: string }[]
    ).map((category) => category.name),
    playCount: count(source, `plays WHERE game_id = '${row.id}'`),
    publishers: JSON.parse(row.publishers) as string[],
    yearPublished: row.year_published,
  };
});

/** The integration API's own search, re-derived. Empty term answers nothing; an excluded game
 * is never offered; name, publisher and year all match. */
const referenceSearch = (query: string, categories: string[] = []): string[] => {
  const term = query.trim().toLowerCase();
  if (term === '') return [];
  const wanted = new Set(categories.filter(Boolean));
  return referenceGames
    .filter((game) => {
      if (game.isExcluded) return false;
      if (wanted.size > 0 && !game.ownerCategories.some((name) => wanted.has(name))) return false;
      return (
        game.name.toLowerCase().includes(term) ||
        game.publishers.some((publisher) => publisher.toLowerCase().includes(term)) ||
        String(game.yearPublished ?? '').includes(term)
      );
    })
    .map((game) => game.id);
};

process.env.QUEUES_PATH = path.join(path.dirname(after.storePath), 'queues.yaml');
process.env.STORE_PATH = after.storePath;
process.env.STORE_BACKEND = 'sqlite';
const { openBookOfRecord } = await import('../server/src/store/db/open.js');
const {
  getBoardGame,
  listBoardGameCategories,
  listBoardGamePlays,
  listBoardGames,
  searchBoardGames,
} = await import('../server/src/store/db/boardgames.js');

const migrated = openBookOfRecord(after.storePath);
const games = listBoardGames(migrated);

// 4a — GET /api/categories
same('the owner’s category vocabulary is identical',
  listBoardGameCategories(migrated),
  (source.prepare('SELECT name FROM categories ORDER BY name COLLATE NOCASE').all() as {
    name: string;
  }[]).map((row) => row.name));

// 4b — GET /api/games?q=&categories=
for (const term of ['', 'a', 'lantern', 'quarry', 'northwind', '2016', '2019', 'zzz']) {
  same(`search ${JSON.stringify(term)} returns the same ids in the same order`,
    searchBoardGames(games, { query: term }).map((game) => game.id), referenceSearch(term));
}
same('a category-scoped search returns the same ids',
  searchBoardGames(games, { categories: ['Two Player'], query: 'a' }).map((game) => game.id),
  referenceSearch('a', ['Two Player']));

// 4c — GET /api/games/:id
for (const reference of referenceGames) {
  const game = getBoardGame(reference.id, migrated);
  same(`${reference.id}: name`, game?.name, reference.name);
  same(`${reference.id}: boxes in label order`, game?.boxes.map((box) => box.id), reference.boxes);
  same(`${reference.id}: links, rulebook first`, game?.links.map((link) => link.id), reference.links);
  same(`${reference.id}: ownerCategories`, game?.ownerCategories, reference.ownerCategories);
  same(`${reference.id}: imagePath falls back the same way`, game?.imagePath, reference.imagePath);
  same(`${reference.id}: lifetime playCount`, game?.playCount, reference.playCount);
  same(`${reference.id}: isExcluded`, game?.isExcluded, reference.isExcluded);
}

// 4d — GET /api/plays?gameId=&since=, and the bound that IS the point.
const plays = listBoardGamePlays(migrated);
const playsSince = (gameId: string, since: number | null): string[] =>
  plays
    .filter((play) => play.gameId === gameId)
    .filter((play) => since === null || Date.parse(play.playedAt) >= since)
    .map((play) => play.id)
    .sort();
const referencePlaysSince = (gameId: string, since: number | null): string[] =>
  (source.prepare('SELECT id, played_at FROM plays WHERE game_id = ?').all(gameId) as {
    id: string;
    played_at: string;
  }[])
    .filter((play) => since === null || Date.parse(play.played_at) >= since)
    .map((play) => play.id)
    .sort();

const first = Date.parse(PLAY_TIMES[0]);
const second = Date.parse(PLAY_TIMES[1]);
for (const [label, since] of [
  ['no bound', null],
  ['before both plays', first - 1000],
  ['between the two plays', first + 1000],
  ['after both plays', second + 1000],
] as [string, number | null][]) {
  same(`plays for quarry-duel, ${label}`,
    playsSince('quarry-duel', since), referencePlaysSince('quarry-duel', since));
}

// The whole reason `queued_at` exists: an entry queued after the first play owes its batch from
// there, not from a lifetime count that says the game is already finished.
same('a queue entry queued between the two plays sees ONE, not the lifetime TWO',
  [playsSince('quarry-duel', first + 1000).length, getBoardGame('quarry-duel', migrated)?.playCount],
  [1, 2]);

migrated.close();
store.close();
source.close();

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
