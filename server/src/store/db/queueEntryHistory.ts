// Per-queue watch history for entries that opt out of their provider's shared watched marks.
// Durable by definition, so it lives in queuepilot.sqlite rather than the deletable Plex cache.
import { bookOfRecord, prepareChecked } from './open.js';

export function completedFor(setId: string, entryKey: string): Set<string> {
  const rows = prepareChecked<{ item_key: string }>(
    bookOfRecord(),
    'SELECT item_key FROM queue_entry_history WHERE set_id = :set_id AND entry_key = :entry_key',
  ).all({ set_id: setId, entry_key: entryKey });
  return new Set(rows.map((row) => String(row.item_key)));
}

export function markCompleted(setId: string, entryKey: string, itemKey: string): void {
  prepareChecked(
    bookOfRecord(),
    `INSERT INTO queue_entry_history (set_id, entry_key, item_key, completed_at)
     VALUES (:set_id, :entry_key, :item_key, :completed_at)
     ON CONFLICT (set_id, entry_key, item_key)
     DO UPDATE SET completed_at = excluded.completed_at`,
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
