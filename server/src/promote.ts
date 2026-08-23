// Durable lead-cooldown store for Priority-queue entries
// (decision 2026-08-23-kind-is-picks-or-rules §3–4).
//
// WHY NOT cache.sqlite: that file is a derived Plex cache — wiped on schema bump and
// safe to `rm`. A lead timestamp is a USER decision about "this title already led in
// this window"; losing it on a cache clear would let a promote fire twice in one
// sitting. This file is therefore a separate durable sqlite next to the YAML store.
//
// Schema is tiny and versioned; a mismatch migrates rather than wiping (unlike the
// cache). Entries are keyed by (set id, entry key) so two queues sharing a ratingKey
// do not share a cooldown.
import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite';
import { PROMOTE_PATH } from './env.js';
import { errMessage } from './errors.js';

type Row = Record<string, SQLOutputValue>;

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);

-- One row per (set, entry) that has successfully led under lead:once.
-- led_at is unix epoch seconds.
CREATE TABLE lead_cooldown (
  set_id   TEXT NOT NULL,
  entry_key TEXT NOT NULL,
  led_at   INTEGER NOT NULL,
  PRIMARY KEY (set_id, entry_key)
);
CREATE INDEX lead_cooldown_led_at ON lead_cooldown (led_at);
`;

let db: DatabaseSync | null = null;
const stmts = new Map<string, StatementSync>();

function conn(): DatabaseSync {
  if (!db) db = openDb();
  return db;
}

function stmt(sql: string): StatementSync {
  let s = stmts.get(sql);
  if (!s) {
    s = conn().prepare(sql);
    stmts.set(sql, s);
  }
  return s;
}

function openDb(): DatabaseSync {
  const opened = new DatabaseSync(PROMOTE_PATH);
  opened.exec('PRAGMA journal_mode = WAL;');
  opened.exec('PRAGMA synchronous = NORMAL;');
  let version: number | null = null;
  try {
    const versionRow = opened.prepare(
      "SELECT v FROM meta WHERE k = 'schema_version'",
    ).get() as Row | undefined;
    version = versionRow ? Number(versionRow.v) : null;
  } catch {
    // Fresh file — no meta table yet.
    version = null;
  }
  if (version !== SCHEMA_VERSION) {
    // Promote data is tiny; on a version bump we recreate. Unlike cache.sqlite we LOG
    // loudly because a wipe here forgets cooldowns — callers should bump carefully.
    if (version != null) {
      console.log(
        `[promote] schema ${version} != ${SCHEMA_VERSION} — recreating ${PROMOTE_PATH}`,
      );
    }
    opened.exec(`
      DROP TABLE IF EXISTS lead_cooldown;
      DROP TABLE IF EXISTS meta;
    `);
    opened.exec(SCHEMA);
    opened.prepare(
      "INSERT INTO meta (k, v) VALUES ('schema_version', ?)",
    ).run(String(SCHEMA_VERSION));
  }
  return opened;
}

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
    ).get(setId, entryKey) as Row | undefined;
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

/** Test helper: close the handle so a later open picks up a fresh path. */
export function _closeForTests(): void {
  try { db?.close(); } catch { /* ignore */ }
  db = null;
  stmts.clear();
}
