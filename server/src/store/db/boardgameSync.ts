// A SYNC IS AN IMPORT PLUS ONE EXTRA QUESTION: what about the titles that are in here but are
// NOT in the collection any more?
//
// The answer is never a DELETE. A title carries the owner's tags, categories, rulebook links
// and play history, and the upstream knows about none of that — so a title that leaves the
// collection is marked REMOVED (the same state the Remove control writes), keeps every row it
// owns, and is one tap from coming back.
//
// ── ⚠️ `is_excluded_source` IS THE WHOLE POINT, AND IT FAILS SILENTLY ────────────────────
//
// The subtle part is WHOSE removal it is. If a sync removed a title and a human put it back on
// purpose, the next sync must not remove it again — that is a screen that fights you, and it is
// the reason the column exists:
//
//   `'sync'`   this code removed it. This code may un-remove it when the title reappears.
//   `'owner'`  a human decided. NOTHING AUTOMATED TOUCHES IT, in either direction.
//
// Merge the two and the next sync silently re-offers every title somebody took off the shelf by
// hand. `schema.sql` calls this the column the whole migration was shaped around; this file is
// what it was shaped around FOR.
import { importBoardGameRows, type ImportStats, type SourceRow } from './boardgameImport.js';
import { bookOfRecord, prepareChecked } from './open.js';
import type { SqliteDatabase } from '../sqlite.js';

export interface SyncReport {
  stats: ImportStats;
  /** Titles marked removed because they left the collection. */
  removed: string[];
  /** Sync-removed titles that came back and were restored. */
  restored: string[];
  /**
   * Gone upstream, but somebody had already made a call on them. Reported, and left exactly as
   * they are.
   */
  leftAlone: string[];
}

interface GameRow {
  id: string;
  name: string;
  bgg_id: string | null;
  is_excluded: number | null;
  is_excluded_source: string | null;
}

const setSyncExclusion = (db: SqliteDatabase, gameId: string, isExcluded: boolean): void => {
  prepareChecked(
    db,
    `INSERT INTO board_game_overrides (game_id, is_excluded, is_excluded_source, updated_at)
     VALUES (:game_id, :is_excluded, 'sync', :now)
     ON CONFLICT(game_id) DO UPDATE SET
       is_excluded = excluded.is_excluded,
       is_excluded_source = 'sync',
       updated_at = excluded.updated_at`,
  ).run({
    // SQLite has no boolean and both drivers REJECT one, so the 1/0 is written here.
    game_id: gameId,
    is_excluded: isExcluded ? 1 : 0,
    now: new Date().toISOString(),
  });
};

/**
 * Apply already-fetched rows. Split out from the fetch so the reconciliation is testable
 * without a network — which is the half that can lose data.
 */
export function applyBoardGameSync(
  rows: SourceRow[],
  db: SqliteDatabase = bookOfRecord(),
): SyncReport {
  const stats = importBoardGameRows(rows, db);

  const ownedBggIds = new Set(
    rows.map((row) => row.bggId).filter((bggId): bggId is number => bggId !== null),
  );

  const report: SyncReport = { leftAlone: [], removed: [], restored: [], stats };

  const games = prepareChecked<GameRow>(
    db,
    `SELECT g.id, g.name, g.bgg_id, o.is_excluded, o.is_excluded_source
       FROM board_games g
       LEFT JOIN board_game_overrides o ON o.game_id = g.id`,
  ).all({});

  const boxIds = prepareChecked<{ bgg_id: string | null }>(
    db,
    'SELECT bgg_id FROM board_game_boxes WHERE game_id = :game_id AND bgg_id IS NOT NULL',
  );

  /**
   * Every upstream id this title is known by — its own plus its boxes'. A merged title has one
   * id at the title level and many underneath, and it is still owned if ANY of them is.
   */
  const ownedByAnyBox = (game: GameRow): boolean => {
    const own = game.bgg_id === null ? null : Number(game.bgg_id);
    if (own !== null && Number.isFinite(own) && ownedBggIds.has(own)) return true;
    return boxIds
      .all({ game_id: game.id })
      .map((row) => Number(row.bgg_id))
      .some((bggId) => Number.isFinite(bggId) && ownedBggIds.has(bggId));
  };

  for (const game of games) {
    // A title with no upstream id at any level was never going to appear in this collection —
    // typed in by hand, or a promo that is not listed anywhere. It is not "missing", and a sync
    // must not touch it.
    const hasAnyBoxId = boxIds.all({ game_id: game.id }).length > 0;
    if (game.bgg_id === null && !hasAnyBoxId) continue;

    const isOwned = ownedByAnyBox(game);
    const isExcluded = game.is_excluded === 1;
    const isOwnersCall = game.is_excluded_source === 'owner';

    if (!isOwned && !isExcluded) {
      if (isOwnersCall) {
        // Explicitly put back by a human; it is gone upstream and on the shelf as far as they
        // are concerned. Say so, change nothing.
        report.leftAlone.push(game.name);
      } else {
        setSyncExclusion(db, game.id, true);
        report.removed.push(game.name);
      }
      continue;
    }

    // Back in the collection, and it was this code that took it out. Put it back — a re-bought
    // title should not need a tap.
    if (isOwned && isExcluded && game.is_excluded_source === 'sync') {
      setSyncExclusion(db, game.id, false);
      report.restored.push(game.name);
    }
  }

  return report;
}

/**
 * Replace every DERIVED link of one kind for one title, leaving the owner's alone.
 *
 * An empty `links` is a meaningful call and not a no-op: it is how a linker says "there is no
 * teach video for this any more", and without it a stale link outlives the thing it pointed at.
 *
 * `source = 'owner'` rows are never touched. Somebody typed those.
 */
export function replaceDerivedLinks(
  gameId: string,
  kind: 'rulebook' | 'howToPlay' | 'reference',
  links: readonly { label: string; url: string }[],
  db: SqliteDatabase = bookOfRecord(),
): void {
  db.withTransaction(() => {
    prepareChecked(
      db,
      `DELETE FROM board_game_links
        WHERE game_id = :game_id AND kind = :kind AND source = 'derived'`,
    ).run({ game_id: gameId, kind });

    const insert = prepareChecked(
      db,
      `INSERT INTO board_game_links (id, game_id, kind, label, url, source, created_at)
       VALUES (:id, :game_id, :kind, :label, :url, 'derived', :now)
       ON CONFLICT (game_id, url) DO NOTHING`,
    );
    const now = new Date().toISOString();
    links.forEach((link, index) => {
      insert.run({
        game_id: gameId,
        id: `${gameId}--${kind}--${index}`,
        kind,
        label: link.label,
        now,
        url: link.url,
      });
    });
  });
}
