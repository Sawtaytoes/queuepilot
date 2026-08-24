// Durable lead-cooldown store for Priority-queue entries
// (decision 2026-08-23-kind-is-picks-or-rules §3–4).
//
// WHY NOT cache.sqlite: that file is a derived Plex cache — wiped on schema bump and
// safe to `rm`. A lead timestamp is a USER decision about "this title already led in
// this window"; losing it on a cache clear would let a promote fire twice in one
// sitting.
//
// ── It used to be its own file, and is not any more (WP-2) ───────────────────────────────
//
// `lead_cooldown` lives in `/config/queuepilot.sqlite` — the book of record — as of
// decision 2026-08-23-promote-sqlite-folds-into-the-book-of-record. It was a third durable
// SQLite file (`/config/promote.sqlite`) whose rows are keyed by `(set id, entry key)`: the
// primary keys of the two tables it now sits beside. Three reasons it folded rather than
// stayed:
//
//   * IT HAD NEVER BEEN CREATED ON DISK. The code shipped the same day WP-2 started, so the
//     migration was zero rows. It would never have been that cheap again.
//   * A SCHEMA BUMP HERE USED TO WIPE. `openDb()` DROPped both tables on a version mismatch
//     and logged loudly about it — which is the cache's contract, on data the module's own
//     header says the app is not allowed to lose. The book of record MIGRATES instead.
//   * "TWO FILES, NEVER ONE" IS ABOUT THE CACHE. The rule the storage decision defends is that
//     the deletable file stays deletable. Three durable files is not that rule; it is one more
//     thing to remember to back up.
//
// `PROMOTE_PATH` is gone with it. The schema is `store/schema.sql`'s now, and this module
// owns the queries and nothing else.
import { errMessage } from './errors.js';
import { bookOfRecord, closeBookOfRecord, prepareChecked } from './store/db/open.js';
import type { PreparedStatement } from './store/sqlite.js';

// Prepared per call rather than cached at module level: `_closeForTests()` swaps the whole
// handle out, and a cached statement over a closed database is a crash rather than a miss.
// These run a handful of times per scan, not per row.
const stmt = (sql: string): PreparedStatement => prepareChecked(bookOfRecord(), sql);

/** Record that this entry successfully led (consumes a lead:once window). */
export async function recordLead(
  setId: string,
  entryKey: string,
  at: Date = new Date(),
): Promise<void> {
  try {
    stmt(`
      INSERT INTO lead_cooldown (set_id, entry_key, led_at) VALUES (?, ?, ?)
      ON CONFLICT (set_id, entry_key) DO UPDATE SET led_at = excluded.led_at
    `).run(setId, entryKey, Math.floor(at.getTime() / 1000));
  } catch (e) {
    console.log(`[promote] recordLead failed: ${errMessage(e)}`);
  }
}

/** When did this entry last lead? `null` if never (or store unavailable). */
export async function lastLedAt(
  setId: string,
  entryKey: string,
): Promise<Date | null> {
  try {
    const row = stmt(
      'SELECT led_at FROM lead_cooldown WHERE set_id = ? AND entry_key = ?',
    ).get(setId, entryKey) as { led_at?: unknown } | undefined;
    if (!row || row.led_at == null) return null;
    return new Date(Number(row.led_at) * 1000);
  } catch (e) {
    console.log(`[promote] lastLedAt failed: ${errMessage(e)}`);
    return null;
  }
}

/**
 * Parse a promote_window duration (`24h`, `7d`, `30d`, `90m`, …) to milliseconds.
 * Returns null for blank / unrecognised (caller treats as "no window" / default).
 */
export function parsePromoteWindow(raw: unknown): number | null {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;
  const m = /^(\d+)\s*(ms|s|m|h|d)$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2]!;
  const mult =
    unit === 'ms' ? 1
      : unit === 's' ? 1000
        : unit === 'm' ? 60_000
          : unit === 'h' ? 3_600_000
            : 86_400_000; // d
  return n * mult;
}

/** Product default when neither the entry nor the set names a window. */
export const DEFAULT_PROMOTE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * May this lead:once entry lead again?
 *
 * `true` when it has never led, or when `now - lastLed >= windowMs`.
 * Sticky (`lead: always`) callers should not ask.
 */
export async function canLeadOnce(
  setId: string,
  entryKey: string,
  windowMs: number = DEFAULT_PROMOTE_WINDOW_MS,
  now: Date = new Date(),
): Promise<boolean> {
  if (windowMs <= 0) return true;
  const last = await lastLedAt(setId, entryKey);
  if (!last) return true;
  return now.getTime() - last.getTime() >= windowMs;
}

/** Drop one entry's cooldown (demote / remove / tests). */
export async function clearLead(setId: string, entryKey: string): Promise<void> {
  try {
    stmt('DELETE FROM lead_cooldown WHERE set_id = ? AND entry_key = ?').run(setId, entryKey);
  } catch (e) {
    console.log(`[promote] clearLead failed: ${errMessage(e)}`);
  }
}

/** Test helper: close the book of record so a later open picks up a fresh path. */
export function _closeForTests(): void {
  closeBookOfRecord();
}
