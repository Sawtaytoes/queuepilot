// THE ABSORB, and the four ways it could lose something quietly.
//
// In order of how expensive the mistake is:
//
//   1. A COLUMN THE SOURCE SCHEMA FILE DOES NOT DECLARE. `is_excluded_source` exists in the
//      running database and not in the source repo's schema file, and it is the difference
//      between a title the owner took off the shelf and one a sync removed. A copy built from
//      the file would merge the two and the next sync would silently re-offer every hand-
//      excluded title. Nothing about that failure is visible.
//   2. A HAND-WRITTEN COLUMN LIST that transposes two columns. Twelve of them, because the
//      tables were renamed on the way across.
//   3. A SEED THAT OVERWRITES AN OWNER RULE. The two halves of the rule system already
//      disagree about some boxes, with the owner's half winning; a seed that replaced rather
//      than skipped would reverse those answers on the way in.
//   4. A PERSON-KEYED ROW LOSING ITS PERSON. `board_game_known_how` is a claim a person
//      STATED, appears on no screen attached to a name, and is the one thing a wrong identity
//      match actually damages.
//
// Every path is a fresh `mkdtemp`, and the env is set BEFORE the modules are imported:
// `config.ts` resolves `QUEUES_PATH` and `STORE_PATH` at module load. Hence the dynamic
// imports at the bottom.
//
// EVERY TITLE AND EVERY PERSON HERE IS INVENTED. This repo is public, and a fixture seeded
// from the live collection is exactly the shortcut the absorb's own rules forbid. The cast is
// Ada, Grace and Linus.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'qp-boardgames-'));

writeFileSync(join(dir, 'sets.yaml'), 'sets: []\n');
writeFileSync(join(dir, 'queues.yaml'), '{}\n');
writeFileSync(join(dir, 'groups.yaml'), 'groups: []\n');
writeFileSync(join(dir, 'pending.yaml'), 'seen_through: 0\n');

process.env.QUEUES_PATH = join(dir, 'queues.yaml');
process.env.SETS_PATH = join(dir, 'sets.yaml');
process.env.GROUPS_PATH = join(dir, 'groups.yaml');
process.env.PENDING_PATH = join(dir, 'pending.yaml');
process.env.STORE_BACKEND = 'sqlite';
process.env.STORE_YAML_MIRROR = '0';

const SOURCE = join(dir, 'source.sqlite');
const SEED = join(dir, 'seed.yaml');
process.env.BOARD_GAME_IMPORT_PATH = SOURCE;
process.env.BOARD_GAME_GROUPING_SEED_PATH = SEED;

const { importBoardGames } = await import('./boardgames.js');
const {
  boardGameCounts,
  getBoardGame,
  listBoardGameKnownHow,
  listBoardGamePlays,
  listBoardGames,
  rekeyBoardGamePerson,
  searchBoardGames,
  unresolvedPersonIds,
} = await import('../db/boardgames.js');
const { bookOfRecord, closeBookOfRecord } = await import('../db/open.js');
const { upsertPerson } = await import('../db/people.js');

/**
 * The source app's schema, as `PRAGMA table_xinfo` reports it on a RUNNING database — which is
 * not what its schema file says. `game_overrides.is_excluded_source` and `game_modules.is_hidden`
 * are both here on purpose: the first is the column a schema-driven copy would drop, and the
 * second is the one this migration drops deliberately.
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

/** Build a source collection. Three titles, four boxes, and one of everything that matters. */
function writeSource({ excludedSource = 'owner' }: { excludedSource?: string | null } = {}): void {
  rmSync(SOURCE, { force: true });
  const db = new DatabaseSync(SOURCE);
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
    '["cooperative"]', 'owner', '[]', '["Saltmarsh Games"]', 2021, 100002, 8.1,
    NOW, NOW, null);
  game.run('quarry-duel', 'Quarry Duel', 2, 2, '[2]', '[]', 1.8, 15, 20, 8,
    '["competitive"]', 'derived', '[]', '[]', 2016, null, null, NOW, NOW, null);

  const box = db.prepare(
    `INSERT INTO boxes (id, game_id, label, kind, bgg_id, homebox_entity_id, location_text,
       image_path, created_at, version_nickname, version_year, version_languages)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
  );
  box.run('box-1', 'harbour-lantern', 'Harbour Lantern', 'standalone', 100001,
    '/images/aaaa-600.webp', NOW, 'Deluxe', 2019, '["English"]');
  box.run('box-2', 'harbour-lantern', 'Harbour Lantern: Deep Water', 'expansion', 100003,
    null, NOW, null, null, '[]');
  box.run('box-3', 'tidewright', 'Tidewright', 'standalone', 100002, '/images/bbbb-600.webp',
    NOW, null, null, '[]');
  box.run('box-4', 'quarry-duel', 'Quarry Duel', 'nonsense-kind', null, null, NOW, null, null,
    '[]');

  const override = db.prepare(
    `INSERT INTO game_overrides (game_id, min_players, max_players, best_with, recommended_with,
       weight, min_age, interaction_types, is_excluded, notes, updated_at, is_excluded_source,
       image_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Excluded BY HAND. This is the row the whole `is_excluded_source` argument is about.
  override.run('harbour-lantern', null, null, null, null, null, null, null, 1, null, NOW,
    excludedSource, '/images/cccc-600.webp');
  // Excluded by a sync — the one a sync is allowed to take back.
  override.run('tidewright', null, null, null, null, null, null, null, 1, null, NOW, 'sync', null);
  // Not excluded, and it overrides the player count the box claims.
  override.run('quarry-duel', 2, 6, '[4]', null, 2.1, null, '["team"]', 0, 'Great with four.',
    NOW, null, null);

  const link = db.prepare(
    `INSERT INTO game_links (id, game_id, kind, label, url, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  link.run('link-1', 'harbour-lantern', 'rulebook', 'Rulebook', 'https://example.test/1',
    'owner', NOW);
  link.run('link-2', 'harbour-lantern', 'howToPlay', 'Watch it', 'https://example.test/2',
    'derived', NOW);
  link.run('link-3', 'tidewright', 'nonsense-kind', 'Player aid', 'https://example.test/3',
    'derived', NOW);

  db.prepare(
    `INSERT INTO game_modules (id, game_id, name, source, box_id, is_hidden, created_at)
     VALUES ('mod-1', 'harbour-lantern', 'Deep Water', 'derived', 'box-2', 1, ?)`,
  ).run(NOW);

  db.prepare("INSERT INTO categories (name, created_at) VALUES ('Two Player', ?)").run(NOW);
  db.prepare(
    "INSERT INTO game_categories (game_id, name) VALUES ('quarry-duel', 'Two Player')",
  ).run();

  const grouping = db.prepare(
    `INSERT INTO owner_groupings (box_label, game_id, game_name, created_at, listing_bgg_id)
     VALUES (?, ?, ?, ?, ?)`,
  );
  grouping.run('Harbour Lantern: Deep Water', 'harbour-lantern', 'Harbour Lantern', NOW, 100001);
  // The owner's own answer for a box a seeded prefix rule ALSO matches, and disagrees about.
  grouping.run('Quarry Duel: Amber', 'quarry-duel', 'Quarry Duel', NOW, null);

  db.prepare(
    `INSERT INTO grouping_reviews (box_label, game_id, status, reason, reviewed_at, parent_game_id)
     VALUES ('Tidewright Expeditions', NULL, 'possibleEdition', 'Shares a prefix.', NULL,
             'tidewright')`,
  ).run();

  const player = db.prepare(
    "INSERT INTO players (id, display_name, birth_year, max_weight, is_beginner, created_at) VALUES (?, ?, NULL, ?, 0, ?)",
  );
  player.run('player-ada', 'Ada', 4.5, NOW);
  player.run('player-grace', 'Grace', null, NOW);

  db.prepare(
    "INSERT INTO plays (id, game_id, played_at, notes) VALUES ('play-1', 'quarry-duel', ?, NULL)",
  ).run('2026-01-02T20:00:00.000Z');
  db.prepare(
    "INSERT INTO plays (id, game_id, played_at, notes) VALUES ('play-2', 'quarry-duel', ?, NULL)",
  ).run('2026-01-03T20:00:00.000Z');
  db.prepare(
    "INSERT INTO play_players (play_id, player_id) VALUES ('play-1', 'player-ada')",
  ).run();

  const known = db.prepare(
    'INSERT INTO player_known_games (player_id, game_id, confirmed_at) VALUES (?, ?, ?)',
  );
  known.run('player-ada', 'quarry-duel', '2026-01-02T20:00:00.000Z');
  known.run('player-ada', 'tidewright', '2026-01-02T20:00:00.000Z');
  known.run('player-grace', 'quarry-duel', '2026-01-04T20:00:00.000Z');

  db.close();
}

const SEED_YAML = `version: 1
groupings:
- prefix: quarry duel amber
  game_id: quarry-duel-amber
  game_name: "Quarry Duel: Amber"
  is_game_from_expansions: true
  except_contains: solo challenger
- prefix: quarry duel
  game_id: quarry-duel
  game_name: Quarry Duel
  listing_bgg_id: 100004
- prefix: tidewright reborn
  game_id: tidewright
  game_name: Tidewright
- prefix: tidewright rise of the tide
  game_id: tidewright
  game_name: Tidewright
reviews:
- box_label: tidewright expeditions
  reason: A separate campaign game that shares the name.
- box_label: quarry duel skirmish
`;

const clearStore = (): void => {
  const db = bookOfRecord();
  db.exec('DELETE FROM store_meta');
  db.exec('DELETE FROM people');
  for (const table of [
    'board_game_known_how',
    'board_game_play_people',
    'board_game_plays',
    'board_game_grouping_reviews',
    'board_game_groupings',
    'board_game_category_members',
    'board_game_categories',
    'board_game_modules',
    'board_game_links',
    'board_game_overrides',
    'board_game_boxes',
    'board_games',
  ]) {
    db.exec(`DELETE FROM ${table}`);
  }
};

beforeEach(() => {
  rmSync(SEED, { force: true });
  writeSource();
  clearStore();
});

afterAll(() => {
  closeBookOfRecord();
  rmSync(dir, { force: true, recursive: true });
});

describe('the board-game absorb', () => {
  it('does nothing at all when there is no collection to absorb', () => {
    rmSync(SOURCE, { force: true });
    const result = importBoardGames();
    expect(result.imported).toBe(false);
    expect(result.source).toBeNull();
    expect(boardGameCounts()).toMatchObject({ board_games: 0 });
  });

  it('copies every table, and the counts match the source either side', () => {
    const result = importBoardGames();
    expect(result.problems).toEqual([]);
    expect(result.imported).toBe(true);
    expect(boardGameCounts()).toEqual({
      board_game_boxes: 4,
      board_game_categories: 1,
      board_game_category_members: 1,
      board_game_grouping_reviews: 1,
      board_game_groupings: 2,
      board_game_known_how: 3,
      board_game_links: 3,
      board_game_modules: 1,
      board_game_overrides: 3,
      board_game_play_people: 1,
      board_game_plays: 2,
      board_games: 3,
    });
  });

  it('carries `is_excluded_source` across, so an owner exclusion is not a sync exclusion', () => {
    importBoardGames();
    const rows = bookOfRecord()
      .prepare<{ game_id: string; is_excluded_source: string | null }>(
        'SELECT game_id, is_excluded_source FROM board_game_overrides ORDER BY game_id',
      )
      .all();
    expect(rows).toEqual([
      { game_id: 'harbour-lantern', is_excluded_source: 'owner' },
      { game_id: 'quarry-duel', is_excluded_source: null },
      { game_id: 'tidewright', is_excluded_source: 'sync' },
    ]);
  });

  it('rolls the WHOLE absorb back rather than writing a half-collection', () => {
    // An `is_excluded_source` this app does not recognise fails the column CHECK. The point of
    // the assertion is not the CHECK — it is that a failure anywhere leaves NOTHING behind, so
    // a partial copy can never be mistaken for an authoritative one.
    writeSource({ excludedSource: 'somebody-else' });
    const result = importBoardGames();
    expect(result.imported).toBe(false);
    expect(result.problems.length).toBeGreaterThan(0);
    expect(boardGameCounts()).toMatchObject({ board_game_overrides: 0, board_games: 0 });
  });

  it('drops the vestigial `is_hidden` column and keeps the module', () => {
    importBoardGames();
    const columns = bookOfRecord()
      .pragma('table_xinfo(board_game_modules)') as { name: string }[];
    expect(columns.map((column) => column.name)).not.toContain('is_hidden');
    expect(boardGameCounts().board_game_modules).toBe(1);
  });

  it('stores a listing id as TEXT and hands the engine a number', () => {
    importBoardGames();
    const raw = bookOfRecord()
      .prepare<{ bgg_id: unknown }>("SELECT bgg_id FROM board_games WHERE id = 'harbour-lantern'")
      .get();
    expect(typeof raw?.bgg_id).toBe('string');
    expect(getBoardGame('harbour-lantern')?.bggId).toBe(100001);
    // Nullable by design — a game need not exist on any external listing.
    expect(getBoardGame('quarry-duel')?.bggId).toBeNull();
  });

  it('folds the override onto the imported row, and NULL means "not overridden"', () => {
    importBoardGames();
    const game = getBoardGame('quarry-duel');
    expect(game?.minPlayers).toBe(2);
    // Overridden up from the box claim of 2.
    expect(game?.maxPlayers).toBe(6);
    expect(game?.bestWith).toEqual([4]);
    // The override leaves this one alone, so the imported value stands.
    expect(game?.recommendedWith).toEqual([]);
    expect(game?.interactionTypes).toEqual(['team']);
    expect(game?.interactionTypesSource).toBe('owner');
    expect(game?.notes).toBe('Great with four.');
    expect(game?.playCount).toBe(2);
  });

  it('falls a cover back owner → import → the first box that has art', () => {
    importBoardGames();
    expect(getBoardGame('harbour-lantern')?.imagePath).toBe('/images/cccc-600.webp');
    expect(getBoardGame('harbour-lantern')?.imageSource).toBe('owner');
    // No cover of its own and no box art either.
    expect(getBoardGame('quarry-duel')?.imagePath).toBeNull();
    expect(getBoardGame('quarry-duel')?.imageSource).toBeNull();
  });

  it('never offers an excluded game, and answers an empty search with nothing', () => {
    importBoardGames();
    const games = listBoardGames();
    expect(games.map((game) => game.id)).toEqual(['harbour-lantern', 'quarry-duel', 'tidewright']);
    expect(searchBoardGames(games, { query: '' })).toEqual([]);
    // `harbour-lantern` matches the term and is excluded by hand.
    expect(searchBoardGames(games, { query: 'lantern' })).toEqual([]);
    expect(searchBoardGames(games, { query: 'quarry' }).map((g) => g.id)).toEqual(['quarry-duel']);
    // A publisher name should find its games.
    expect(searchBoardGames(games, { query: 'northwind' })).toEqual([]);
    expect(searchBoardGames(games, { categories: ['Two Player'], query: 'quarry' }).length).toBe(1);
  });

  it('normalises an unrecognised box kind and link kind rather than refusing the row', () => {
    importBoardGames();
    const game = getBoardGame('quarry-duel');
    expect(game?.boxes[0]?.kind).toBe('standalone');
    expect(getBoardGame('tidewright')?.links[0]?.kind).toBe('reference');
  });

  it('is a no-op on a second run, and re-runs when the source changes', () => {
    expect(importBoardGames().imported).toBe(true);
    expect(importBoardGames().imported).toBe(false);
    expect(importBoardGames({ force: true }).imported).toBe(true);
  });
});

describe('the grouping-rule seed', () => {
  it('adds one row per PREFIX and leaves the owner rows exactly as they were', () => {
    writeFileSync(SEED, SEED_YAML);
    const result = importBoardGames();
    expect(result.problems).toEqual([]);
    // Four prefixes out of three rules — the two spellings of one franchise are two rows.
    expect(result.seededGroupings).toBe(4);
    expect(boardGameCounts().board_game_groupings).toBe(6);

    const owner = bookOfRecord()
      .prepare<{ box_label: string; game_id: string }>(
        "SELECT box_label, game_id FROM board_game_groupings WHERE source = 'owner' ORDER BY box_label",
      )
      .all();
    expect(owner).toEqual([
      { box_label: 'Harbour Lantern: Deep Water', game_id: 'harbour-lantern' },
      // ⚠️ The seed carries a prefix rule that ALSO matches this box and names a DIFFERENT
      // title for it. The owner's answer is untouched, which is the whole point of `source`.
      { box_label: 'Quarry Duel: Amber', game_id: 'quarry-duel' },
    ]);
  });

  it('keeps the file order, because the first matching prefix wins', () => {
    writeFileSync(SEED, SEED_YAML);
    importBoardGames();
    const prefixes = bookOfRecord()
      .prepare<{ prefix: string }>(
        "SELECT prefix FROM board_game_groupings WHERE source = 'migration' ORDER BY position",
      )
      .all()
      .map((row) => row.prefix);
    expect(prefixes).toEqual([
      'quarry duel amber',
      'quarry duel',
      'tidewright reborn',
      'tidewright rise of the tide',
    ]);
  });

  it('carries the exception and the from-expansions flag', () => {
    writeFileSync(SEED, SEED_YAML);
    importBoardGames();
    const rule = bookOfRecord()
      .prepare<{ except_contains: string | null; is_game_from_expansions: number; listing_bgg_id: string | null }>(
        "SELECT except_contains, is_game_from_expansions, listing_bgg_id FROM board_game_groupings WHERE prefix = 'quarry duel amber'",
      )
      .get();
    expect(rule).toEqual({
      except_contains: 'solo challenger',
      is_game_from_expansions: 1,
      listing_bgg_id: null,
    });
  });

  it('answers a review the owner has not, and skips one they already did', () => {
    writeFileSync(SEED, SEED_YAML);
    const result = importBoardGames();
    // Two in the seed; one of them names a box the owner's own open review already names, and
    // an answer already given wins.
    expect(result.seededReviews).toBe(1);
    const rows = bookOfRecord()
      .prepare<{ box_label: string; source: string; status: string; reviewed_at: string | null }>(
        'SELECT box_label, source, status, reviewed_at FROM board_game_grouping_reviews ORDER BY box_label',
      )
      .all();
    expect(rows).toEqual([
      // The owner's open question, untouched — still unanswered.
      {
        box_label: 'Tidewright Expeditions',
        reviewed_at: null,
        source: 'owner',
        status: 'possibleEdition',
      },
      {
        box_label: 'quarry duel skirmish',
        reviewed_at: expect.any(String) as unknown as string,
        source: 'migration',
        status: 'confirmedSeparate',
      },
    ]);
  });

  it('does not double the rules on a re-run', () => {
    writeFileSync(SEED, SEED_YAML);
    importBoardGames();
    importBoardGames({ force: true });
    expect(boardGameCounts().board_game_groupings).toBe(6);
    expect(boardGameCounts().board_game_grouping_reviews).toBe(2);
  });

  it('refuses a prefix that is a pattern, and writes NOTHING', () => {
    writeFileSync(SEED, `version: 1\ngroupings:\n- prefix: "^quarry duel.*"\n  game_id: q\n  game_name: Q\n`);
    const result = importBoardGames();
    expect(result.imported).toBe(false);
    expect(result.problems.join(' ')).toContain('LITERAL');
    expect(boardGameCounts().board_games).toBe(0);
  });

  it('refuses a seed with no version, and writes NOTHING', () => {
    writeFileSync(SEED, 'groupings: []\n');
    const result = importBoardGames();
    expect(result.imported).toBe(false);
    expect(boardGameCounts().board_games).toBe(0);
  });
});

describe('the two tables keyed on a person', () => {
  // ⚠️ THE LIVE COLLECTION'S ACTUAL SHAPE, as of the absorb: several plays and ZERO
  // participant rows. Every play in the source arrived through the anonymous landing, which
  // posts no participants, so `play_players` is empty while `plays` is not.
  //
  // The tempting repair is to give each play the people who "must" have been there — from the
  // known-how table, from a group roster, from the last play. Every one of those INVENTS a
  // fact. A play may renew a known-how claim and must never create one, and a claim attached
  // to the wrong person appears on no screen beside a name, so nobody would ever catch it.
  //
  // This test pins the empty table as the CORRECT result. It fails if some later change
  // decides an empty participant list is a gap worth filling.
  it('carries a play with NOBODY at the table across as exactly that', () => {
    const source = new DatabaseSync(SOURCE);
    source.exec("DELETE FROM play_players");
    source.exec(
      "INSERT INTO plays (id, game_id, played_at, notes) VALUES ('play-3', 'tidewright', '2026-01-05T20:00:00.000Z', NULL)",
    );
    source.close();

    const result = importBoardGames({ force: true });
    expect(result.imported).toBe(true);

    // Three plays in, three plays out — and not one participant row invented for any of them.
    expect(boardGameCounts().board_game_plays).toBe(3);
    expect(boardGameCounts().board_game_play_people).toBe(0);
    for (const play of listBoardGamePlays()) expect(play.playerIds).toEqual([]);

    // And the known-how table is untouched by all of it: it still holds exactly the claims the
    // source stated, and gained nothing from three plays with no people on them.
    expect(listBoardGameKnownHow()).toHaveLength(3);
  });

  it('holds the SOURCE app’s player ids until the gated people import re-keys them', () => {
    importBoardGames();
    expect(listBoardGameKnownHow().map((row) => row.playerId).sort()).toEqual([
      'player-ada',
      'player-ada',
      'player-grace',
    ]);
    expect(listBoardGamePlays()[0]?.playerIds).toEqual([]);
    // Every one of them is unresolved, and that is the expected state before the mapping is
    // confirmed — not a fault.
    expect(unresolvedPersonIds()).toEqual(['player-ada', 'player-grace']);
  });

  it('re-keys onto a person and then resolves cleanly', () => {
    importBoardGames();
    upsertPerson({
      accounts: {},
      birthYear: null,
      createdAt: NOW,
      displayName: 'Ada',
      id: 'ada',
      isBeginner: false,
      maxWeight: null,
      position: 0,
      source: 'board-game-picker',
      sourceId: 'player-ada',
    });
    upsertPerson({
      accounts: {},
      birthYear: null,
      createdAt: NOW,
      displayName: 'Grace',
      id: 'grace',
      isBeginner: false,
      maxWeight: null,
      position: 1,
      source: 'board-game-picker',
      sourceId: 'player-grace',
    });

    expect(rekeyBoardGamePerson('player-ada', 'ada')).toBe(3);
    expect(rekeyBoardGamePerson('player-grace', 'grace')).toBe(1);
    expect(unresolvedPersonIds()).toEqual([]);
    // Nothing was lost on the way: three claims in, three claims out.
    expect(listBoardGameKnownHow().length).toBe(3);
    expect(listBoardGamePlays().find((play) => play.id === 'play-1')?.playerIds).toEqual(['ada']);
  });

  it('writes the person id straight away when the people import ran FIRST', () => {
    upsertPerson({
      accounts: {},
      birthYear: null,
      createdAt: NOW,
      displayName: 'Ada',
      id: 'ada',
      isBeginner: false,
      maxWeight: null,
      position: 0,
      source: 'board-game-picker',
      sourceId: 'player-ada',
    });
    importBoardGames();
    expect(listBoardGameKnownHow().filter((row) => row.playerId === 'ada').length).toBe(2);
    expect(unresolvedPersonIds()).toEqual(['player-grace']);
  });

  it('keeps the FRESHER claim when two source players become one human', () => {
    importBoardGames();
    // Both source players know the same game, with different timestamps. A play may RENEW a
    // claim and must never invent one, so the merge must not make a claim look older.
    expect(rekeyBoardGamePerson('player-ada', 'merged')).toBe(3);
    expect(rekeyBoardGamePerson('player-grace', 'merged')).toBe(1);
    const claim = listBoardGameKnownHow().find((row) => row.gameId === 'quarry-duel');
    expect(claim?.confirmedAt).toBe('2026-01-04T20:00:00.000Z');
  });
});
