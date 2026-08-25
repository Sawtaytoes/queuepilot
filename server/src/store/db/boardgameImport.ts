// THE COLLECTION WRITE PATH — the first thing in this app that WRITES the twelve tables.
//
// ⚠️ READ `store/migrate/boardgames.ts`'s header first. This file is the reason the absorb is
// now a one-way door: while the source file was still an input, every row written here was
// erased by the next start whose fingerprint had moved. WP-4d landed both halves in one change,
// and they must never be separated again.
//
// ── What an import is allowed to touch, and what it must never ───────────────────────────
//
// An import fills the IMPORTED layer and nothing else. `board_game_overrides` is the owner's
// layer, merged on read, and no statement in this file writes it except `setSyncExclusion` —
// which writes `is_excluded_source = 'sync'` and is fenced off from `'owner'` rows by the
// caller. Three columns are deliberately ABSENT from the upsert's SET list:
//
//   `interaction_types`  may be a tag a human applied.
//   `categories`         filled by the enrichment pass, from data no collection export carries.
//   `publishers`         same.
//
// A re-import that blanked any of them would look like a successful sync and quietly cost the
// collection its facets.
//
// ── ⚠️ EVERY WRITE GOES THROUGH `prepareChecked` (WP-4a difference #6) ───────────────────
//
// node:sqlite binds NULL for a named parameter the caller FORGOT, where better-sqlite3 threw.
// This file is four hand-written column lists over twenty-odd columns — exactly the shape of
// write that drops one — and the drop would be silent: a game's weight, its player counts, its
// external listing, all quietly NULL, and the picker simply stops offering it. An UNKNOWN key
// still throws, so a typo is caught either way. It is the OMISSION this closes, and it is why
// there is no bare `db.prepare` for a write anywhere below.
//
// ── `bgg_id` is TEXT here and a number in the algorithm ──────────────────────────────────
//
// `board_games.bgg_id` and `board_game_boxes.bgg_id` are TEXT columns (see `schema.sql`), and
// the absorbed engine speaks `number | null`. `asBggText` is the ONE place the conversion
// happens on the way in, the way `toBggId` is the one place on the way out. A `NaN` written as
// text would compare false against everything and be invisible.
import type { InteractionType } from '../../boardgames/types.js';
import type { SourceRow } from '../../boardgames/import/bgg.js';
import {
  type GroupingReview,
  type GroupingRules,
  groupBoxes,
  normalize,
  slugify,
} from '../../boardgames/import/grouping.js';
import { loadGroupingRules } from './boardgameRules.js';
import { bookOfRecord, prepareChecked } from './open.js';
import type { SqliteDatabase } from '../sqlite.js';

export interface ImportStats {
  rowsRead: number;
  rowsOwned: number;
  games: number;
  boxes: number;
  reviews: GroupingReview[];
  /** Titles with no complexity number — they dodge every weight filter. */
  gamesWithoutWeight: number;
  /** Titles with no poll data — the box's own claim is all there is. */
  gamesWithoutPlayerCountVotes: number;
  /** Interaction type is a guess for all of these. */
  gamesWithUntaggedInteraction: number;
}

// `SourceRow` is declared ONCE, in `boardgames/import/bgg.ts`, and imported here as a TYPE so
// nothing in the store layer's runtime graph reaches the fetch module. Two copies of this shape
// would drift a field at a time, and a field that drifts is a column that silently stops being
// written.
export type { SourceRow };

/** A listing id as the TEXT column holds it. Non-finite becomes NULL, never the string `NaN`. */
export const asBggText = (value: number | null | undefined): string | null =>
  value == null || !Number.isFinite(value) ? null : String(Math.trunc(value));

const parseStringList = (json: string | null): string[] => {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
};

/**
 * A PLACEHOLDER, and named so it cannot be mistaken for the real thing.
 *
 * A collection export carries no mechanics and no categories, so "co-op / versus / teams"
 * cannot be worked out from it. Everything untagged becomes `['competitive']` with
 * `interaction_types_source = 'derived'`, and the screen paints that as a GUESS rather than as
 * a fact.
 *
 * ⚠️ `boardgames/enrich/geekdo.ts` exports a `deriveInteractionTypes` that is the REAL
 * derivation, off an upstream item's mechanics. This one is what stands in until that pass
 * runs. Two different answers to one question, so they do not share a name.
 */
const guessInteractionTypes = (row: SourceRow | undefined): InteractionType[] =>
  row?.maxPlayers === 1 ? ['solo'] : ['competitive'];

const merge = (rows: SourceRow[]) => {
  const numbers = (pick: (row: SourceRow) => number | null) =>
    rows.map(pick).filter((value): value is number => value !== null);

  const mins = numbers((row) => row.minPlayers);
  const maxes = numbers((row) => row.maxPlayers);
  const weights = numbers((row) => row.weight);
  const ratings = numbers((row) => row.rating);
  const minTimes = numbers((row) => row.minPlaytime);
  const maxTimes = numbers((row) => row.maxPlaytime);
  const ages = numbers((row) => row.minAge);
  const years = numbers((row) => row.yearPublished);

  const average = (values: number[]) =>
    values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;

  return {
    // A title's range is the UNION of its boxes' ranges: a combined big box plays more players
    // than any one season of it does alone.
    bestWith: [...new Set(rows.flatMap((row) => row.bestWith))].sort((a, b) => a - b),
    maxPlayers: maxes.length > 0 ? Math.max(...maxes) : 1,
    maxPlaytime: maxTimes.length > 0 ? Math.max(...maxTimes) : null,
    // The strictest age any box claims — the safe direction when the question is "can the kid
    // play this".
    minAge: ages.length > 0 ? Math.max(...ages) : null,
    minPlayers: mins.length > 0 ? Math.min(...mins) : 1,
    minPlaytime: minTimes.length > 0 ? Math.min(...minTimes) : null,
    rating: average(ratings),
    recommendedWith: [...new Set(rows.flatMap((row) => row.recommendedWith))].sort(
      (a, b) => a - b,
    ),
    weight: average(weights),
    yearPublished: years.length > 0 ? Math.min(...years) : null,
  };
};

/**
 * Write already-parsed rows into the book of record.
 *
 * Split out so the BGG sync and a CSV import reach the SAME grouping and the SAME write path.
 * Where a row came from must not change how boxes collapse into titles or what an import is
 * allowed to overwrite, and the only way to guarantee that is for there to be one of these.
 */
export function importBoardGameRows(
  rows: SourceRow[],
  db: SqliteDatabase = bookOfRecord(),
  rules: GroupingRules = loadGroupingRules(db),
): ImportStats {
  const grouping = groupBoxes(
    rows.map((row) => ({ bggId: row.bggId, kind: row.kind, name: row.name })),
    rules,
  );

  /** Box name → every source row with that name. A duplicate is a second physical copy. */
  const rowsByName = new Map<string, SourceRow[]>();
  for (const row of rows) {
    rowsByName.set(row.name, [...(rowsByName.get(row.name) ?? []), row]);
  }

  const now = new Date().toISOString();

  const upsertGame = prepareChecked(
    db,
    `INSERT INTO board_games (
       id, name, min_players, max_players, best_with, recommended_with, weight,
       min_playtime, max_playtime, min_age, interaction_types, interaction_types_source,
       categories, publishers, year_published, bgg_id, rating, source, created_at, updated_at
     ) VALUES (
       :id, :name, :min_players, :max_players, :best_with, :recommended_with, :weight,
       :min_playtime, :max_playtime, :min_age, :interaction_types, 'derived',
       '[]', :publishers, :year_published, :bgg_id, :rating, 'import', :now, :now
     )
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       min_players = excluded.min_players,
       max_players = excluded.max_players,
       best_with = excluded.best_with,
       recommended_with = excluded.recommended_with,
       weight = excluded.weight,
       min_playtime = excluded.min_playtime,
       max_playtime = excluded.max_playtime,
       min_age = excluded.min_age,
       year_published = excluded.year_published,
       bgg_id = excluded.bgg_id,
       rating = excluded.rating,
       updated_at = excluded.updated_at`,
    // interaction_types, categories and publishers are NOT in the SET list on purpose — see
    // the file header. A re-import must not blank any of the three.
  );

  const deleteImportedBoxes = prepareChecked(
    db,
    'DELETE FROM board_game_boxes WHERE game_id = :game_id',
  );

  const insertBox = prepareChecked(
    db,
    `INSERT INTO board_game_boxes (
       id, game_id, label, kind, bgg_id, homebox_entity_id, location_text, image_path,
       version_nickname, version_year, version_languages, created_at
     ) VALUES (
       :id, :game_id, :label, :kind, :bgg_id, :homebox_entity_id, :location_text, :image_path,
       :version_nickname, :version_year, :version_languages, :now
     )`,
  );

  /**
   * What a box knows that no import can tell it: its cached art, where it physically lives, and
   * its inventory id.
   *
   * Boxes are deleted and rebuilt per title, and these three came from the enrichment pass —
   * never from an upstream row. Writing NULL over them made every import cost the whole
   * collection's box art until somebody re-ran the enrichment, which was survivable while
   * importing was a rare command and is not now that it is a scheduled job. Carried across by
   * LABEL, which is what identifies a box.
   */
  const boxKeepsakes = prepareChecked<{
    label: string;
    homebox_entity_id: string | null;
    location_text: string | null;
    image_path: string | null;
    version_nickname: string | null;
    version_year: number | null;
    version_languages: string | null;
  }>(
    db,
    `SELECT label, homebox_entity_id, location_text, image_path, version_nickname,
            version_year, version_languages
       FROM board_game_boxes WHERE game_id = :game_id`,
  );

  /**
   * Drop only the UNANSWERED prompts, and only for box labels THIS import actually saw.
   *
   * Scoped two ways on purpose. An answered ruling is the owner's and an import is never
   * allowed to take one back; and the re-insert below only covers rows this run produced, so a
   * bare `DELETE` would wipe every pending prompt in the collection and regenerate a handful.
   */
  const clearReviews = db.prepare(
    `DELETE FROM board_game_grouping_reviews
      WHERE reviewed_at IS NULL AND box_label IN (SELECT value FROM json_each(?))`,
  );

  const insertReview = prepareChecked(
    db,
    `INSERT INTO board_game_grouping_reviews
       (box_label, game_id, parent_game_id, status, reason, reviewed_at, source)
     VALUES (:box_label, :game_id, :parent_game_id, :status, :reason, NULL, 'owner')
     ON CONFLICT(box_label) DO NOTHING`,
  );

  const stats: ImportStats = {
    boxes: 0,
    games: grouping.games.length,
    gamesWithoutPlayerCountVotes: 0,
    gamesWithoutWeight: 0,
    gamesWithUntaggedInteraction: 0,
    reviews: grouping.reviews,
    rowsOwned: rows.length,
    rowsRead: rows.length,
  };

  // Every box label this run carried, answered or not — that is the scope it is entitled to
  // clear.
  const importedBoxLabels = [...new Set(grouping.games.flatMap((game) => game.boxNames))];

  db.withTransaction(() => {
    clearReviews.run(JSON.stringify(importedBoxLabels));

    for (const game of grouping.games) {
      const gameRows = game.boxNames.flatMap((name) => rowsByName.get(name) ?? []);
      const standaloneRows = gameRows.filter((row) => row.kind === 'standalone');
      // A title built purely out of "expansion" rows still needs numbers, so fall back to all
      // of them rather than merging an empty list into 1–1 players.
      const statRows = standaloneRows.length > 0 ? standaloneRows : gameRows;
      const merged = merge(statRows);
      const interactionTypes = guessInteractionTypes(statRows[0] ?? gameRows[0]);

      upsertGame.run({
        best_with: JSON.stringify(merged.bestWith),
        bgg_id: asBggText(
          game.listingBggId ??
            statRows.find((row) => normalize(row.name) === normalize(game.name))?.bggId ??
            statRows[0]?.bggId ??
            null,
        ),
        id: game.id,
        interaction_types: JSON.stringify(interactionTypes),
        max_players: merged.maxPlayers,
        max_playtime: merged.maxPlaytime,
        min_age: merged.minAge,
        min_players: merged.minPlayers,
        min_playtime: merged.minPlaytime,
        name: game.name,
        now,
        // A row names the publisher per BOX; a title takes the UNION, which is right for a
        // franchise that changed hands mid-run.
        publishers: JSON.stringify([...new Set(gameRows.flatMap((row) => row.publishers))]),
        rating: merged.rating,
        recommended_with: JSON.stringify(merged.recommendedWith),
        weight: merged.weight,
        year_published: merged.yearPublished,
      });

      const keepsakes = new Map(
        boxKeepsakes.all({ game_id: game.id }).map((box) => [box.label, box]),
      );

      deleteImportedBoxes.run({ game_id: game.id });

      // `boxNames` lists a title once per physical copy and `rowsByName` already returns every
      // copy — so iterate the DISTINCT titles, or each copy is inserted copies-many times and
      // collides on its own id.
      const usedBoxIds = new Set<string>();

      for (const boxName of new Set(game.boxNames)) {
        const boxRows = rowsByName.get(boxName) ?? [];
        boxRows.forEach((row, copyIndex) => {
          // Two titles inside one game can still slugify identically — a symbol was all that
          // separated them — so the id is de-duplicated here rather than trusting the slug.
          let id = `${game.id}--${slugify(boxName)}${copyIndex > 0 ? `--${copyIndex + 1}` : ''}`;
          let suffix = 2;
          while (usedBoxIds.has(id)) {
            id = `${game.id}--${slugify(boxName)}--dup${suffix}`;
            suffix += 1;
          }
          usedBoxIds.add(id);

          const kept = keepsakes.get(boxName);

          insertBox.run({
            bgg_id: asBggText(row.bggId),
            game_id: game.id,
            homebox_entity_id: kept?.homebox_entity_id ?? null,
            id,
            image_path: kept?.image_path ?? null,
            kind: row.kind,
            label: boxName,
            location_text: kept?.location_text ?? null,
            now,
            version_languages: JSON.stringify(
              row.versionLanguages.length > 0
                ? row.versionLanguages
                : parseStringList(kept?.version_languages ?? null),
            ),
            version_nickname: row.versionNickname ?? kept?.version_nickname ?? null,
            version_year: row.versionYear ?? kept?.version_year ?? null,
          });
          stats.boxes += 1;
        });
      }

      if (merged.weight === null) stats.gamesWithoutWeight += 1;
      if (merged.bestWith.length === 0 && merged.recommendedWith.length === 0) {
        stats.gamesWithoutPlayerCountVotes += 1;
      }
      if (interactionTypes.includes('competitive')) stats.gamesWithUntaggedInteraction += 1;
    }

    for (const review of grouping.reviews) {
      insertReview.run({
        box_label: review.boxName,
        game_id: review.gameId,
        parent_game_id: review.parentGameId,
        reason: review.reason,
        status: review.status,
      });
    }

    // A merge moves boxes onto the surviving title. The next import recreates them there but
    // would leave the old title's copy behind unless every box whose label this run assigned
    // somewhere else is dropped.
    const assignedElsewhere = prepareChecked(
      db,
      'DELETE FROM board_game_boxes WHERE label = :label AND game_id != :game_id',
    );
    for (const label of importedBoxLabels) {
      const gameId = grouping.assignments.get(label);
      if (gameId) assignedElsewhere.run({ game_id: gameId, label });
    }

    // Only `source = 'import'`. A title somebody created by hand survives having no boxes.
    db.prepare(
      `DELETE FROM board_games
        WHERE source = 'import'
          AND id NOT IN (SELECT DISTINCT game_id FROM board_game_boxes)`,
    ).run();
  });

  // NOTE: an import deliberately does NOT seed ways to play out of the expansion boxes. It used
  // to, and the answer was that most expansions are not a choice anybody makes at the table —
  // they are simply in the box — so listing every one of them as a way to play is noise on
  // titles that never wanted the feature. They are added per title, from the Collection screen.

  return stats;
}
