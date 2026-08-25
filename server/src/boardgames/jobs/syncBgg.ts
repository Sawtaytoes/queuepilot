// PULL THE COLLECTION FROM THE UPSTREAM AND RECONCILE IT.
//
// The first of the four nightly steps, and the only one that can add or remove a title.
//
// ⚠️ IT NEVER DELETES. A title that leaves the collection is marked removed with
// `is_excluded_source = 'sync'`, keeps every row it owns, and is one tap from coming back —
// see `store/db/boardgameSync.ts`, which is where the rule that a sync may take back its own
// removal and never the owner's actually lives.
//
// Not configured is not a failure. No token means the upstream cannot be asked, which is the
// normal state of a container nobody has given credentials to.
import { bggConfigFromEnv, fetchOwnedRows } from '../import/bgg.js';
import { applyBoardGameSync } from '../../store/db/boardgameSync.js';
import { failed, skipped, type CollectionJobResult, type OnProgress } from './types.js';

export async function runSyncBgg(onProgress: OnProgress = () => {}): Promise<CollectionJobResult> {
  const config = bggConfigFromEnv(process.env);
  if (config === null) {
    return skipped(
      'sync-bgg',
      'no BoardGameGeek credentials — set BOARD_GAME_GEEK_API_TOKEN and BGG_USERNAME to sync',
    );
  }

  try {
    onProgress('asking the upstream for the collection…');
    const rows = await fetchOwnedRows(config, onProgress);

    // A collection that comes back EMPTY is refused rather than applied. An upstream that
    // answers 200 with nothing in it — a rate limit, a renamed account, a bad token that still
    // authenticates — would otherwise mark every title in the collection removed in one run.
    // The removals are recoverable, but the owner would have to undo hundreds of them by hand.
    if (rows.length === 0) {
      return {
        isOk: false,
        isSkipped: false,
        name: 'sync-bgg',
        summary:
          'the upstream returned an EMPTY collection — refusing to mark every title removed. ' +
          'Nothing was written.',
      };
    }

    const report = applyBoardGameSync(rows);
    return {
      counts: {
        boxes: report.stats.boxes,
        games: report.stats.games,
        leftAlone: report.leftAlone.length,
        removed: report.removed.length,
        restored: report.restored.length,
        reviews: report.stats.reviews.length,
      },
      isOk: true,
      isSkipped: false,
      name: 'sync-bgg',
      summary:
        `${report.stats.games} title(s) in ${report.stats.boxes} box(es); ` +
        `${report.removed.length} removed, ${report.restored.length} restored, ` +
        `${report.leftAlone.length} left alone`,
    };
  } catch (error) {
    return failed('sync-bgg', error);
  }
}
