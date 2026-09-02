// Playing a SECTION of an item: start at `start.position_ms`, stop at `end.position_ms`, and
// advance. The data path landed in #302; this file is the part that makes it play.
//
// WHY THIS IS NOT `resume.ts`. Both files answer "the player landed on an item — seek it
// somewhere", so reusing the resume plan looked obvious. It cannot be reused, for three
// reasons, and only the third is a matter of taste:
//
//   1. The resume plan is `Map<ratingKey, ms>`. Since #300 one queue can hold the same file
//      twice, so a second section of that file OVERWRITES the first.
//   2. Its `seen: Set<string>` considers each ratingKey ONCE, so the second occurrence is
//      answered `already considered` and never seeks at all.
//   3. Its filters are all wrong here. RESUME_MIN_MS (30 s) would drop a section starting at
//      0:12, RESUME_MAX_FRACTION (0.95) would drop a closing-gag section, and `viewCount >= 1`
//      would drop a section of any film already watched. Every one of those is CORRECT for a
//      resume marker, which is inferred data, and wrong for a section, which is authored.
//      (decision 2026-09-01-a-section-boundary-is-detected-from-the-push-feed-not-a-five-second-poll)
//
// So the plan is keyed by PLAYQUEUE INDEX. `readPlayQueue().selectedOffset` is the only signal
// that says which OCCURRENCE of a repeated file is playing, and an index is the only key that
// can hold two different windows for one ratingKey.
//
// ONE WATCHER, TWO PLANS. `resume.startWatch()` consults this file first and its own plan
// second, rather than running a second timer. Two pollers against one /status/sessions would
// double the request rate and, worse, could both decide to seek the same item from two
// different reads of the same moment. One read, one decision, and the precedence between the
// two plans is a single `if`: an AUTHORED section outranks an INFERRED resume marker.
//
// THE INDEX IS READ, NOT ASSUMED. Plex may reorder or drop what it was handed, and a top-up
// inserts after the currently-playing item. So a located row is checked against the LIVE
// playQueue before it is used, and an ambiguous reading declines rather than guessing — a
// section seek on the wrong occurrence is a worse outcome than no section at all.
import type { PlexPlayItem } from './types.js';

/** How long a recorded boundary stays claimable by `takeBoundary()`. */
const BOUNDARY_TTL_MS = 120_000;

/** How many times a section start may be declined before it is given up on. */
const START_ATTEMPTS = 8;

/**
 * The two fields `engine/resolve.ts sectionOf()` stamps on the FIRST unit an entry
 * contributes. Both are independently optional, matching the file format.
 */
export interface SectionFields {
  /** Where the first played unit BEGINS. Null = the beginning of the unit. */
  sectionStartMs?: number | null;
  /** Where it STOPS, at which point the lineup advances. Null = the end of the unit. */
  sectionEndMs?: number | null;
}

/** What `sectionPlan()` reads off one lineup item. */
export interface SectionCandidate extends SectionFields {
  ratingKey?: string | number | null;
  duration?: number | null;
  /** Which queue LINE this item came from — see `EntryExtras.id` / `queues.entryKey()`. */
  queueEntryKey?: string | undefined;
  /** True when completion belongs to QueuePilot's private ledger, not the provider's. */
  queueOwnHistory?: boolean | undefined;
}

/** One row of the plan: what to do to the item at one playQueue index. */
export interface SectionRow {
  ratingKey: string;
  /** Null when there is nothing to seek to — no `start`, a `start` of 0, or the head's start
   *  already went out as playMedia's `offset`. */
  startMs: number | null;
  /** Null when the unit plays to its natural end. */
  endMs: number | null;
  entryKey: string | null;
  isOwnHistory: boolean;
  /** Set once the start has been seeked, given up on, or was never needed. */
  isStartDone: boolean;
  /** Set once this row has nothing left to do. `pendingCount()` counts the rest. */
  isDone: boolean;
  /** Declines so far, so a viewer who is deliberately past the start is not fought forever. */
  attempts: number;
}

/** Where the player is in the LIVE playQueue — `playback.readPlayQueue()`'s answer. */
export interface PlayQueuePlace {
  index: number;
  ratingKeys: readonly string[];
}

/** One observed `/status/sessions` reading. Same shape `resume.ts` reads. */
export interface ObservedPosition {
  ratingKey?: string | number | null;
  viewOffset?: number | null;
}

/** What `consider()` decided, and why. Every `reason` is logged verbatim. */
export interface SectionDecision {
  action: 'seek' | 'next' | 'wait' | 'none';
  reason: string;
  /** Set on `seek`: the millisecond offset to seek to. */
  ms?: number;
  /** Set on `wait`: how long until the end mark, at the observed rate. */
  dueInMs?: number;
  index?: number;
  rk?: string;
  /** Set when the decline is provisional and the next read should reconsider. */
  retry?: boolean;
  /**
   * The lineup DOES window this file, and the window here is already spent.
   *
   * Load-bearing rather than informational: it is what keeps the resume plan off an item a
   * section owns for the whole sitting. Without it, the read after a start seek finds no live
   * row, falls through, and a resume marker drags the viewer back out of the section that was
   * just set up. A spent window is quiet — it is the steady state for the rest of the item.
   */
  isSpent?: boolean;
}

/**
 * The head item's start offset — where `playMedia` is told to begin.
 *
 * THE PRECEDENCE, stated once and tested: an AUTHORED section start outranks an INFERRED
 * resume marker. A resume point is a guess about where somebody stopped; a section is a
 * sentence somebody wrote. This also settles the `watch_history: queue` case — the private
 * ledger's position loses to the section for the same reason the provider's viewOffset does,
 * because the question is not which ledger is better but which KIND of fact wins.
 *
 * An entry with an `end` and no `start` reads as "from the beginning of the unit" (the
 * decision record's third row), so it returns 0 rather than the resume marker. Playing a
 * closing-gag entry from a half-hour marker would honour neither key.
 *
 * `playsSections` is the provider capability. A backend that cannot serve a section must
 * never have one reach its playback path, so this is where the guard sits for the head — the
 * plan below carries the same guard for everything after it.
 */
export function headStartOffsetMs(
  head: SectionFields | null | undefined,
  resumeOffsetMs: number,
  { playsSections }: { playsSections: boolean },
): number {
  const fallback = Math.max(0, Math.round(Number(resumeOffsetMs) || 0));
  if (!playsSections || !head) return fallback;
  if (head.sectionStartMs != null) return Math.max(0, Math.round(head.sectionStartMs));
  if (head.sectionEndMs != null) return 0;
  return fallback;
}

/**
 * Which lineup positions carry a window, and what to do at each.
 *
 * Keyed by INDEX into the list handed to `createPlayQueue`, which is the same list and the
 * same order `playItems` is in. A ratingKey key could not hold two windows for one file.
 *
 * `isHeadStartApplied` says the head's start already went out as playMedia's `offset` — the
 * free path, no seek and no delay. Its END still belongs in the plan: stopping the first clip
 * of a demo reel is the whole point of the feature.
 *
 * A window is DROPPED against a known duration rather than left to fail silently:
 *  - a `start` at or past the item's runtime has nothing to seek to;
 *  - an `end` at or past it can never be reached by a position, so the unit plays to its
 *    natural end and the row would otherwise keep the watcher awake until `maxMs`.
 * A duration of 0/absent means "not known here", and the window is kept as written.
 */
export function sectionPlan(
  items: readonly SectionCandidate[] | null | undefined,
  { isHeadStartApplied = false, playsSections = true }: {
    isHeadStartApplied?: boolean;
    playsSections?: boolean;
  } = {},
): Map<number, SectionRow> {
  const plan = new Map<number, SectionRow>();
  if (!playsSections) return plan;
  (items || []).forEach((item, index) => {
    if (!item || item.ratingKey == null) return;
    const duration = Math.max(0, Number(item.duration) || 0);
    let startMs = item.sectionStartMs != null ? Math.max(0, Math.round(item.sectionStartMs)) : null;
    let endMs = item.sectionEndMs != null ? Math.max(0, Math.round(item.sectionEndMs)) : null;
    if (startMs != null && duration > 0 && startMs >= duration) startMs = null;
    if (endMs != null && duration > 0 && endMs >= duration) endMs = null;
    // A start of 0 IS the default, and `playback.seekTo()` refuses a non-positive offset
    // anyway. Nothing to do is not the same as no section — the row may still carry an end.
    if (startMs != null && startMs <= 0) startMs = null;
    if (startMs == null && endMs == null) return;
    const isHead = index === 0;
    plan.set(index, {
      ratingKey: String(item.ratingKey),
      startMs: isHead && isHeadStartApplied ? null : startMs,
      endMs,
      entryKey: item.queueEntryKey ?? null,
      isOwnHistory: item.queueOwnHistory === true,
      isStartDone: isHead && isHeadStartApplied ? true : startMs == null,
      isDone: false,
      attempts: 0,
    });
  });
  // A row with nothing left to do at build time (the head's start went out with playMedia and
  // it has no end) is not a pending row.
  for (const [index, row] of plan) {
    if (row.isStartDone && row.endMs == null) plan.delete(index);
  }
  return plan;
}

// --- the armed plan ------------------------------------------------------------ //
//
// A session is a fresh scan, so arming replaces the plan wholesale — a re-scan must never
// inherit the previous lineup's pending windows.

const ARMED: { plan: Map<number, SectionRow>; setName: string | null } = {
  plan: new Map(), setName: null,
};

export function arm({ plan = null, setName = null }: {
  plan?: Map<number, SectionRow> | null;
  setName?: string | null;
} = {}): number {
  ARMED.plan = plan instanceof Map ? plan : new Map();
  ARMED.setName = setName;
  return ARMED.plan.size;
}

export function disarm(): void {
  ARMED.plan = new Map();
  ARMED.setName = null;
}

export const armedCount = (): number => ARMED.plan.size;
export const pendingCount = (): number => (
  [...ARMED.plan.values()].filter((row) => !row.isDone).length
);

/**
 * Would locating this ratingKey need the live playQueue?
 *
 * The read costs one LAN GET, so it is paid only when it buys something: when exactly one
 * pending row names the observed item there is only one occurrence it can be, and the index
 * adds nothing. Two pending rows for one file is the case `selectedOffset` exists for.
 */
export function isAmbiguous(ratingKey: string): boolean {
  let seen = 0;
  for (const row of ARMED.plan.values()) {
    if (!row.isDone && row.ratingKey === ratingKey) seen += 1;
    if (seen > 1) return true;
  }
  return false;
}

/**
 * Does the armed lineup put a window on this file?
 *
 * DONE rows count. `finished.ts` asks this to decide whether to save a live position for the
 * item on screen, and after a first section completes its row is done while a SECOND section
 * of the same file is still to come — a position saved then would land on the first section's
 * ledger row (`SESSION.queue.find()` matches by ratingKey) and clear the completion it just
 * earned.
 *
 * KNOWN NARROWING, and it is the safe direction: a file that appears in one lineup BOTH with
 * a window and without one gets no live position saved for the unwindowed line either. A
 * missing resume point is recoverable; a completion silently undone is not.
 */
export function isWindowed(ratingKey: string): boolean {
  for (const row of ARMED.plan.values()) if (row.ratingKey === ratingKey) return true;
  return false;
}

/** Every pending row BEFORE `index` is behind the player now, so it will never fire. */
function retirePassed(index: number): void {
  for (const [at, row] of ARMED.plan) {
    if (at < index && !row.isDone) {
      row.isDone = true;
      row.isStartDone = true;
    }
  }
}

/** Which plan row the observed session is, or null with the reason it could not be named. */
function locate(
  ratingKey: string,
  place: PlayQueuePlace | null | undefined,
): { index: number; row: SectionRow } | { index: null; reason: string; retry?: boolean } {
  const named = place && place.index >= 0 ? ARMED.plan.get(place.index) : undefined;
  // The live playQueue's own answer, checked against what it is actually holding at that
  // index — Plex reorders, drops what a token cannot see, and a top-up inserts mid-queue.
  if (place && named && !named.isDone && named.ratingKey === ratingKey
    && (place.ratingKeys[place.index] == null || place.ratingKeys[place.index] === ratingKey)) {
    return { index: place.index, row: named };
  }
  const candidates = [...ARMED.plan.entries()]
    .filter(([, row]) => !row.isDone && row.ratingKey === ratingKey);
  if (candidates.length === 1) {
    const [index, row] = candidates[0]!;
    return { index, row };
  }
  if (candidates.length > 1) {
    return {
      index: null,
      // Two windows on one file and no usable index. Guessing would seek the wrong section,
      // which is worse than not sectioning at all — so decline, and retry in case the
      // playQueue read was simply late.
      reason: `${candidates.length} windows name rk=${ratingKey} and the playQueue index did not pick one`,
      retry: true,
    };
  }
  return { index: null, reason: 'no window at this position' };
}

/**
 * Decide what to do about one observed reading, given where the player is in the playQueue.
 *
 * Pure apart from the armed plan's own bookkeeping, so the policy is testable without Plex,
 * a player or a broker — the same seam `resume.considerSession()` has.
 */
export function consider(
  session: ObservedPosition | null | undefined,
  place: PlayQueuePlace | null = null,
): SectionDecision {
  if (!ARMED.plan.size) return { action: 'none', reason: 'no section plan' };
  if (!session || session.ratingKey == null) return { action: 'none', reason: 'nothing playing' };
  const rk = String(session.ratingKey);
  const found = locate(rk, place);
  if (found.index == null) {
    const out: SectionDecision = { action: 'none', reason: found.reason, rk };
    if (found.retry) out.retry = true;
    // No live row, but this lineup DOES window this file — its window here is spent. The
    // resume plan still must not touch it: a section owns its item for the whole sitting.
    else if (isWindowed(rk)) out.isSpent = true;
    return out;
  }
  const { index, row } = found;
  // The player is at `index`, so anything earlier is behind it. That is how a window whose
  // `end` sat past the item's real runtime stops holding the watcher open.
  retirePassed(index);
  const position = Math.max(0, Number(session.viewOffset) || 0);

  if (!row.isStartDone && row.startMs != null) {
    if (position < row.startMs) {
      row.isStartDone = true;
      if (row.endMs == null) row.isDone = true;
      return {
        action: 'seek', ms: row.startMs, index, rk,
        reason: `section start at ${Math.round(row.startMs / 1000)}s`,
      };
    }
    row.attempts += 1;
    // At the moment of an advance /status/sessions can still report the PREVIOUS item's
    // position against the new ratingKey — recorded live in resume.ts, where one episode's
    // first sighting carried the previous one's 895 s. So a reading past the start is
    // provisional, not final. It settles within a read or two; a viewer who genuinely
    // scrubbed past the mark keeps reporting a high position and is correctly left alone
    // once the attempts run out.
    if (row.attempts < START_ATTEMPTS) {
      return {
        action: 'none', retry: true, index, rk,
        reason: `${Math.round(position / 1000)}s in, already past the ${Math.round(row.startMs / 1000)}s section start`,
      };
    }
    row.isStartDone = true;
    if (row.endMs == null) row.isDone = true;
    return {
      action: 'none', index, rk,
      reason: `gave up on the section start — ${Math.round(position / 1000)}s in after ${row.attempts} reads`,
    };
  }

  if (row.endMs == null) {
    row.isDone = true;
    return { action: 'none', index, rk, reason: 'the window is handled' };
  }

  if (position >= row.endMs) {
    row.isDone = true;
    recordBoundary(rk, {
      entryKey: row.entryKey,
      setName: ARMED.setName,
      isOwnHistory: row.isOwnHistory,
    });
    return {
      action: 'next', index, rk,
      reason: `section end at ${Math.round(row.endMs / 1000)}s reached (${Math.round(position / 1000)}s)`,
    };
  }

  return {
    action: 'wait', index, rk, dueInMs: row.endMs - position,
    reason: `${Math.round((row.endMs - position) / 1000)}s until the section ends`,
  };
}

// --- the boundary ledger ------------------------------------------------------- //
//
// WHY THIS EXISTS AT ALL, because it is the subtlest thing in the change.
//
// `finished.ts` decides an item's outcome from where playback stopped. A section entry stops
// at 40% BY DESIGN, and 40% is exactly what an abandoned play looks like. Left alone, a
// two-minute clip of a two-hour film would be filed as "somebody walked out 48 minutes in":
// the queue's private ledger would store a 40% resume position, `leadsInProgress` would hoist
// that entry to the front of the pool every sitting, and the entry sheet would offer to
// resume something nobody stopped.
//
// So the fact worth recording is not the position — it is WHO stopped it. A stop the SECTION
// asked for is not a stop the viewer made, and this ledger is how the two are told apart. It
// is written only by the watcher, only when IT issued the `skipNext`, and read once.
//
// What it does NOT do: it never touches provider history. A queue on `watch_history: provider`
// asked Plex to be the judge, and Plex judges a 40% play as unwatched — that is the queue's
// call, per the decision record, and forcing a `viewCount` would be this feature inventing a
// rule the owner did not ask for.

/** One recorded stop-and-advance, waiting for `finished.ts` to attribute it. */
export interface Boundary {
  entryKey: string | null;
  setName: string | null;
  isOwnHistory: boolean;
  at: number;
}

const BOUNDARIES = new Map<string, Boundary>();

export function recordBoundary(
  ratingKey: string,
  { entryKey, setName, isOwnHistory, now = Date.now }: {
    entryKey: string | null;
    setName: string | null;
    isOwnHistory: boolean;
    now?: () => number;
  },
): void {
  BOUNDARIES.set(String(ratingKey), { entryKey, setName, isOwnHistory, at: now() });
}

/**
 * Claim the boundary for an item that just left the screen, if this app is what took it off.
 *
 * Consumed rather than read, so one stop is attributed once — a later ordinary play of the
 * same file must go down the ordinary path. The TTL is the second half of that: a boundary
 * nobody claimed within two minutes belonged to a play that ended some other way.
 */
export function takeBoundary(
  ratingKey: string,
  { now = Date.now }: { now?: () => number } = {},
): Boundary | null {
  const key = String(ratingKey);
  const found = BOUNDARIES.get(key);
  if (!found) return null;
  BOUNDARIES.delete(key);
  return now() - found.at > BOUNDARY_TTL_MS ? null : found;
}

export function forgetBoundaries(): void {
  BOUNDARIES.clear();
}

/** Test seam — the armed plan and the boundary ledger, for harnesses that assert on them. */
export const _internals = { ARMED, BOUNDARIES };

/** Narrow a lineup item to the fields this file reads, without a cast at every call site. */
export const asCandidate = (item: PlexPlayItem): SectionCandidate => (
  item as unknown as SectionCandidate
);
