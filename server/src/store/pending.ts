// pending.yaml — the FILE behind the Pending screen's two decisions.
//
// Moved out of `pending.ts` verbatim: the state shape, the file header, and the read and write.
// What stayed in `pending.ts` is the whole SUBTRACTION — which libraries are in scope, what a
// queue or a pool already covers, how a collection lands beside its members.
//
// This is the one store here that is not a `Document` round-trip. `pending.yaml` is written
// whole each time, header and all, because nothing about it is hand-authored structure worth
// preserving: two lists and a number, and the header is a constant this file owns.
//
// It is NOT the derived cache. A dismissal is a decision, it is not recomputable from Plex, and
// it belongs in a file the owner can read and edit like every other decision this app stores
// (decision 2026-08-03-sqlite-is-a-derived-plex-cache-not-the-store).
import { promises as fsp } from 'node:fs';
import { dirname } from 'node:path';
import { parse, stringify } from 'yaml';

import { PENDING_PATH } from '../env.js';
import { errMessage, isNodeError } from '../errors.js';

/** Where the file is. Named `path` so no caller outside `store/` spells a `.yaml` constant. */
export const path = PENDING_PATH;

/** What `pending.yaml` holds. The only store interface whose shape is declared here. */
export interface PendingState {
  /** Epoch SECONDS, matching Plex's own `addedAt`. */
  seen_through: number;
  dismissed: string[];
  /**
   * Which library sections Pending draws from — an INCLUDE list, and `null` for "not
   * configured yet".
   *
   * Include and not exclude, because the owner's sentence is an include one:
   *
   * > "Pending is for new additions not in a queue, not watched, from specific libraries
   * > (not the inverse). So instead of exclude, just have it be include."
   *
   * The difference is what happens to a library nobody has thought about. Under an exclude
   * list a new Plex library silently joins the screen and has to be noticed and named to
   * get rid of; under an include list it stays out until someone asks for it. On a screen
   * whose whole job is subtraction, the second is the correct default direction.
   *
   * `null` rather than `[]`: an empty list is a real answer that means "no libraries",
   * which is a page the owner can choose and must not be handed by accident. Unconfigured
   * falls back to `defaultLibraries` instead.
   */
  libraries: number[] | null;
}

const HEADER = `# QueuePilot — what has arrived that nothing is going to play.
#
# seen_through  epoch seconds. Anything added at or before this is not "new" any more; the
#               "Mark all as seen" button moves it to now. One number, so clearing the list
#               costs one line rather than one line per item.
# dismissed     ratingKeys you said no to individually. Per-item on purpose: skipping ONE
#               film must not also hide everything added after it.
# libraries     WHICH library sections this screen draws from, by section id. An INCLUDE
#               list: a library that is not named here is not on the screen, and a new Plex
#               library stays out until someone asks for it. Remove the key entirely to go
#               back to the default (every video library that is not Plex "Other Videos").
#               An empty list is a real answer and means no libraries at all.
#
# Delete this file to start over — nothing else reads it.`;

export async function read(): Promise<PendingState> {
  try {
    const doc = (parse(await fsp.readFile(path, 'utf8')) as Partial<PendingState> | null) || {};
    return {
      // A file with no watermark means "everything is new", not "nothing is" — a fresh
      // install should show you the backlog rather than an empty page you cannot explain.
      seen_through: Number(doc.seen_through) || 0,
      dismissed: Array.isArray(doc.dismissed) ? doc.dismissed.map(String) : [],
      // Absent stays `null` — "nobody has chosen" — and only an actual list becomes one.
      // Non-numeric ids are dropped rather than coerced: `Number("Movies")` is `NaN`, which
      // matches no section and would silently empty the screen.
      libraries: Array.isArray(doc.libraries)
        ? doc.libraries.map(Number).filter((id) => Number.isFinite(id))
        : null,
    };
  } catch (e) {
    if (!isNodeError(e) || e.code !== 'ENOENT') {
      console.log(`[pending] could not read ${path}: ${errMessage(e)}`);
    }
    return { seen_through: 0, dismissed: [], libraries: null };
  }
}

export async function write(next: PendingState): Promise<void> {
  await fsp.mkdir(dirname(path), { recursive: true });
  await fsp.writeFile(
    path,
    // `libraries` is omitted while it is `null` rather than written as an explicit null:
    // the file is meant to be read and edited by hand, and a key that is present but empty
    // reads like a choice when it is the absence of one.
    `${HEADER}\n${stringify({
      seen_through: next.seen_through,
      dismissed: next.dismissed,
      ...(next.libraries === null ? {} : { libraries: next.libraries }),
    })}`,
  );
}
