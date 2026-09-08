// Clearing a queue's watched state — the one implementation, and the read-time check in front
// of it.
//
// decision 2026-09-08-a-queue-can-clear-its-own-watched-state-on-a-date-each-year
// decision 2026-09-08-the-reset-is-exposed-on-the-api-and-mqtt-without-a-home-assistant-automation
//
// ── ONE FUNCTION, THREE DOORS ────────────────────────────────────────────────────────────
//
// `resetQueueWatchedState()` is reachable from the HTTP route, from the MQTT command topic and
// from the read-time check below. There is no second implementation and there must not be one:
// the manual reset in the Actions menu and the seasonal one on 1 November are the same
// operation, and a queue that behaved differently depending on which door it came through
// would be impossible to reason about a year later.
//
// ── IT NEVER WRITES TO A PROVIDER ────────────────────────────────────────────────────────
//
// No Plex play count moves, in either direction. Nothing in this file imports a provider, and
// nothing in it may. This is not a courtesy: the household server holds other people's watch
// state in the same profile, and a queue clearing its own rows is the only version of this
// feature that is safe there. `e2e/seasonal-reset-test.ts` asserts the provider is untouched.
import * as cache from './cache.js';
import { errMessage } from './errors.js';
import * as promote from './promote.js';
import * as queues from './queues.js';
import { isResetDue } from './seasonalReset.js';
import * as queueEntryHistory from './store/db/queueEntryHistory.js';
import * as queueWatchedReset from './store/db/queueWatchedReset.js';

/**
 * What a reset threw away. Three numbers because a reset clears THREE things and only the
 * first is obvious — the confirm dialog names the total, and a person debugging a queue that
 * "did not reset" needs to know which of the three was zero.
 */
export interface WatchedResetCounts {
  /** Entries whose `done` / `done_at` flags were stripped in `queues.yaml`. */
  entries: number;
  /** `queue_entry_history` rows deleted — where the completions live on `watch_history: queue`. */
  historyRows: number;
  /** `lead_cooldown` rows deleted, so an entry that led last season can lead again. */
  leadCooldowns: number;
  /** The sum. What the UI counts, and what the MQTT response reports. */
  total: number;
}

export interface WatchedResetResult extends WatchedResetCounts {
  set: string;
  /** Epoch seconds settled on `queue_watched_reset`. */
  resetAt: number;
  /** `'manual'`, or the `MM-DD` occurrence that fired it. */
  reason: string;
}

/**
 * Clear every completion this queue owns.
 *
 * THREE THINGS, and the record explains why all three:
 *
 *  1. the `done` / `done_at` flags on each entry (`queues.clearDone`);
 *  2. every `queue_entry_history` row for the set — where the completions live when
 *     `watch_history` is `queue`, which is the Halloween queue's case. Clearing only the flags
 *     leaves a partly watched series stuck at the episode it reached, with no badge to explain
 *     why;
 *  3. the `lead_cooldown` rows, so an entry that led last season can lead again.
 *
 * `atSec` and `reason` are passed in so the seasonal caller's clock and the row it settles
 * agree, and so the row records WHICH occurrence fired. A manual reset passes neither and
 * settles as `'manual'` at the current moment.
 */
export async function resetQueueWatchedState(
  setId: string,
  opts: { atSec?: number; reason?: string } = {},
): Promise<WatchedResetResult> {
  const atSec = Math.floor(opts.atSec ?? Date.now() / 1000);
  const reason = opts.reason ?? 'manual';

  // 1. The `done` flags. Read the list first so the count is what was actually cleared rather
  //    than a `changed: boolean`; `clearDone` answers all-or-nothing and the dialog needs a
  //    number. An entry with `done: true` and no `done_at` is a HAND-marked skip and is
  //    cleared too — it is a completion the queue owns, and a season it was skipped in is over.
  const rows = await queues.listSet(setId);
  const doneKeys = rows.filter((row) => row.done).map((row) => row.key);
  if (doneKeys.length) await queues.clearDone(setId, doneKeys);

  // 2. The queue-owned ledger. Whole-set, never a loop over the entries above — an entry whose
  //    line was re-keyed since it played leaves rows no current key answers to.
  const historyRows = queueEntryHistory.clearSet(setId);

  // 3. The lead windows.
  const leadCooldowns = await promote.clearSetLeads(setId);

  // Settle the queue through this moment, so the read AFTER this one does not reset it again.
  // There is no timer holding that state — this row is it.
  queueWatchedReset.settle(setId, atSec, reason);

  // The tiles carry a Completed badge and the shelf skeleton carries the lane split, both of
  // which just changed. Best-effort: the cache is derived and a failure here must not turn a
  // successful reset into an error.
  try {
    await cache.bumpGeneration();
  } catch (e) {
    console.log(`[reset] cache generation bump failed: ${errMessage(e)}`);
  }

  const counts: WatchedResetCounts = {
    entries: doneKeys.length,
    historyRows,
    leadCooldowns,
    total: doneKeys.length + historyRows + leadCooldowns,
  };
  console.log(
    `[reset] ${setId} cleared ${counts.entries} done flags, ${counts.historyRows} history rows, `
    + `${counts.leadCooldowns} lead cooldowns (${reason})`,
  );
  return { set: setId, resetAt: atSec, reason, ...counts };
}

/**
 * The READ-TIME check. Called on the play path, never on a timer.
 *
 * Returns the reset that happened, or null when the queue is not configured, is ADOPTING its
 * date on this read (see below), is not past that date, or has already reset for this year's
 * occurrence. A queue with no `reset_watched_on` costs one string test and behaves exactly as
 * it does today — no database read at all, which is why the guard is FIRST.
 *
 * ⚠️ `remove_completed_after` DEFEATS this, and it defeats it silently. That setting does not
 * tag an entry, it DELETES the entry from the queue, so a seasonal queue with a TTL set has
 * nothing left to reset by the time the date arrives. Nothing here can fix that — the entries
 * are gone — so the two settings are mutually exclusive in practice and the Set editor says so
 * where they sit. A log line here is the only other warning anybody gets.
 */
export async function applySeasonalReset(
  setId: string,
  cfg: { reset_watched_on?: unknown; remove_completed_after?: unknown } | null | undefined,
  now: Date = new Date(),
): Promise<WatchedResetResult | null> {
  const resetWatchedOn = cfg?.reset_watched_on;
  // The cheap guard, before anything opens the book of record.
  if (resetWatchedOn == null || String(resetWatchedOn).trim() === '') return null;

  let settledAt: number | null = null;
  try {
    settledAt = queueWatchedReset.settlementFor(setId)?.settledAt ?? null;
  } catch (e) {
    // A store that cannot be read must not stop the queue playing. Skipping the reset is the
    // safe direction: it happens on the next read, which is what a missed day already means.
    console.log(`[reset] ${setId}: could not read the reset settlement (${errMessage(e)})`);
    return null;
  }

  // ⚠️ ADOPTION. A queue with a date and no row has just been given one, and the most recent
  // occurrence of any date is in the PAST — so the literal reading fires immediately. That
  // would mean adding `reset_watched_on: 11-01` to a running Halloween queue in October throws
  // the season away on the very next play, with no confirm and nothing on screen to say why.
  //
  // So the first read SETTLES the occurrence that has already passed and clears nothing. The
  // reset then fires on the NEXT one, which is what "clear this queue once a year on this date"
  // means to the person who typed it. Somebody who wants it now has the Actions menu, which
  // names the count before it does anything.
  if (settledAt == null) {
    const nowSec = Math.floor(now.getTime() / 1000);
    queueWatchedReset.settle(setId, nowSec, 'adopted');
    console.log(
      `[reset] ${setId} adopted its reset date (${String(resetWatchedOn).trim()}); `
      + 'nothing cleared — the first reset is the next time that date comes round.',
    );
    return null;
  }

  const verdict = isResetDue({ resetWatchedOn, lastResetAt: settledAt, now });
  if (!verdict.isDue) return null;

  const ttl = cfg?.remove_completed_after;
  if (ttl != null && String(ttl).trim() && !isTtlOff(ttl)) {
    console.log(
      `[reset] ${setId} also carries remove_completed_after: ${String(ttl).trim()} — `
      + 'finished entries are DELETED rather than tagged, so this reset has less to clear '
      + 'than the queue looks like it should.',
    );
  }

  return resetQueueWatchedState(setId, {
    atSec: Math.floor(now.getTime() / 1000),
    reason: verdict.reason,
  });
}

/** The spellings `sets.ts` and `queues.sweepCompleted` already treat as "no TTL". */
const TTL_OFF = ['0', 'never', 'off', 'none', 'disabled'];
const isTtlOff = (v: unknown): boolean => TTL_OFF.includes(String(v).trim().toLowerCase());
