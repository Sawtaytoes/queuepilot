// When each queue last cleared its own watched state.
//
// decision 2026-09-08-a-queue-can-clear-its-own-watched-state-on-a-date-each-year. The reset
// date is EVALUATED ON A READ and there is no timer, so a queue played three times on
// 1 November is asked three times whether it is due. This row is the only thing that answers
// "already, at 18:04" for the second and third asks.
//
// It is durable by definition — losing it lets a queue reset a second time and throw away the
// evening's watching — so it lives in `queuepilot.sqlite` beside `lead_cooldown` rather than in
// the deletable Plex cache.
import { bookOfRecord, prepareChecked } from './open.js';

/** One queue's reset stamp. `reason` is the `MM-DD` that fired it, or null for a manual run. */
export interface WatchedResetStamp {
  lastResetAt: number;
  reason: string | null;
}

export function lastResetFor(setId: string): WatchedResetStamp | null {
  const row = prepareChecked<{ last_reset_at: number; reason: string | null }>(
    bookOfRecord(),
    'SELECT last_reset_at, reason FROM queue_watched_reset WHERE set_id = :set_id',
  ).get({ set_id: setId });
  if (!row) return null;
  return { lastResetAt: Number(row.last_reset_at), reason: row.reason ?? null };
}

/**
 * Record that this queue reset. `atSec` is epoch SECONDS and is passed in rather than read
 * from the clock here, so the caller's `now` and the stamp cannot disagree by the width of
 * the reset itself.
 */
export function stampReset(setId: string, atSec: number, reason: string | null = null): void {
  prepareChecked(
    bookOfRecord(),
    `INSERT INTO queue_watched_reset (set_id, last_reset_at, reason)
     VALUES (:set_id, :last_reset_at, :reason)
     ON CONFLICT (set_id) DO UPDATE SET
       last_reset_at = excluded.last_reset_at, reason = excluded.reason`,
  ).run({
    set_id: setId,
    last_reset_at: Math.floor(atSec),
    reason,
  });
}

/** Forget a queue's stamp — a set deletion, or a test. */
export function clearStamp(setId: string): void {
  prepareChecked(
    bookOfRecord(),
    'DELETE FROM queue_watched_reset WHERE set_id = :set_id',
  ).run({ set_id: setId });
}
