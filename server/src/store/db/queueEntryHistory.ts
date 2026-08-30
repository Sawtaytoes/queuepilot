// Per-queue watch history for entries that opt out of their provider's shared watched marks.
// Durable by definition, so it lives in queuepilot.sqlite rather than the deletable Plex cache.
import { bookOfRecord, prepareChecked } from './open.js';

export interface QueueItemProgress {
  isCompleted: boolean;
  positionMs: number;
  durationMs: number;
}

export function completedFor(setId: string, entryKey: string): Set<string> {
  const rows = prepareChecked<{ item_key: string }>(
    bookOfRecord(),
    `SELECT item_key FROM queue_entry_history
     WHERE set_id = :set_id AND entry_key = :entry_key AND is_completed = 1`,
  ).all({ set_id: setId, entry_key: entryKey });
  return new Set(rows.map((row) => String(row.item_key)));
}

export function progressFor(setId: string, entryKey: string): Map<string, QueueItemProgress> {
  const rows = prepareChecked<{
    item_key: string; is_completed: number; position_ms: number; duration_ms: number;
  }>(bookOfRecord(), `SELECT item_key, is_completed, position_ms, duration_ms
      FROM queue_entry_history WHERE set_id = :set_id AND entry_key = :entry_key`)
    .all({ set_id: setId, entry_key: entryKey });
  return new Map(rows.map((row) => [String(row.item_key), {
    isCompleted: Boolean(row.is_completed),
    positionMs: Number(row.position_ms),
    durationMs: Number(row.duration_ms),
  }]));
}

export function savePosition(
  setId: string,
  entryKey: string,
  itemKey: string,
  positionMs: number,
  durationMs: number,
): void {
  prepareChecked(bookOfRecord(), `INSERT INTO queue_entry_history
      (set_id, entry_key, item_key, completed_at, is_completed, position_ms, duration_ms)
    VALUES (:set_id, :entry_key, :item_key, 0, 0, :position_ms, :duration_ms)
    ON CONFLICT (set_id, entry_key, item_key) DO UPDATE SET
      is_completed = 0, position_ms = excluded.position_ms, duration_ms = excluded.duration_ms`)
    .run({
      set_id: setId, entry_key: entryKey, item_key: itemKey,
      position_ms: Math.max(0, Math.round(positionMs)),
      duration_ms: Math.max(0, Math.round(durationMs)),
    });
}

export function markCompleted(setId: string, entryKey: string, itemKey: string): void {
  prepareChecked(
    bookOfRecord(),
    `INSERT INTO queue_entry_history
       (set_id, entry_key, item_key, completed_at, is_completed, position_ms, duration_ms)
     VALUES (:set_id, :entry_key, :item_key, :completed_at, 1, 0, 0)
     ON CONFLICT (set_id, entry_key, item_key)
     DO UPDATE SET completed_at = excluded.completed_at, is_completed = 1,
       position_ms = 0, duration_ms = 0`,
  ).run({
    set_id: setId,
    entry_key: entryKey,
    item_key: itemKey,
    completed_at: Math.floor(Date.now() / 1000),
  });
}

export function clearCompleted(setId: string, entryKey: string): number {
  const result = prepareChecked(
    bookOfRecord(),
    'DELETE FROM queue_entry_history WHERE set_id = :set_id AND entry_key = :entry_key',
  ).run({ set_id: setId, entry_key: entryKey });
  return Number(result.changes);
}
