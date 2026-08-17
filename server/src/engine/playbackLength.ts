// PLAYBACK LENGTH — how many items a set plays in one sitting, and the one place that answers
// it for every kind of set.
//
// The owner, 2026-08-17, after the Lineup box shipped with a queue-window knob:
//
//   "I think we don't need 'Items queued ahead'. Just default to 12 and use top-up to fix it.
//    What we _really_ need is a way to specify or configure the number of movies/episodes to
//    watch in a given setting. So you play the Younger Kids, and it plays <number> of 'em and
//    stops after. […] I think it should be 'Playback Length', and you note a number 1, 8,
//    Infinite, Custom."
//
// WHY THIS IS ONE MODULE. Four code paths independently decided how long a lineup is, and
// three of them hardcoded it:
//
//   * a filtered pool on `progress`  -> the set's `length:`, else env (the only honest one)
//   * a filtered pool on `rewatch`   -> literally 1  (providers/plex.ts returned `[item]`)
//   * a CURATED pool (kind: anime)   -> env ROTATION_LENGTH, never the set's own length
//   * an ORDERED queue               -> `batches[0]` — whatever the head entry contributed
//
// That last one is why the owner's framing lands so exactly on the existing behaviour: an
// ordered Movies queue already plays one entry per start, so it is ALREADY "Playback Length 1"
// and this knob simply lets him say 2. None of the four change on deploy — absent means each
// keeps the default it has always had, which is what `defaultFor` encodes.
//
// INFINITE IS A NAMED VALUE, never 0 and never 999. `docs/todos/batch-all-or-infinite.md`
// settled that rule for the per-entry batch and the reasoning carries: a falsy count already
// reads as *uncapped* in resolve.ts's `applyBatch`, so a typo that lands on 0 would become a
// binge rather than an error.
//
// TOP-UP IS DERIVED FROM THIS, not configured beside it (owner's call, 2026-08-17). A lineup
// needs topping up exactly when it wants to play more items than one window holds — which is
// every infinite lineup, and a finite one longer than the window. Deriving it removes the
// combination that could only ever be wrong: `infinite` with top-up off, which silently stops
// at 12.
import { ROTATION_LENGTH, ROTATION_LENGTH_MAX } from '../env.js';

/** The named infinite form, on the wire and on disk. */
export const INFINITE = 'infinite';

/**
 * How many items to play, or `null` for infinite.
 *
 * `null` and not `Infinity`: this crosses to JSON (the registry response, the MQTT payload),
 * and `JSON.stringify(Infinity)` is `null` anyway — so making the absence explicit here stops
 * a round trip from quietly inventing the difference.
 */
export type PlaybackTarget = number | null;

/** What a set plays when it has never said. Each is the behaviour that kind already had. */
export function defaultFor(cfg: {
  source?: unknown;
  kind?: unknown;
  behavior?: unknown;
  mode?: unknown;
} | null | undefined): PlaybackTarget {
  const source = String(cfg?.source ?? '').toLowerCase();
  const kind = String(cfg?.kind ?? '').toLowerCase();
  const isRewatch = String(cfg?.behavior ?? cfg?.mode ?? '').toLowerCase() === 'rewatch';

  // A rewatch pool has always returned exactly one film per scan.
  if (source === 'rotation' && isRewatch) return 1;
  // A filtered pool on progress, and a curated pool, have always filled a window.
  if (source === 'rotation' || kind === 'anime') return ROTATION_LENGTH;

  // An ORDERED queue has always played its head entry and nothing else, so its default is 1 —
  // and on that ONE path the unit is ENTRIES, not items.
  //
  // It has to be. A show entry's batch is already its own knob (`episodes:`), so counting
  // items here would make a length of 1 truncate a 2-episode entry to a single episode — a
  // silent behaviour change on every queue that never touched this control. On a rule-based
  // pool there are no entries to count and the unit is items, which is what `length: 12`
  // has always meant there. For the owner's own Movies queues the two agree anyway: one
  // entry is one film.
  return 1;
}

/**
 * Resolve a set's playback length.
 *
 * Deliberately TOLERANT of a bad value, like `max_items` in the routing loader: a blank, zero,
 * negative or unrecognised `length:` falls back to the default rather than throwing. This is
 * read at scan time on a card someone just tapped, so failing turns a hand-edited YAML typo
 * into a dead card on the wall, while falling back is visible and self-corrects.
 *
 * Clamped HERE as well as in the sets.ts writer, because sets.yaml is hand-edited over SMB as
 * often as it is saved through the editor — the engine cannot assume the writer's ceiling was
 * ever applied.
 */
export function playbackLength(
  cfg: {
    length?: unknown;
    refill?: unknown;
    source?: unknown;
    kind?: unknown;
    behavior?: unknown;
    mode?: unknown;
  } | null | undefined,
  /**
   * What "never said" means for THIS caller, when `defaultFor` is the wrong question.
   *
   * The one caller that needs it is Kavita. Its artifact is a persistent READING LIST, not a
   * sitting: the list is a sliding window of many series that the tablet pulls from over days,
   * so "how many items do you play before stopping" does not describe it and the ordered-queue
   * default of 1 would collapse the list to a single series. A reading queue that DOES state a
   * length still gets it — this only replaces the fallback.
   */
  fallback?: PlaybackTarget,
): PlaybackTarget {
  const raw = String(cfg?.length ?? '').trim().toLowerCase();

  if (raw === INFINITE) return null;

  // LEGACY: `refill: true` was the 2026-08-17 spelling of infinite, when `length` meant the
  // window rather than the sitting. Read as infinite so the live Younger Kids — Shorts card
  // keeps behaving the way it does today without its file being touched; the editor writes
  // `length: infinite` and drops `refill` the next time it is saved.
  // (decision `2026-08-17-a-lineup-refills-instead-of-ending`, superseded by this one)
  if (cfg?.refill === true) return null;

  const n = parseInt(raw, 10);

  if (!Number.isFinite(n) || n <= 0) return fallback === undefined ? defaultFor(cfg) : fallback;

  return Math.min(n, ROTATION_LENGTH_MAX);
}

/**
 * How many items to put in the queue UP FRONT.
 *
 * Never more than one window: an infinite lineup cannot be queued (a Plex playQueue is fixed
 * once created) and a long finite one should not be, because every item costs a Plex round
 * trip on a card someone just tapped — 442 items on the live Shorts pool. Top-up carries the
 * rest.
 */
export function initialQueueSize(target: PlaybackTarget): number {
  return target == null ? ROTATION_LENGTH : Math.min(target, ROTATION_LENGTH);
}

/**
 * Does this set need topping up? DERIVED, never stored.
 *
 * True exactly when it wants to play more than one window holds. A pool at 1 or 8 never tops
 * up; `infinite`, and a Custom above the window, always do.
 */
export function needsTopup(target: PlaybackTarget): boolean {
  return target == null || target > ROTATION_LENGTH;
}

/** Has a session that wants `target` items already been handed them all? */
export function isTargetMet(target: PlaybackTarget, queuedTotal: number): boolean {
  return target != null && queuedTotal >= target;
}
