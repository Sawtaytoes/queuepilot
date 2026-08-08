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
import { DatabaseSync } from 'node:sqlite';
import { CACHE_PATH } from './env.js';

// Bump on ANY schema change below. On open, a mismatch DROPs every table and recreates them —
// a stale cache schema is never worth migrating (it is a cache).
const SCHEMA_VERSION = 2;

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

-- a collection's ordered children, validated against (updatedAt, childCount).
CREATE TABLE collection_children (
  rk TEXT PRIMARY KEY, updated_at INT, child_count INT, payload TEXT, fetched_at INT);

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

let db = null;

// Prepared-statement cache — DatabaseSync.prepare is cheap but not free, and these run on the
// request path.
const stmts = new Map();
function q(sql) {
  let s = stmts.get(sql);
  if (!s) {
    s = db.prepare(sql);
    stmts.set(sql, s);
  }
  return s;
}

function openDb() {
  if (db) return db;
  db = new DatabaseSync(CACHE_PATH);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA synchronous=NORMAL');

  // Schema-version gate. A brand-new file has no meta table, so the read is guarded.
  let version = null;
  try {
    const row = db.prepare('SELECT v FROM meta WHERE k = ?').get('schema_version');
    version = row ? Number(row.v) : null;
  } catch {
    version = null; // no meta table yet
  }
  if (version !== SCHEMA_VERSION) {
    // Drop everything and recreate. A stale cache schema is never migrated.
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all();
    for (const t of tables) db.exec(`DROP TABLE IF EXISTS ${t.name}`);
    db.exec(SCHEMA);
    db.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
    db.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run('generation', '0');
    if (version != null) console.log(`[cache] schema ${version} != ${SCHEMA_VERSION} — wiped ${CACHE_PATH}`);
  }
  return db;
}

// Call once at boot. Idempotent. A failure here (e.g. /config unwritable) must NOT crash the
// web server — the cache is an optimization, and every reader below degrades to a miss.
export async function init() {
  try {
    openDb();
    return true;
  } catch (e) {
    console.log(`[cache] disabled: ${e.message}`);
    db = null;
    return false;
  }
}

const now = () => Date.now();
const ready = () => db != null;

// --- generation: the ETag input (B7) + the SSE cache-buster --------------------------- //
// Bumped on every explicit invalidation, so a watch on the Shield busts the browser's cached
// /api/queues. Read as a plain integer.
export async function generation() {
  if (!ready()) return 0;
  const row = q('SELECT v FROM meta WHERE k = ?').get('generation');
  return row ? Number(row.v) : 0;
}

export async function bumpGeneration() {
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
export async function getLeaves(showRk, validator = null, account = '') {
  if (!ready()) return null;
  const row = q('SELECT * FROM leaves WHERE show_rk = ? AND account = ?').get(String(showRk), String(account || ''));
  if (!row) return null;
  if (validator) {
    // Provably-fresh path: identity on (updatedAt, viewedLeafCount).
    if (
      Number(row.updated_at) === Number(validator.updatedAt ?? -1) &&
      Number(row.viewed_leaf_count) === Number(validator.viewedLeafCount ?? -1)
    ) {
      return JSON.parse(row.payload);
    }
    return null; // the show moved — caller must refetch
  }
  if (now() - Number(row.fetched_at) > LEAVES_TTL_MS) return null;
  return JSON.parse(row.payload);
}

export async function putLeaves(showRk, { updatedAt, leafCount, viewedLeafCount, payload }, account = '') {
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
export async function dropLeaves(showRk) {
  if (!ready()) return;
  q('DELETE FROM leaves WHERE show_rk = ?').run(String(showRk));
}

// --- resolved (title -> item) ---------------------------------------------------------- //
const RESOLVED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const rkey = (section, title, year, guid) =>
  [String(section), String(title).toLowerCase(), year == null ? '' : String(year), (guid || '').toLowerCase()];

export async function getResolved(section, title, year, guid) {
  if (!ready()) return undefined; // undefined = cache miss; a cached NULL result is `null`
  const [s, t, y, g] = rkey(section, title, year, guid);
  const row = q('SELECT payload, fetched_at FROM resolved WHERE section=? AND title=? AND year=? AND guid=?').get(s, t, y, g);
  if (!row) return undefined;
  if (now() - Number(row.fetched_at) > RESOLVED_TTL_MS) return undefined;
  return JSON.parse(row.payload);
}

export async function putResolved(section, title, year, guid, payload) {
  if (!ready()) return;
  const [s, t, y, g] = rkey(section, title, year, guid);
  q(
    `INSERT INTO resolved (section, title, year, guid, payload, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(section, title, year, guid) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
  ).run(s, t, y, g, JSON.stringify(payload), now());
}

// --- collection_children --------------------------------------------------------------- //
const COLLECTION_TTL_MS = 24 * 60 * 60 * 1000;

export async function getCollectionChildren(rk, validator = null) {
  if (!ready()) return null;
  const row = q('SELECT * FROM collection_children WHERE rk = ?').get(String(rk));
  if (!row) return null;
  if (validator) {
    if (
      Number(row.updated_at) === Number(validator.updatedAt ?? -1) &&
      Number(row.child_count) === Number(validator.childCount ?? -1)
    ) {
      return JSON.parse(row.payload);
    }
    return null;
  }
  if (now() - Number(row.fetched_at) > COLLECTION_TTL_MS) return null;
  return JSON.parse(row.payload);
}

export async function putCollectionChildren(rk, { updatedAt, childCount, payload }) {
  if (!ready()) return;
  q(
    `INSERT INTO collection_children (rk, updated_at, child_count, payload, fetched_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(rk) DO UPDATE SET updated_at = excluded.updated_at, child_count = excluded.child_count,
       payload = excluded.payload, fetched_at = excluded.fetched_at`,
  ).run(String(rk), Number(updatedAt ?? 0), Number(childCount ?? 0), JSON.stringify(payload), now());
}

// --- section_listing (soft TTL, stale-while-revalidate) -------------------------------- //
const SECTION_SOFT_MS = 5 * 60 * 1000;

// Returns { payload, stale } or null. `stale` lets the caller serve it immediately AND kick a
// background refresh (the warmer does this).
export async function getSectionListing(section, type, account = '') {
  if (!ready()) return null;
  const row = q('SELECT payload, fetched_at FROM section_listing WHERE section=? AND type=? AND account=?').get(
    String(section),
    String(type),
    String(account || ''),
  );
  if (!row) return null;
  return { payload: JSON.parse(row.payload), stale: now() - Number(row.fetched_at) > SECTION_SOFT_MS };
}

export async function putSectionListing(section, type, account, payload) {
  if (!ready()) return;
  q(
    `INSERT INTO section_listing (section, type, account, payload, fetched_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(section, type, account) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
  ).run(String(section), String(type), String(account || ''), JSON.stringify(payload), now());
}

// Config mutation dropped the sections a set draws from → drop their listings so the next read
// reflects the change. Called from server.js's updateSet path.
export async function dropSectionListings(sections) {
  if (!ready()) return;
  const del = q('DELETE FROM section_listing WHERE section = ?');
  for (const s of [].concat(sections)) del.run(String(s));
}

// --- history (append-only, cursor-driven) ---------------------------------------------- //
export async function isWatched(account, section, ratingKey) {
  if (!ready()) return false;
  const row = q('SELECT 1 FROM history WHERE account=? AND section=? AND rating_key=?').get(
    String(account),
    String(section),
    String(ratingKey),
  );
  return Boolean(row);
}

// The whole watched set for (account, section) — one indexed SELECT, replacing the paged walk.
export async function watchedSet(account, section) {
  if (!ready()) return new Set();
  const rows = q('SELECT rating_key FROM history WHERE account=? AND section=?').all(String(account), String(section));
  return new Set(rows.map((r) => String(r.rating_key)));
}

// Insert history rows in ONE transaction (batched writes, per B1). Each row is
// {ratingKey, viewedAt}. Advances the cursor to the newest viewedAt seen.
export async function addHistory(account, section, rows) {
  if (!ready() || !rows.length) return;
  const ins = q(
    `INSERT INTO history (account, section, rating_key, viewed_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(account, section, rating_key) DO UPDATE SET viewed_at = excluded.viewed_at`,
  );
  let maxViewed = 0;
  db.exec('BEGIN');
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
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// The incremental fetch cursor: fetch …/history/all?…&sort=viewedAt:desc and stop at this
// timestamp. null = never fetched, do a full first-boot walk.
export async function historyCursor(account, section) {
  if (!ready()) return null;
  const row = q('SELECT last_viewed_at FROM history_cursor WHERE account=? AND section=?').get(String(account), String(section));
  return row ? Number(row.last_viewed_at) : null;
}

// A single watch just landed on the Shield (mqttc.onNowPlaying): record it directly, precise
// and free, and bump the generation so the browser's /api/queues ETag busts.
export async function recordWatch(account, section, ratingKey, viewedAt) {
  if (!ready()) return;
  await addHistory(account, section, [{ ratingKey, viewedAt: viewedAt || now() }]);
  await bumpGeneration();
}
