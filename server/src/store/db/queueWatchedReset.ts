// How far each queue has SETTLED its seasonal reset.
//
// decision 2026-09-08-a-queue-can-clear-its-own-watched-state-on-a-date-each-year. The reset
// date is EVALUATED ON A READ and there is no timer, so a queue played three times on
// 1 November is asked three times whether it is due. This row is the only thing that answers
// "already, at 18:04" for the second and third asks.
//
// ⚠️ `settled_at` IS NOT "WHEN IT LAST RESET", and the difference is what stops the feature
// wiping a season the day it is switched on. It means: *no occurrence at or before this moment
// owes this queue a reset.* Two things write it —
//
//   * a RESET, which settles the occurrence it just cleared;
//   * ADOPTION, the first read after somebody sets a date, which settles the occurrence that
//     has ALREADY passed without clearing anything. Without it, adding `reset_watched_on:
//     11-01` to a running Halloween queue in October makes the very next play throw away the
//     season, because the most recent 1 November is in the past and the queue has no stamp.
//     `reason` says which happened, so the log and the API can tell them apart.
//
// It is durable by definition — losing it lets a queue reset a second time and throw away the
// evening's watching — so it lives in `queuepilot.sqlite` beside `lead_cooldown` rather than in
// the deletable Plex cache.
import { bookOfRecord, prepareChecked } from './open.js';

/** Why a queue is settled through `settledAt`. */
export type WatchedResetReason =
  /** The first read after a date was set. Nothing was cleared. */
  | 'adopted'
  /** A person pressed the button, or a caller posted to the route / topic. */
  | 'manual'
  /** The `MM-DD` occurrence that fired the reset. */
  | (string & {});

export interface WatchedResetSettlement {
  settledAt: number;
  reason: WatchedResetReason | null;
}

export function settlementFor(setId: string): WatchedResetSettlement | null {
  const row = prepareChecked<{ settled_at: number; reason: string | null }>(
    bookOfRecord(),
    'SELECT settled_at, reason FROM queue_watched_reset WHERE set_id = :set_id',
  ).get({ set_id: setId });
  if (!row) return null;
  return { settledAt: Number(row.settled_at), reason: row.reason ?? null };
}

/**
 * Settle this queue through `atSec` (epoch SECONDS).
 *
 * The time is passed in rather than read from the clock here, so a caller's `now` and the row
 * it writes cannot disagree by the width of the operation between them.
 */
export function settle(setId: string, atSec: number, reason: WatchedResetReason): void {
  prepareChecked(
    bookOfRecord(),
    `INSERT INTO queue_watched_reset (set_id, settled_at, reason)
     VALUES (:set_id, :settled_at, :reason)
     ON CONFLICT (set_id) DO UPDATE SET
       settled_at = excluded.settled_at, reason = excluded.reason`,
  ).run({
    set_id: setId,
    settled_at: Math.floor(atSec),
    reason,
  });
}

/** Forget a queue's settlement — a set deletion, or a test. */
export function clearSettlement(setId: string): void {
  prepareChecked(
    bookOfRecord(),
    'DELETE FROM queue_watched_reset WHERE set_id = :set_id',
  ).run({ set_id: setId });
}
