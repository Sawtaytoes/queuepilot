// THE ENRICHMENT WRITE PATH — what a collection export cannot carry.
//
// A collection row gives a title, a player range and a weight. It does not give mechanics,
// categories or publishers, and "co-op / versus / teams" is derived from mechanics — so without
// this pass every title in the collection reads `['competitive']` with
// `interaction_types_source = 'derived'`, which is a guess the screen has to paint as a guess.
//
// ⚠️ THIS ONLY EVER WRITES THE IMPORTED LAYER. A tag somebody applied lives in
// `board_game_overrides` and is merged on read, so nothing here can walk over it. That is not a
// convention, it is which table the statements below name.
//
// `COALESCE(min_age, :min_age)` and its two siblings FILL A HOLE and never correct a value: the
// collection export is the better source when it has an answer, and the upstream item is only
// consulted where it had none.
import { prepareChecked, bookOfRecord } from './open.js';
import type { SqliteDatabase } from '../sqlite.js';
import { asBggText } from './boardgameImport.js';
import type { InteractionType } from '../../boardgames/types.js';

/** One title, as the enrichment pass needs to see it. */
export interface EnrichableGame {
  id: string;
  name: string;
  bggId: number;
  minAge: number | null;
  minPlaytime: number | null;
  maxPlaytime: number | null;
}

/** Every title carrying an upstream id, which is every title the pass can do anything with. */
export const listEnrichableGames = (db: SqliteDatabase = bookOfRecord()): EnrichableGame[] =>
  prepareChecked<{
    id: string;
    name: string;
    bgg_id: string;
    min_age: number | null;
    min_playtime: number | null;
    max_playtime: number | null;
  }>(
    db,
    `SELECT id, name, bgg_id, min_age, min_playtime, max_playtime
       FROM board_games
      WHERE bgg_id IS NOT NULL
      ORDER BY name COLLATE NOCASE`,
  )
    .all({})
    .map((row) => ({
      bggId: Number(row.bgg_id),
      id: row.id,
      maxPlaytime: row.max_playtime,
      minAge: row.min_age,
      minPlaytime: row.min_playtime,
      name: row.name,
    }))
    // A `bgg_id` that is text but not a number cannot be fetched. Dropped rather than sent as
    // `NaN`, which the upstream answers with a 404 once per run forever.
    .filter((game) => Number.isFinite(game.bggId));

/** The version hint for a title: the standalone box first, then by label. */
export const editionHintFor = (
  gameId: string,
  db: SqliteDatabase = bookOfRecord(),
): { nickname: string | null; year: number | null; languages: string[] } => {
  const row = prepareChecked<{
    version_nickname: string | null;
    version_year: number | null;
    version_languages: string | null;
  }>(
    db,
    `SELECT version_nickname, version_year, version_languages
       FROM board_game_boxes
      WHERE game_id = :game_id
      ORDER BY CASE kind WHEN 'standalone' THEN 0 ELSE 1 END, label COLLATE NOCASE`,
  ).get({ game_id: gameId });

  let languages: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row?.version_languages ?? '[]');
    if (Array.isArray(parsed)) {
      languages = parsed.filter((value): value is string => typeof value === 'string');
    }
  } catch {
    languages = [];
  }

  return { languages, nickname: row?.version_nickname ?? null, year: row?.version_year ?? null };
};

/** Every upstream id the title's boxes carry. Used to tell an owned box from a family listing. */
export const boxBggIdsFor = (gameId: string, db: SqliteDatabase = bookOfRecord()): Set<number> =>
  new Set(
    prepareChecked<{ bgg_id: string | null }>(
      db,
      'SELECT bgg_id FROM board_game_boxes WHERE game_id = :game_id',
    )
      .all({ game_id: gameId })
      .map((row) => Number(row.bgg_id))
      .filter((bggId) => Number.isFinite(bggId)),
  );

export interface EnrichmentWrite {
  gameId: string;
  /** The upstream's own auto tags: a palette, not the truth. */
  categories: readonly string[];
  interactionTypes: readonly InteractionType[];
  publishers: readonly string[];
  minAge: number | null;
  minPlaytime: number | null;
  maxPlaytime: number | null;
}

/** Fold one upstream item into the imported layer. */
export function writeEnrichment(
  write: EnrichmentWrite,
  db: SqliteDatabase = bookOfRecord(),
): void {
  prepareChecked(
    db,
    `UPDATE board_games SET
       categories = :categories,
       interaction_types = :interaction_types,
       interaction_types_source = 'derived',
       publishers = :publishers,
       min_age = COALESCE(min_age, :min_age),
       min_playtime = COALESCE(min_playtime, :min_playtime),
       max_playtime = COALESCE(max_playtime, :max_playtime),
       updated_at = :now
     WHERE id = :id`,
  ).run({
    categories: JSON.stringify([...write.categories]),
    id: write.gameId,
    interaction_types: JSON.stringify([...write.interactionTypes]),
    max_playtime: write.maxPlaytime,
    min_age: write.minAge,
    min_playtime: write.minPlaytime,
    now: new Date().toISOString(),
    publishers: JSON.stringify([...write.publishers]),
  });
}

/**
 * Point a title and its boxes at a stored cover.
 *
 * The box update is deliberately loose on `bgg_id`: a box with no id of its own, or a title
 * whose id no box carries, still gets the art. An owner-picked cover lives in
 * `board_game_overrides.image_path` and wins on read, so this can never replace one.
 */
export function writeCoverPath(
  gameId: string,
  bggId: number | null,
  imagePath: string,
  db: SqliteDatabase = bookOfRecord(),
): void {
  db.withTransaction(() => {
    prepareChecked(db, 'UPDATE board_games SET image_path = :image_path WHERE id = :id').run({
      id: gameId,
      image_path: imagePath,
    });
    prepareChecked(
      db,
      `UPDATE board_game_boxes SET image_path = :image_path
        WHERE game_id = :game_id
          AND (bgg_id = :bgg_id OR bgg_id IS NULL OR :bgg_id IS NULL)`,
    ).run({ bgg_id: asBggText(bggId), game_id: gameId, image_path: imagePath });
  });
}

/** Every title with an upstream id, for the linkers. */
export const listLinkableGames = (
  db: SqliteDatabase = bookOfRecord(),
): { id: string; name: string; bggId: number | null }[] =>
  prepareChecked<{ id: string; name: string; bgg_id: string | null }>(
    db,
    'SELECT id, name, bgg_id FROM board_games ORDER BY name COLLATE NOCASE',
  )
    .all({})
    .map((row) => ({
      bggId: row.bgg_id === null || !Number.isFinite(Number(row.bgg_id)) ? null : Number(row.bgg_id),
      id: row.id,
      name: row.name,
    }));

/** Every box label, so the rulebook matcher can try a box's own name as well as the title's. */
export const listBoxLabels = (
  db: SqliteDatabase = bookOfRecord(),
): { gameId: string; label: string }[] =>
  prepareChecked<{ game_id: string; label: string }>(
    db,
    'SELECT game_id, label FROM board_game_boxes ORDER BY label COLLATE NOCASE',
  )
    .all({})
    .map((row) => ({ gameId: row.game_id, label: row.label }));
