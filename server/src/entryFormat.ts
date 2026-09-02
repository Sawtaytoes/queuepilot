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
//   1. `queues.entryKey()` still keys a SCALAR, so a file that holds one can still be edited
//      and repaired through the editor. It gained one branch on 2026-09-01 — an optional
//      opaque `id:` read FIRST — and nothing else about it moved: an entry with no `id` keys
//      exactly as it always did, byte for byte
//      (`2026-09-01-an-entry-can-carry-an-id-so-one-file-can-hold-two-lines`).
//   2. Nothing here rejects the FILE. A legacy scalar is one broken ENTRY: `loadEntries()`
//      refuses that entry by name and every other entry in the queue still plays. A
//      hand-written duplicate key with no `id` is refused the same way, for the same reason.
//   3. The HTTP/MQTT surface is unchanged — a caller may still POST a bare title. It is
//      normalized at the WRITE boundary (`queues.addItem`), so only the disk shape changed.
//
// This is its own module rather than part of `queues.ts` so the engine (`engine/resolve.ts`)
// can state the rule without importing the whole YAML write-side, which would put a cycle
// through `sets.ts` and the provider registry.
import { randomBytes } from 'node:crypto';
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

// --- the optional entry `id` (2026-09-01) ------------------------------------- //
//
// An entry may carry an opaque `id`, and `entryKey()` reads it as its FIRST branch. That is
// what lets one queue hold the same file twice: two lines for one rating key, each with its
// own key, so `queue_entry_history`, `lead_cooldown`, every `?only=<key>` URL and every
// per-entry mutation address one line and not two
// (`2026-09-01-an-entry-can-carry-an-id-so-one-file-can-hold-two-lines`).
//
// The id is ADDITIVE and is minted only where the alternative was a refusal. An entry that
// carries none keys exactly as it did before, which is why every pinned entry-key string in
// `e2e/` passes unmodified.

/**
 * The entry's `id`, trimmed, or null when it carries none.
 *
 * A blank or whitespace-only `id` is NOT an identity — it reads as absent, so a hand-edit that
 * left `id:` with nothing after it falls back to `rk:`/`title:` instead of keying every such
 * line to the same empty string. `String(...)` because YAML hands back a number for an
 * all-digit id, and both `entryKey()` copies must agree on the spelling.
 */
export function entryIdOf(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = (value as { id?: unknown }).id;
  if (raw == null) return null;
  const id = String(raw).trim();
  return id ? id : null;
}

/**
 * The alphabet a minted id is drawn from: lowercase hexadecimal.
 *
 * Two constraints, and hex is the cheapest thing that meets both. The id lands in a
 * `/go/<set>?only=<key>` URL and in an MQTT payload, so every character must be URL-safe with
 * no escaping. It is also read in hand-edited YAML over SMB, so it has to be short enough to
 * copy by eye — six characters, the length the design doc's example uses.
 */
const ID_ALPHABET = '0123456789abcdef';
const ID_LENGTH = 6;

/**
 * A short opaque id no entry in `taken` already uses.
 *
 * GENERATED AND CHECKED, never trusted to entropy alone: 24 bits is small on purpose (it is
 * meant to be readable), so the birthday bound is well inside the size of a real queue and the
 * caller passes in every id the file already holds. On repeated collision the id GROWS rather
 * than the loop spinning — a longer id is still a valid id, and an unbounded retry would be a
 * hang instead of an add.
 *
 * An all-digit id is rejected so the value stays a YAML STRING. `id: 123456` parses back as a
 * number, and while both `entryKey()` copies coerce with `String(...)` and would agree, a key
 * whose type depends on which six characters came out of the generator is a trap for the next
 * reader.
 */
export function mintEntryId(taken: ReadonlySet<string>): string {
  for (let length = ID_LENGTH; length <= ID_LENGTH + 6; length += 1) {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const bytes = randomBytes(length);
      let id = '';
      for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length];
      if (/^\d+$/.test(id)) continue;
      if (!taken.has(id)) return id;
    }
  }
  // Unreachable in practice: 12 hex characters is 48 bits against a file of a few hundred
  // lines. Throwing beats returning a colliding id, which would silently merge two lines.
  throw new Error('could not mint a unique entry id');
}

// --- the section window (2026-09-01) ------------------------------------------ //
//
// `start.position_ms` and `end.position_ms` say where inside the first played unit playback
// begins and where it stops (decision
// `2026-09-01-a-start-point-carries-a-position-and-end-is-its-mirror`). The COERCION lives
// here, beside `hasSection`, so the predicate that decides an add is deliberate and the
// writers that put the numbers on disk cannot drift apart: one function, three readers
// (`hasSection` below, `queues.normalizeStart` and `queues.normalizeEnd`).

/**
 * A `position_ms` off the wire or off the file, or null when there is no usable value.
 *
 * THE SPARSE RULE, spelled once. A null, an absent key, a blank string, a boolean, an array, a
 * negative offset and a non-numeric string are all "no position", and every caller DROPS the
 * key rather than writing a 0 nobody typed. Zero itself is a real value — "begin at the very
 * start" is what an `end`-only window means for its other half — so it is `!= null` that tests
 * this, never truthiness.
 *
 * A numeric string is accepted because YAML hands one back for a quoted offset and the HTTP
 * body is JSON somebody may have typed. `Math.round` because a millisecond is the smallest
 * unit any of this speaks; a fractional one is a UI rounding artefact, not a finer offset.
 */
export function toPositionMs(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.round(ms);
}

/**
 * Does this value carry a SECTION — a `start.position_ms` or an `end.position_ms`?
 *
 * READ-ONLY. It answers the IDENTITY question the fields raise, which had to be settled a day
 * before they existed: an add that names a window is asking for a LINE, not for the item, so it
 * is an add the duplicate guard must let through and an add that mints its own `id`. Nothing
 * here validates the PAIR — "end must be strictly after start" needs both sides of one entry
 * and belongs with the writers in `queues.ts`.
 */
export function hasSection(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const m = value as { start?: unknown; end?: unknown };
  return hasPositionMs(m.start) || hasPositionMs(m.end);
}

/**
 * One side of a window: an object carrying a usable `position_ms`.
 *
 * Delegates to `toPositionMs` rather than testing `Number(...)` itself, which is a real fix and
 * not a tidy-up. The first draft read `Number(side.position_ms)`, and `Number(null)` is `0` —
 * so `{start: {position_ms: null}}` answered TRUE. `null` is this file format's spelling of
 * "no value" (`{start: null}` is how a start is cleared), so the guard would have called a
 * cleared window a section, minted an id for it and let a duplicate add through, while
 * `normalizeStart` correctly dropped the key. `''` did the same thing.
 */
function hasPositionMs(side: unknown): boolean {
  if (!side || typeof side !== 'object' || Array.isArray(side)) return false;
  return toPositionMs((side as { position_ms?: unknown }).position_ms) != null;
}

/**
 * The named complaint a hand-written duplicate key earns.
 *
 * Same shape and same doctrine as `legacyEntryMessage`: the ENTRY is named, the fix is spelled
 * out, and the queue keeps playing without it. A duplicate key is the one thing an `id` exists
 * to prevent, and it is reachable only by hand — `addItem` mints an id rather than writing one.
 */
export function duplicateEntryMessage(
  setName: string,
  index: number,
  value: unknown,
  key: string,
): string {
  const shown = JSON.stringify(value);
  return `${setName}[${index}] ${shown} repeats the key ${JSON.stringify(key)}, which an `
    + 'earlier entry in this queue already holds. A key names ONE line since 2026-09-01 — give '
    + 'this entry an `id:` of its own (any short unique text) so it can be addressed, played '
    + 'and tracked separately. This entry is NOT played until it is fixed.';
}
