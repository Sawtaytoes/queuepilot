// The DERIVED PLEX CACHE (decision 2026-08-03-sqlite-is-a-derived-plex-cache-not-the-store).
//
// This is NOT the store. queues.yaml + sets.yaml are the durable, hand-editable source of
// truth; this file holds only what a Plex re-read could regenerate. It is deletable, wiped on
// a schema-version mismatch, gitignored, never backed up. Its entire reason to exist: the
// 2.6-2.8 s `/api/queues` is Plex I/O, and the in-process Maps that used to cache it die on
// every container restart — which is precisely when the user notices.
//
// STORAGE: node:sqlite's DatabaseSync, verified working on the image's Node (v24.18.1) with no
// experimental warning. Not better-sqlite3 — a native build inside `npm install --omit=dev`
// turns a missed prebuild into a deploy-time compiler hunt and buys nothing at tens of
// statements per request. Not a JSON file — no indexed lookup, whole-file rewrite per update,
// no crash atomicity, for ~50k history rows.
//
// DatabaseSync is synchronous and blocks the event loop, but the rows are small and every
// query is an indexed point lookup (sub-100 µs). WAL + synchronous=NORMAL + batched writes in
// explicit transactions keep it cheap. EVERY export has an `async` signature even though the
// bodies are synchronous — so relocating this module into a worker_thread is free if p99 ever
// suffers.
import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite';
import { CACHE_PATH } from './env.js';
import { errMessage } from './errors.js';
import type { CachedResolved } from './types.js';

/** A row as `node:sqlite` hands it back. Every column read is `| undefined` under
 * `noUncheckedIndexedAccess`, which is why each one below goes through `Number()` /
 * `String()` exactly as the JS did — those coercions were always doing the narrowing. */
type Row = Record<string, SQLOutputValue>;

/** `JSON.parse(row.payload)` in typed form. `String()` on the column value is a faithful
 * translation, not a guard: `JSON.parse` already stringifies its argument, so a NULL column
 * parsed to `null` before and still does, and a missing one threw SyntaxError before and
 * still does. The result is `unknown`-by-generic — the payload shape differs per table and
 * the caller names it. */
const payloadOf = <T,>(row: Row): T => JSON.parse(String(row.payload)) as T;

/**
 * The (updatedAt, viewedLeafCount) pair a caller already holds from a section listing, used
 * to prove a cached `leaves` row is still current. Both are read straight off a Plex item,
 * so both may be absent — `?? -1` is what makes an absent validator field fail the identity
 * test rather than accidentally match a 0. Not in types.ts: it is this module's argument
 * shape, and no other file names it yet.
 */
export interface LeavesValidator {
  updatedAt?: number | string | null;
  viewedLeafCount?: number | string | null;
}

/** The `collection_children` twin of `LeavesValidator`. */
export interface CollectionValidator {
  updatedAt?: number | string | null;
  childCount?: number | string | null;
}

/** What `getSectionListing` returns: the payload plus whether it is past the soft TTL, so
 * the caller can serve it AND kick a background refresh. */
export interface SectionListingHit<T> {
  payload: T;
  stale: boolean;
}

/** One history row as `addHistory` takes it. */
export interface HistoryRow {
  ratingKey: string | number;
  viewedAt?: number | null;
}

// Bump on ANY schema change below. On open, a mismatch DROPs every table and recreates them —
// a stale cache schema is never worth migrating (it is a cache).
const SCHEMA_VERSION = 3;

const SCHEMA = `
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);

-- allLeaves per show, PER ACCOUNT. The episode STRUCTURE is account-independent, but each
-- leaf's viewCount (watched) is the querying account's own — so a per-profile channel's editor
-- must not share the admin account's row (account '' = admin/Bob). Validated (not expired)
-- against that account's per-show (updatedAt, viewedLeafCount): if both still match, the cached
-- episode list is provably still correct — one section HTTP call revalidates every show in it.
CREATE TABLE leaves (
  show_rk TEXT, account TEXT, updated_at INT, leaf_count INT,
  viewed_leaf_count INT, payload TEXT, fetched_at INT, PRIMARY KEY (show_rk, account));

-- title -> item, per section. title->ratingKey is stable, so no validator; 7-day TTL.
CREATE TABLE resolved (
  section TEXT, title TEXT, year TEXT, guid TEXT,
  payload TEXT, fetched_at INT, PRIMARY KEY (section, title, year, guid));

-- a collection's ordered children, PER ACCOUNT, validated against (updatedAt, childCount).
-- The member list and its order are account-independent, but three fields on every row are
-- not: a movie member's watched/viewOffset, and a show member's viewedLeafCount — which is
-- the "154/155 watched" the start editor prints. Sharing one row across accounts is what made
-- a kid's collection show the OWNER's progress (account '' = admin/Bob), the same trap the
-- leaves table above already had an account column for.
CREATE TABLE collection_children (
  rk TEXT, account TEXT, updated_at INT, child_count INT, payload TEXT, fetched_at INT,
  PRIMARY KEY (rk, account));

-- a section listing (all?type=…), per (section, type, account). 5-min soft TTL,
-- stale-while-revalidate. The account column is load-bearing: viewedLeafCount is per-account.
CREATE TABLE section_listing (
  section TEXT, type TEXT, account TEXT,
  payload TEXT, fetched_at INT, PRIMARY KEY (section, type, account));

-- watched history, replacing the paged /history walk. Append-only; an incremental cursor on
-- viewedAt means a warm fetch stops at the first row it already has (normally one page).
CREATE TABLE history (
  account TEXT, section TEXT, rating_key TEXT, viewed_at INT,
  PRIMARY KEY (account, section, rating_key));
CREATE INDEX history_by_time ON history (account, section, viewed_at);
CREATE TABLE history_cursor (
  account TEXT, section TEXT, last_viewed_at INT, PRIMARY KEY (account, section));
`;

let db: DatabaseSync | null = null;

// `db` is non-null everywhere below — every export gates on `ready()` first, and `openDb()`
// assigns before it prepares. The types can't see that invariant across the module-level
// `let`, so it is asserted here once instead of at each of the ~20 statement sites. The
// throw is unreachable in practice.
function conn(): DatabaseSync {
  if (!db) throw new Error('[cache] database is not open');
  return db;
}

// Prepared-statement cache — DatabaseSync.prepare is cheap but not free, and these run on the
// request path.
const stmts = new Map<string, StatementSync>();
function q(sql: string): StatementSync {
  let s = stmts.get(sql);
  if (!s) {
    s = conn().prepare(sql);
    stmts.set(sql, s);
  }
  return s;
}

function openDb(): DatabaseSync {
  if (db) return db;
  const opened = new DatabaseSync(CACHE_PATH);
  db = opened;
  opened.exec('PRAGMA journal_mode=WAL');
  opened.exec('PRAGMA synchronous=NORMAL');

  // Schema-version gate. A brand-new file has no meta table, so the read is guarded.
  let version: number | null = null;
  try {
    const row = opened.prepare('SELECT v FROM meta WHERE k = ?').get('schema_version');
    version = row ? Number(row.v) : null;
  } catch {
    version = null; // no meta table yet
  }
  if (version !== SCHEMA_VERSION) {
    // Drop everything and recreate. A stale cache schema is never migrated.
    const tables = opened
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all();
    for (const t of tables) opened.exec(`DROP TABLE IF EXISTS ${String(t.name)}`);
    opened.exec(SCHEMA);
    opened.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
    opened.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run('generation', '0');
    if (version != null) console.log(`[cache] schema ${version} != ${SCHEMA_VERSION} — wiped ${CACHE_PATH}`);
  }
  return opened;
}

// Call once at boot. Idempotent. A failure here (e.g. /config unwritable) must NOT crash the
// web server — the cache is an optimization, and every reader below degrades to a miss.
export async function init(): Promise<boolean> {
  try {
    openDb();
    return true;
  } catch (e) {
    console.log(`[cache] disabled: ${errMessage(e)}`);
    db = null;
    return false;
  }
}

const now = (): number => Date.now();
const ready = (): boolean => db != null;

// --- generation: the ETag input (B7) + the SSE cache-buster --------------------------- //
// Bumped on every explicit invalidation, so a watch on the Shield busts the browser's cached
// /api/queues. Read as a plain integer.
export async function generation(): Promise<number> {
  if (!ready()) return 0;
  const row = q('SELECT v FROM meta WHERE k = ?').get('generation');
  return row ? Number(row.v) : 0;
}

export async function bumpGeneration(): Promise<number> {
  if (!ready()) return 0;
  const next = (await generation()) + 1;
  q('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(
    'generation',
    String(next),
  );
  return next;
}

// --- leaves (allLeaves per show) ------------------------------------------------------- //
// The core validate-don't-expire trick. A caller that has the show's CURRENT (updatedAt,
// viewedLeafCount) from a section listing passes them here; if the cached row matches, the
// payload is provably fresh and no allLeaves call is made. Absent that validator, a 24 h TTL
// is the fallback.
const LEAVES_TTL_MS = 24 * 60 * 60 * 1000;

// `account` ('' = admin/Bob) scopes the row: the same show has a distinct watched (viewCount)
// view per Plex Home profile, so a per-profile channel's editor reads its own account's row.
export async function getLeaves<T = unknown>(
  showRk: string | number,
  validator: LeavesValidator | null = null,
  account: string = '',
): Promise<T | null> {
  if (!ready()) return null;
  const row = q('SELECT * FROM leaves WHERE show_rk = ? AND account = ?').get(String(showRk), String(account || ''));
  if (!row) return null;
  if (validator) {
    // Provably-fresh path: identity on (updatedAt, viewedLeafCount).
    if (
      Number(row.updated_at) === Number(validator.updatedAt ?? -1) &&
      Number(row.viewed_leaf_count) === Number(validator.viewedLeafCount ?? -1)
    ) {
      return payloadOf<T>(row);
    }
    return null; // the show moved — caller must refetch
  }
  if (now() - Number(row.fetched_at) > LEAVES_TTL_MS) return null;
  return payloadOf<T>(row);
}

export async function putLeaves(
  showRk: string | number,
  {
    updatedAt,
    leafCount,
    viewedLeafCount,
    payload,
  }: LeavesValidator & { leafCount?: number | string | null; payload: unknown },
  account: string = '',
): Promise<void> {
  if (!ready()) return;
  q(
    `INSERT INTO leaves (show_rk, account, updated_at, leaf_count, viewed_leaf_count, payload, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(show_rk, account) DO UPDATE SET
       updated_at = excluded.updated_at, leaf_count = excluded.leaf_count,
       viewed_leaf_count = excluded.viewed_leaf_count, payload = excluded.payload,
       fetched_at = excluded.fetched_at`,
  ).run(
    String(showRk),
    String(account || ''),
    Number(updatedAt ?? 0),
    Number(leafCount ?? 0),
    Number(viewedLeafCount ?? 0),
    JSON.stringify(payload),
    now(),
  );
}

// A precise, free invalidation: MQTT now-playing (mqttc.onNowPlaying) already tells us which
// show is being watched — drop its leaves rows so the next read refetches exactly one show.
// Drops EVERY account's row for the show: a watch shifts one account's viewCount, but
// over-invalidating the others just refetches them lazily and stays correct.
export async function dropLeaves(showRk: string | number): Promise<void> {
  if (!ready()) return;
  q('DELETE FROM leaves WHERE show_rk = ?').run(String(showRk));
}

// --- resolved (title -> item) ---------------------------------------------------------- //
const RESOLVED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const rkey = (
  section: string | number,
  title: string,
  year: string | number | null | undefined,
  guid: string | null | undefined,
): [string, string, string, string] =>
  [String(section), String(title).toLowerCase(), year == null ? '' : String(year), (guid || '').toLowerCase()];

/**
 * TRI-STATE (see `CachedResolved` in types.ts): `undefined` = miss (no row, expired, or the
 * cache is off), `null` = a CACHED NULL — Plex genuinely had nothing — and anything else is
 * a hit. Callers must test `=== undefined`; a `??`/`||` fallback re-fetches every cached
 * negative and defeats the point of the table.
 */
export async function getResolved<T = unknown>(
  section: string | number,
  title: string,
  year: string | number | null | undefined,
  guid: string | null | undefined,
): Promise<CachedResolved<T>> {
  if (!ready()) return undefined; // undefined = cache miss; a cached NULL result is `null`
  const [s, t, y, g] = rkey(section, title, year, guid);
  const row = q('SELECT payload, fetched_at FROM resolved WHERE section=? AND title=? AND year=? AND guid=?').get(s, t, y, g);
  if (!row) return undefined;
  if (now() - Number(row.fetched_at) > RESOLVED_TTL_MS) return undefined;
  return payloadOf<T>(row);
}

export async function putResolved(
  section: string | number,
  title: string,
  year: string | number | null | undefined,
  guid: string | null | undefined,
  payload: unknown,
): Promise<void> {
  if (!ready()) return;
  const [s, t, y, g] = rkey(section, title, year, guid);
  q(
    `INSERT INTO resolved (section, title, year, guid, payload, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(section, title, year, guid) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
  ).run(s, t, y, g, JSON.stringify(payload), now());
}

// --- collection_children --------------------------------------------------------------- //
const COLLECTION_TTL_MS = 24 * 60 * 60 * 1000;

export async function getCollectionChildren<T = unknown>(
  rk: string | number,
  validator: CollectionValidator | null = null,
  account: string = '',
): Promise<T | null> {
  if (!ready()) return null;
  const row = q('SELECT * FROM collection_children WHERE rk = ? AND account = ?').get(String(rk), String(account || ''));
  if (!row) return null;
  if (validator) {
    if (
      Number(row.updated_at) === Number(validator.updatedAt ?? -1) &&
      Number(row.child_count) === Number(validator.childCount ?? -1)
    ) {
      return payloadOf<T>(row);
    }
    return null;
  }
  if (now() - Number(row.fetched_at) > COLLECTION_TTL_MS) return null;
  return payloadOf<T>(row);
}

export async function putCollectionChildren(
  rk: string | number,
  { updatedAt, childCount, payload }: CollectionValidator & { payload: unknown },
  account: string = '',
): Promise<void> {
  if (!ready()) return;
  q(
    `INSERT INTO collection_children (rk, account, updated_at, child_count, payload, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(rk, account) DO UPDATE SET updated_at = excluded.updated_at, child_count = excluded.child_count,
       payload = excluded.payload, fetched_at = excluded.fetched_at`,
  ).run(String(rk), String(account || ''), Number(updatedAt ?? 0), Number(childCount ?? 0), JSON.stringify(payload), now());
}

// --- section_listing (soft TTL, stale-while-revalidate) -------------------------------- //
const SECTION_SOFT_MS = 5 * 60 * 1000;

// Returns { payload, stale } or null. `stale` lets the caller serve it immediately AND kick a
// background refresh (the warmer does this).
export async function getSectionListing<T = unknown>(
  section: string | number,
  type: string,
  account: string = '',
): Promise<SectionListingHit<T> | null> {
  if (!ready()) return null;
  const row = q('SELECT payload, fetched_at FROM section_listing WHERE section=? AND type=? AND account=?').get(
    String(section),
    String(type),
    String(account || ''),
  );
  if (!row) return null;
  return { payload: payloadOf<T>(row), stale: now() - Number(row.fetched_at) > SECTION_SOFT_MS };
}

export async function putSectionListing(
  section: string | number,
  type: string,
  account: string,
  payload: unknown,
): Promise<void> {
  if (!ready()) return;
  q(
    `INSERT INTO section_listing (section, type, account, payload, fetched_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(section, type, account) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
  ).run(String(section), String(type), String(account || ''), JSON.stringify(payload), now());
}

// Config mutation dropped the sections a set draws from → drop their listings so the next read
// reflects the change. Called from server.js's updateSet path.
export async function dropSectionListings(
  sections: string | number | readonly (string | number)[],
): Promise<void> {
  if (!ready()) return;
  const del = q('DELETE FROM section_listing WHERE section = ?');
  // `[].concat(x)` in the JS: accepts a bare value or an array and flattens one level.
  // `concat` on a typed empty array won't infer that, so the same widening is spelled out.
  for (const s of Array.isArray(sections) ? sections : [sections]) del.run(String(s));
}

// --- history (append-only, cursor-driven) ---------------------------------------------- //
export async function isWatched(
  account: string,
  section: string | number,
  ratingKey: string | number,
): Promise<boolean> {
  if (!ready()) return false;
  const row = q('SELECT 1 FROM history WHERE account=? AND section=? AND rating_key=?').get(
    String(account),
    String(section),
    String(ratingKey),
  );
  return Boolean(row);
}

// The whole watched set for (account, section) — one indexed SELECT, replacing the paged walk.
export async function watchedSet(account: string, section: string | number): Promise<Set<string>> {
  if (!ready()) return new Set();
  const rows = q('SELECT rating_key FROM history WHERE account=? AND section=?').all(String(account), String(section));
  return new Set(rows.map((r) => String(r.rating_key)));
}

// Insert history rows in ONE transaction (batched writes, per B1). Each row is
// {ratingKey, viewedAt}. Advances the cursor to the newest viewedAt seen.
export async function addHistory(
  account: string,
  section: string | number,
  rows: readonly HistoryRow[],
): Promise<void> {
  if (!ready() || !rows.length) return;
  const ins = q(
    `INSERT INTO history (account, section, rating_key, viewed_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(account, section, rating_key) DO UPDATE SET viewed_at = excluded.viewed_at`,
  );
  let maxViewed = 0;
  conn().exec('BEGIN');
  try {
    for (const r of rows) {
      ins.run(String(account), String(section), String(r.ratingKey), Number(r.viewedAt || 0));
      if (Number(r.viewedAt || 0) > maxViewed) maxViewed = Number(r.viewedAt || 0);
    }
    if (maxViewed) {
      const cur = q('SELECT last_viewed_at FROM history_cursor WHERE account=? AND section=?').get(String(account), String(section));
      if (!cur || maxViewed > Number(cur.last_viewed_at)) {
        q(
          `INSERT INTO history_cursor (account, section, last_viewed_at) VALUES (?, ?, ?)
           ON CONFLICT(account, section) DO UPDATE SET last_viewed_at = excluded.last_viewed_at`,
        ).run(String(account), String(section), maxViewed);
      }
    }
    conn().exec('COMMIT');
  } catch (e) {
    conn().exec('ROLLBACK');
    throw e;
  }
}

// The incremental fetch cursor: fetch …/history/all?…&sort=viewedAt:desc and stop at this
// timestamp. null = never fetched, do a full first-boot walk.
export async function historyCursor(account: string, section: string | number): Promise<number | null> {
  if (!ready()) return null;
  const row = q('SELECT last_viewed_at FROM history_cursor WHERE account=? AND section=?').get(String(account), String(section));
  return row ? Number(row.last_viewed_at) : null;
}

// A single watch just landed on the Shield (mqttc.onNowPlaying): record it directly, precise
// and free, and bump the generation so the browser's /api/queues ETag busts.
export async function recordWatch(
  account: string,
  section: string | number,
  ratingKey: string | number,
  viewedAt?: number | null,
): Promise<void> {
  if (!ready()) return;
  await addHistory(account, section, [{ ratingKey, viewedAt: viewedAt || now() }]);
  await bumpGeneration();
}
