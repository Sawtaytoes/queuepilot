// The collection, as rows — the READ side of the twelve `board_game_*` tables.
//
// ── What this file is for, and what it is not ────────────────────────────────────────────
//
// WP-4b brought the schema and the data across. This is the layer that proves the data can
// answer the question the app actually asks: the three reads the board-game provider makes
// today over HTTP, answered from the book of record instead. WP-4e is what swaps the
// transport — `providers/board-game-picker.ts` does not change, and that is the proof the
// seam was right. Nothing here writes a collection row; the writers (the sync, the enrichment,
// the Collection screen) are WP-4d's, and until they land the source app is still the one
// editing this data.
//
// ── The three layers become one object here, and nowhere else ────────────────────────────
//
// A game on screen is the IMPORTED row, the owner's OVERRIDE on top of it, and the play count
// out of the log. `assembleGame()` is the only place in this app allowed to know they were
// ever separate — every caller gets a `Game` and cannot tell.
//
// ── `bgg_id` is TEXT in the schema and a number in the engine ────────────────────────────
//
// The column is TEXT because an external listing id is an identifier and is never added up
// (see `schema.sql`'s board-game header). The already-merged pick engine declares
// `Game.bggId: number | null`, because it was ported unchanged and its own types are not this
// package's to renegotiate. `toBggId()` below is the ONE place the two meet. A value that is
// not a finite number comes back `null` rather than `NaN` — `NaN` compares false against
// everything and would silently drop a game out of a filter nobody thought it was in.
//
// ── The engine says "player" and the store says "person" ─────────────────────────────────
//
// `boardgames/types.ts` was ported verbatim from an app whose vocabulary is `playerId`; this
// app settled on `person` in WP-3. The two are the same human. The mapping happens at this
// boundary and only here — renaming the engine's fields would be a change to a file whose
// whole claim is that it is a byte-comparable port.
import type {
  Box,
  FieldSource,
  Game,
  GameLink,
  GameLinkKind,
  GameModule,
  InteractionType,
  KnownGame,
  Play,
} from '../../boardgames/types.js';
import { bookOfRecord, prepareChecked } from './open.js';
import type { SqliteDatabase } from '../sqlite.js';

/** Every board-game table, in FOREIGN KEY order — parents before children. The migration
 * inserts in this order and deletes in reverse, and the counts proof walks it. */
export const BOARD_GAME_TABLES = [
  'board_games',
  'board_game_boxes',
  'board_game_overrides',
  'board_game_links',
  'board_game_modules',
  'board_game_categories',
  'board_game_category_members',
  'board_game_groupings',
  'board_game_grouping_reviews',
  'board_game_plays',
  'board_game_play_people',
  'board_game_known_how',
] as const;

export type BoardGameTable = (typeof BOARD_GAME_TABLES)[number];

/**
 * The COMPARISON FORM of a title: case-, punctuation- and dash-insensitive.
 *
 * Five lines of the grouping algorithm, here rather than in the importer because the store
 * needs it before WP-4d ports the rest. A collection export mixes `-`, `–` and `:` inside the
 * same franchise, so anything that treats those as meaningful mis-groups a shelf. Idempotent —
 * normalising an already-normalised title returns it unchanged — which is what lets a rule
 * stored in this form be compared against a raw label off a lid.
 *
 * Public, and it names nothing: the algorithm is this repo's, the answers it is fed are not.
 */
export const normalizeTitle = (name: string): string =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** The one place a TEXT listing id becomes the number the ported engine's types declare. */
export const toBggId = (value: string | null): number | null => {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** A JSON array column, as numbers. A malformed blob reads as empty rather than throwing — one
 * corrupt row must not take the whole collection down. */
const parseCounts = (json: string | null): number[] => {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((v): v is number => typeof v === 'number') : [];
  } catch {
    return [];
  }
};

/** The same, as strings. */
const parseStrings = (json: string | null): string[] => {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
};

const LINK_KINDS: readonly string[] = ['rulebook', 'howToPlay', 'reference'];

interface GameRow {
  id: string;
  name: string;
  min_players: number;
  max_players: number;
  best_with: string;
  recommended_with: string;
  weight: number | null;
  min_playtime: number | null;
  max_playtime: number | null;
  min_age: number | null;
  interaction_types: string;
  interaction_types_source: string;
  categories: string;
  publishers: string;
  year_published: number | null;
  bgg_id: string | null;
  rating: number | null;
  image_path: string | null;
  o_min_players: number | null;
  o_max_players: number | null;
  o_best_with: string | null;
  o_recommended_with: string | null;
  o_weight: number | null;
  o_min_age: number | null;
  o_interaction_types: string | null;
  o_is_excluded: number | null;
  o_notes: string | null;
  o_image_path: string | null;
  play_count: number;
}

interface BoxRow {
  id: string;
  game_id: string;
  label: string;
  kind: string;
  bgg_id: string | null;
  homebox_entity_id: string | null;
  location_text: string | null;
  image_path: string | null;
  version_nickname: string | null;
  version_year: number | null;
  version_languages: string;
}

interface LinkRow {
  id: string;
  game_id: string;
  kind: string;
  label: string;
  url: string;
  source: string;
}

interface ModuleRow {
  id: string;
  game_id: string;
  name: string;
  source: string;
  box_id: string | null;
}

const toBox = (row: BoxRow): Box => ({
  bggId: toBggId(row.bgg_id),
  gameId: row.game_id,
  homeboxEntityId: row.homebox_entity_id,
  id: row.id,
  imagePath: row.image_path,
  kind: row.kind === 'expansion' ? 'expansion' : 'standalone',
  label: row.label,
  locationText: row.location_text,
  versionLanguages: parseStrings(row.version_languages),
  versionNickname: row.version_nickname,
  versionYear: row.version_year,
});

const toLink = (row: LinkRow): GameLink => ({
  gameId: row.game_id,
  id: row.id,
  kind: (LINK_KINDS.includes(row.kind) ? row.kind : 'reference') as GameLinkKind,
  label: row.label,
  source: row.source === 'derived' ? 'derived' : 'owner',
  url: row.url,
});

const toModule = (row: ModuleRow): GameModule => ({
  boxId: row.box_id,
  gameId: row.game_id,
  id: row.id,
  name: row.name,
  source: row.source === 'derived' ? 'derived' : 'owner',
});

/**
 * The three layers, folded into one object.
 *
 * The override wins field by field where it is set, and `NULL` means "not overridden" rather
 * than "cleared" — which is why every one of these is `??` and not a truthiness test. A cover
 * falls back through owner → import → the first box that has art, and `imageSource` says which
 * of the three answered so a screen never presents a guess as a fact.
 */
const assembleGame = (
  row: GameRow,
  boxes: Box[],
  ownerCategories: string[],
  links: GameLink[],
  modules: GameModule[],
): Game => ({
  bestWith: row.o_best_with === null ? parseCounts(row.best_with) : parseCounts(row.o_best_with),
  bggId: toBggId(row.bgg_id),
  boxes,
  categories: parseStrings(row.categories),
  id: row.id,
  imagePath:
    row.o_image_path ?? row.image_path ?? boxes.find((box) => box.imagePath !== null)?.imagePath ?? null,
  imageSource: row.o_image_path
    ? 'owner'
    : row.image_path || boxes.some((box) => box.imagePath !== null)
      ? 'import'
      : null,
  interactionTypes: parseStrings(
    row.o_interaction_types ?? row.interaction_types,
  ) as InteractionType[],
  interactionTypesSource: (row.o_interaction_types === null
    ? row.interaction_types_source
    : 'owner') as FieldSource,
  isExcluded: row.o_is_excluded === 1,
  links,
  maxPlayers: row.o_max_players ?? row.max_players,
  maxPlaytime: row.max_playtime,
  minAge: row.o_min_age ?? row.min_age,
  minPlayers: row.o_min_players ?? row.min_players,
  minPlaytime: row.min_playtime,
  modules,
  name: row.name,
  notes: row.o_notes,
  ownerCategories,
  playCount: row.play_count,
  publishers: parseStrings(row.publishers),
  rating: row.rating,
  recommendedWith:
    row.o_recommended_with === null
      ? parseCounts(row.recommended_with)
      : parseCounts(row.o_recommended_with),
  weight: row.o_weight ?? row.weight,
  yearPublished: row.year_published,
});

const GAME_SELECT = `
  SELECT
    g.*,
    o.min_players       AS o_min_players,
    o.max_players       AS o_max_players,
    o.best_with         AS o_best_with,
    o.recommended_with  AS o_recommended_with,
    o.weight            AS o_weight,
    o.min_age           AS o_min_age,
    o.interaction_types AS o_interaction_types,
    o.is_excluded       AS o_is_excluded,
    o.notes             AS o_notes,
    o.image_path        AS o_image_path,
    (SELECT COUNT(*) FROM board_game_plays p WHERE p.game_id = g.id) AS play_count
  FROM board_games g
  LEFT JOIN board_game_overrides o ON o.game_id = g.id
`;

/**
 * The whole collection, by name.
 *
 * Five statements, not N + 1: the child rows are read in one query each and grouped in memory.
 * The orderings are part of the contract and not a nicety — the links come back rulebook,
 * then how-to-play, then everything else, so the buttons on a card never reorder themselves
 * between two games.
 */
export function listBoardGames(db: SqliteDatabase = bookOfRecord()): Game[] {
  const rows = prepareChecked<GameRow>(db, `${GAME_SELECT} ORDER BY g.name COLLATE NOCASE`).all();

  const boxesByGame = new Map<string, Box[]>();
  for (const row of prepareChecked<BoxRow>(
    db,
    'SELECT * FROM board_game_boxes ORDER BY label COLLATE NOCASE',
  ).all()) {
    const list = boxesByGame.get(row.game_id) ?? [];
    list.push(toBox(row));
    boxesByGame.set(row.game_id, list);
  }

  const categoriesByGame = new Map<string, string[]>();
  for (const row of prepareChecked<{ game_id: string; name: string }>(
    db,
    'SELECT game_id, name FROM board_game_category_members ORDER BY name COLLATE NOCASE',
  ).all()) {
    const list = categoriesByGame.get(row.game_id) ?? [];
    list.push(row.name);
    categoriesByGame.set(row.game_id, list);
  }

  const linksByGame = new Map<string, GameLink[]>();
  for (const row of prepareChecked<LinkRow>(
    db,
    `SELECT * FROM board_game_links
     ORDER BY CASE kind WHEN 'rulebook' THEN 0 WHEN 'howToPlay' THEN 1 ELSE 2 END,
              label COLLATE NOCASE`,
  ).all()) {
    const list = linksByGame.get(row.game_id) ?? [];
    list.push(toLink(row));
    linksByGame.set(row.game_id, list);
  }

  const modulesByGame = new Map<string, GameModule[]>();
  for (const row of prepareChecked<ModuleRow>(
    db,
    'SELECT * FROM board_game_modules ORDER BY name COLLATE NOCASE',
  ).all()) {
    const list = modulesByGame.get(row.game_id) ?? [];
    list.push(toModule(row));
    modulesByGame.set(row.game_id, list);
  }

  return rows.map((row) =>
    assembleGame(
      row,
      boxesByGame.get(row.id) ?? [],
      categoriesByGame.get(row.id) ?? [],
      linksByGame.get(row.id) ?? [],
      modulesByGame.get(row.id) ?? [],
    ),
  );
}

/** One title, or null. */
export const getBoardGame = (id: string, db: SqliteDatabase = bookOfRecord()): Game | null =>
  listBoardGames(db).find((game) => game.id === id) ?? null;

/**
 * The search behind the queue's "add a game" box, and it answers an EMPTY term with nothing.
 *
 * That is deliberate: this feeds a search box in a queue editor, and the entire shelf arriving
 * on the first keystroke-less render is not a useful default. Name, publisher and year are all
 * searched, because a publisher name should find its games.
 *
 * An excluded game is never offered. "Never offer this again" has to mean it in every app that
 * reads the collection, not only in the one where the switch is.
 */
export function searchBoardGames(
  games: readonly Game[],
  { categories = [], query = '' }: { categories?: readonly string[]; query?: string },
): Game[] {
  const term = query.trim().toLowerCase();
  if (term === '') return [];

  const wanted = new Set(
    categories.map((category) => category.trim()).filter((category) => category !== ''),
  );

  return games.filter((game) => {
    if (game.isExcluded) return false;
    if (wanted.size > 0 && !game.ownerCategories.some((category) => wanted.has(category))) {
      return false;
    }
    return (
      game.name.toLowerCase().includes(term) ||
      game.publishers.some((publisher) => publisher.toLowerCase().includes(term)) ||
      String(game.yearPublished ?? '').includes(term)
    );
  });
}

/** The owner's own category vocabulary, alphabetical. */
export const listBoardGameCategories = (db: SqliteDatabase = bookOfRecord()): string[] =>
  prepareChecked<{ name: string }>(
    db,
    'SELECT name FROM board_game_categories ORDER BY name COLLATE NOCASE',
  )
    .all()
    .map((row) => row.name);

/**
 * The play log, newest first, with whoever was at the table.
 *
 * ⚠️ `playerIds` here are `board_game_play_people.person_id`, which holds the SOURCE APP's
 * player ids until the gated people import re-keys them. See `unresolvedPersonIds()`.
 */
export function listBoardGamePlays(db: SqliteDatabase = bookOfRecord()): Play[] {
  const plays = prepareChecked<{
    id: string;
    game_id: string;
    played_at: string;
    notes: string | null;
  }>(db, 'SELECT * FROM board_game_plays ORDER BY played_at DESC').all();

  const peopleByPlay = new Map<string, string[]>();
  for (const row of prepareChecked<{ play_id: string; person_id: string }>(
    db,
    'SELECT play_id, person_id FROM board_game_play_people ORDER BY play_id, person_id',
  ).all()) {
    const list = peopleByPlay.get(row.play_id) ?? [];
    list.push(row.person_id);
    peopleByPlay.set(row.play_id, list);
  }

  return plays.map((play) => ({
    gameId: play.game_id,
    id: play.id,
    notes: play.notes,
    playedAt: play.played_at,
    playerIds: peopleByPlay.get(play.id) ?? [],
  }));
}

/** Who can start which game without the rulebook. Same id caveat as `listBoardGamePlays`. */
export const listBoardGameKnownHow = (db: SqliteDatabase = bookOfRecord()): KnownGame[] =>
  prepareChecked<{ person_id: string; game_id: string; confirmed_at: string }>(
    db,
    'SELECT person_id, game_id, confirmed_at FROM board_game_known_how ORDER BY person_id, game_id',
  )
    .all()
    .map((row) => ({
      confirmedAt: row.confirmed_at,
      gameId: row.game_id,
      playerId: row.person_id,
    }));

/**
 * Every `person_id` on the two people-keyed tables that does not resolve to a `people` row.
 *
 * REPORTS, never deletes — the same posture as `orphanGroupIds()`, and for a stronger reason
 * here. Until the owner confirms the people mapping these ids are ALL unresolved by design:
 * they are the source app's own player ids, held verbatim, waiting to be re-keyed by the same
 * confirmed apply that creates the people. An empty list after that apply is the check that it
 * finished; a non-empty one is a question, not corruption.
 */
export const unresolvedPersonIds = (db: SqliteDatabase = bookOfRecord()): string[] =>
  prepareChecked<{ person_id: string }>(
    db,
    `SELECT DISTINCT person_id FROM (
       SELECT person_id FROM board_game_known_how
       UNION SELECT person_id FROM board_game_play_people
     )
     WHERE person_id NOT IN (SELECT id FROM people)
     ORDER BY person_id`,
  )
    .all()
    .map((row) => row.person_id);

/**
 * Point every board-game row that names `fromId` at `toId` instead. Returns how many moved.
 *
 * Called from the people import, inside its transaction, once per confirmed person who carries
 * a source-app id. `UPDATE OR REPLACE` rather than `UPDATE`: both tables are keyed on the
 * person, so re-keying two source ids onto one human would otherwise hit the primary key. The
 * survivor is the row already under the new id, which is the right one — a claim the household
 * has already stated here outranks one being carried in.
 */
export function rekeyBoardGamePerson(
  fromId: string,
  toId: string,
  db: SqliteDatabase = bookOfRecord(),
): number {
  if (fromId === '' || toId === '' || fromId === toId) return 0;

  const known = prepareChecked(
    db,
    'UPDATE OR REPLACE board_game_known_how SET person_id = :to WHERE person_id = :from',
  ).run({ from: fromId, to: toId });

  const played = prepareChecked(
    db,
    'UPDATE OR REPLACE board_game_play_people SET person_id = :to WHERE person_id = :from',
  ).run({ from: fromId, to: toId });

  return known.changes + played.changes;
}

/** Row counts for all twelve tables — what a migration proves itself with, and what the deploy
 * check reads back out of the live file. */
export function boardGameCounts(db: SqliteDatabase = bookOfRecord()): Record<BoardGameTable, number> {
  const out = {} as Record<BoardGameTable, number>;
  for (const table of BOARD_GAME_TABLES) {
    // The table name is from the frozen list above, never from a caller — this is the one
    // place in the store that interpolates an identifier, and it can only interpolate one of
    // twelve literals.
    out[table] = prepareChecked<{ c: number }>(db, `SELECT COUNT(*) AS c FROM ${table}`).get()?.c ?? 0;
  }
  return out;
}
