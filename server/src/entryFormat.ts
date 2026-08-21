// THE QUEUE-ENTRY FORMAT — one place, so the reader and the writer cannot disagree.
//
// A `queues.yaml` entry is a MAPPING as of 2026-08-21. The bare-string form the file used to
// hold (`- "Duel (1971)"`, `- 12345`, `- "Collection: Godzilla"`) is not written any more and
// is not played any more — decision
// `2026-08-21-a-queue-entry-is-an-object-and-carries-its-rating-key`, which completes
// `2026-08-21-a-queue-entry-names-an-item-not-a-line` and supersedes the string-entry half of
// `2026-07-20-queue-entries-are-title-strings`.
//
// Three rules make the break safe to run against a live household file:
//
//   1. `queues.entryKey()` is UNTOUCHED. It still keys a scalar, because the key is the LINE
//      identity that `e2e/fixtures/golden/` records and that `removeItem` / `reorder` address a
//      line by. A file that still holds a scalar can therefore still be edited and repaired.
//   2. Nothing here rejects the FILE. A legacy scalar is one broken ENTRY: `loadEntries()`
//      refuses that entry by name and every other entry in the queue still plays.
//   3. The HTTP/MQTT surface is unchanged — a caller may still POST a bare title. It is
//      normalized at the WRITE boundary (`queues.addItem`), so only the disk shape changed.
//
// This is its own module rather than part of `queues.ts` so the engine (`engine/resolve.ts`)
// can state the rule without importing the whole YAML write-side, which would put a cycle
// through `sets.ts` and the provider registry.
import type { EntryObject, EntryValue } from './types.js';

/** `Collection: <name>` — the older, string-encoded spelling of a collection entry. */
export const COLLECTION_PREFIX_RE = /^\s*collection:\s*(.+)$/i;

/**
 * Is this the legacy SCALAR entry form — a bare string or number where a mapping belongs?
 *
 * `null`/`undefined` is not a legacy scalar; it is nothing at all, and `entryKey()` already
 * drops it. An ARRAY is: it is not a mapping, and it was never a valid entry either.
 */
export function isLegacyScalarEntry(value: unknown): boolean {
  if (value == null) return false;
  return typeof value !== 'object' || Array.isArray(value);
}

/**
 * Any accepted value as the mapping the file holds.
 *
 * IDENTITY-PRESERVING, and that is the whole contract: `entryKey(toEntryObject(v))` equals
 * `entryKey(v)` for every `v`. A numeric scalar is a rating key (`entryKey` says so), a
 * `Collection: <name>` string is a collection (`entryKey` keys `{collection: X}` and
 * `"Collection: X"` identically), and everything else is a title.
 *
 * A mapping passes through UNCHANGED — including `{title: "Collection: X"}`, which is an
 * older spelling of a collection that every reader still understands. The migration tool
 * normalizes that one; a write path must not, or an edit to an unrelated field would silently
 * re-shape a line the owner never touched.
 */
export function toEntryObject(value: EntryValue): EntryObject {
  if (value != null && typeof value === 'object' && !Array.isArray(value)) return value;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return { ratingKey: typeof value === 'number' ? value : s };
  const coll = COLLECTION_PREFIX_RE.exec(s)?.[1];
  if (coll !== undefined) return { collection: coll.trim() };
  return { title: String(value) };
}

/** The named complaint a legacy scalar earns, for a log line or an error message. */
export function legacyEntryMessage(setName: string, index: number, value: unknown): string {
  const shown = JSON.stringify(value);
  const want = JSON.stringify(toEntryObject(value as EntryValue));
  return `${setName}[${index}] ${shown} is a bare ${typeof value}. A queue entry is a mapping `
    + `since 2026-08-21 — write ${want} instead. This entry is NOT played until it is fixed.`;
}
