// THE GROUPING RULES, READ BACK OUT OF THE ROWS THEY BECAME.
//
// `boardgames/import/grouping.ts` holds the algorithm and never the answers; this file is the
// other half. `board_game_groupings` carries both kinds of rule in one table, told apart by the
// CHECK constraint that exactly one of `box_label` / `prefix` is set:
//
//   `box_label` set   an OWNER MERGE, keyed on one physical box label. Applied first.
//   `prefix` set      a FAMILY RULE — "every box starting with this is one title." Ordered.
//
// `board_game_grouping_reviews` rows with `status = 'confirmedSeparate'` are the third input:
// titles somebody has looked at and confirmed really are their own game.
//
// ⚠️ ORDER IS A COLUMN, NOT AN ACCIDENT. The first matching prefix rule wins, so a more
// specific prefix has to come out of here above the general one it sits inside. `position` is
// what the seed file's own order was stored as. Sorting by anything else — name, rowid, id —
// silently changes which rule fires for a box that two rules match, and the symptom is a title
// quietly merging into the wrong one.
import { bookOfRecord, prepareChecked } from './open.js';
import type { SqliteDatabase } from '../sqlite.js';
import { toBggId } from './boardgames.js';
import type { GroupingRules, OwnerGrouping, PrefixGrouping } from '../../boardgames/import/grouping.js';

interface GroupingRow {
  box_label: string | null;
  prefix: string | null;
  except_contains: string | null;
  game_id: string;
  game_name: string;
  listing_bgg_id: string | null;
  is_game_from_expansions: number;
}

/**
 * Everything the collapse needs to know about one household's shelf.
 *
 * A store with no rules at all answers three empty collections, and the algorithm still groups
 * — see that file's header. So this never throws and never invents a default.
 */
export function loadGroupingRules(db: SqliteDatabase = bookOfRecord()): GroupingRules {
  const rows = prepareChecked<GroupingRow>(
    db,
    `SELECT box_label, prefix, except_contains, game_id, game_name, listing_bgg_id,
            is_game_from_expansions
       FROM board_game_groupings
      ORDER BY position, rowid`,
  ).all({});

  const owner: OwnerGrouping[] = [];
  const prefixes: PrefixGrouping[] = [];

  for (const row of rows) {
    if (row.box_label !== null) {
      owner.push({
        boxLabel: row.box_label,
        gameId: row.game_id,
        gameName: row.game_name,
        listingBggId: toBggId(row.listing_bgg_id),
      });
      continue;
    }
    if (row.prefix === null) continue; // the CHECK forbids it; a hand-edited file does not.
    prefixes.push({
      exceptContains: row.except_contains,
      gameId: row.game_id,
      gameName: row.game_name,
      isGameFromExpansions: row.is_game_from_expansions === 1,
      listingBggId: toBggId(row.listing_bgg_id),
      prefix: row.prefix,
    });
  }

  const confirmedSeparate = new Set(
    prepareChecked<{ box_label: string }>(
      db,
      `SELECT box_label FROM board_game_grouping_reviews WHERE status = 'confirmedSeparate'`,
    )
      .all({})
      .map((row) => row.box_label),
  );

  return { confirmedSeparate, owner, prefixes };
}
