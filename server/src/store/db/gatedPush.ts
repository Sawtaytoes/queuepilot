// What QueuePilot pushed, and which account the queue was bound to when it did.
//
// decision 2026-10-12-a-profile-observation-expires-and-a-gated-push-is-audited. One row per
// play that carried a profile binding. Nothing in the app reads these rows during playback —
// they exist so `accountAudit.ts` can compare the items a gated queue pushed against the
// account Plex actually filed them under, AFTER the fact. The post-play audit already stops a
// mismatch it can SEE; this is the net under the plays where it had no opinion.
//
// Durable by definition: the whole point is to answer a question about last week, so it lives
// in `queuepilot.sqlite` beside `lead_cooldown` rather than in the deletable Plex cache.
import { bookOfRecord, prepareChecked } from './open.js';
import type { SqliteDatabase } from '../sqlite.js';

export interface GatedPush {
  id: number;
  setId: string;
  profile: string | null;
  accountId: number;
  /** Unix epoch SECONDS. */
  pushedAt: number;
  /** The pushed ratingKeys, as strings, in pushed order. */
  ratingKeys: string[];
  playQueueId: number | null;
}

export interface GatedPushInput {
  setId: string;
  profile?: string | null;
  accountId: number;
  /** Unix epoch SECONDS. Passed in so a caller's `now` and the row cannot disagree. */
  pushedAt: number;
  ratingKeys: (string | number)[];
  playQueueId?: number | null;
}

/**
 * Parse a JSON column back to an array, tolerating a row written by an older build or edited
 * by hand. A malformed column is an empty list rather than a throw: a damaged row must not be
 * able to take the audit — or the route that calls it — down.
 */
function jsonArray(raw: unknown): unknown[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rowToPush(row: {
  id: number;
  set_id: string;
  profile: string | null;
  account_id: number;
  pushed_at: number;
  rating_keys: string;
  play_queue_id: number | null;
}): GatedPush {
  return {
    id: Number(row.id),
    setId: String(row.set_id),
    profile: row.profile ?? null,
    accountId: Number(row.account_id),
    pushedAt: Number(row.pushed_at),
    ratingKeys: jsonArray(row.rating_keys).map((key) => String(key)),
    playQueueId: row.play_queue_id == null ? null : Number(row.play_queue_id),
  };
}

/**
 * Log one gated push. Returns the row id.
 *
 * A push with no ratingKeys is still recorded. It cannot produce a finding, but its absence
 * would read as "the queue never played", which is a different and wrong answer.
 */
export function recordPush(
  input: GatedPushInput,
  db: SqliteDatabase = bookOfRecord(),
): number {
  const result = prepareChecked(
    db,
    `INSERT INTO gated_push
       (set_id, profile, account_id, pushed_at, rating_keys, play_queue_id)
     VALUES
       (:set_id, :profile, :account_id, :pushed_at, :rating_keys, :play_queue_id)`,
  ).run({
    set_id: input.setId,
    profile: input.profile ?? null,
    account_id: Math.trunc(input.accountId),
    pushed_at: Math.floor(input.pushedAt),
    rating_keys: JSON.stringify(input.ratingKeys.map((key) => String(key))),
    play_queue_id: input.playQueueId ?? null,
  });
  return Number(result.lastInsertRowid ?? 0);
}

/** Every gated push at or after `sinceSec` (epoch SECONDS), oldest first. */
export function pushesSince(
  sinceSec: number,
  limit = 500,
  db: SqliteDatabase = bookOfRecord(),
): GatedPush[] {
  const rows = prepareChecked<{
    id: number;
    set_id: string;
    profile: string | null;
    account_id: number;
    pushed_at: number;
    rating_keys: string;
    play_queue_id: number | null;
  }>(
    db,
    `SELECT id, set_id, profile, account_id, pushed_at, rating_keys, play_queue_id
       FROM gated_push
      WHERE pushed_at >= :since
      ORDER BY pushed_at ASC, id ASC
      LIMIT :limit`,
  ).all({ since: Math.floor(sinceSec), limit: Math.max(1, Math.trunc(limit)) });
  return rows.map(rowToPush);
}

/**
 * Forget pushes older than `beforeSec`. Called by the audit so the table cannot grow without
 * bound — it is a diagnostic log, not history anybody reads directly.
 */
export function prunePushesBefore(
  beforeSec: number,
  db: SqliteDatabase = bookOfRecord(),
): number {
  const result = prepareChecked(
    db,
    'DELETE FROM gated_push WHERE pushed_at < :before',
  ).run({ before: Math.floor(beforeSec) });
  return Number(result.changes ?? 0);
}
