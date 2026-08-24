-- THE BOOK OF RECORD — /config/queuepilot.sqlite.
--
-- Decision 2026-08-23-sqlite-is-the-book-of-record-and-cache-sqlite-stays-derived: this file
-- holds what the household loses if the file is lost. `/config/cache.sqlite` is the DERIVED
-- Plex cache, is wiped on a schema bump and is safe to `rm`; nothing here may move there and
-- nothing there may move here. Two files, never one.
--
-- ── The one rule that outranks every other line in this file ──────────────────────────────
--
-- `sets.id`, `queues.set_id` and `groups.id` are WIRE IDS. An NFC card on the wall carries
-- one, and so does every Home Assistant MQTT `{"set": "<id>"}` payload. They are TEXT primary
-- keys, migrated verbatim out of the YAML, and no migration in this file's future may rewrite
-- one. A surrogate INTEGER key would have been the ordinary choice and it is the wrong one
-- here: it puts a translation table between a piece of cardboard and the queue it plays.
--
-- ── Why a `data` column, and why generated columns beside it ──────────────────────────────
--
-- A set carries 28 distinct keys across the live registry, several of them nested (`profiles`
-- is a list of mappings, `start` and `audio_language` are mappings). A column per key would be
-- 28 columns that WP-3 and WP-5 are about to renegotiate, and — worse — a key nobody thought
-- to promote would be dropped SILENTLY on the first write. So each row keeps its whole mapping
-- as JSON in `data`, in its original key order, and that column is the reconstruction source:
-- what went in comes back out, including a field this schema has never heard of.
--
-- The queryable columns are then GENERATED ALWAYS … VIRTUAL over that JSON. They are real
-- columns — `WHERE kind = 'picks'` works, an index on one works — and they CANNOT drift from
-- the payload, because SQLite computes them from it on every read. That is the property a
-- hand-maintained duplicate column does not have. `VIRTUAL` rather than `STORED` because these
-- tables are tens of rows and the read is the cheap direction.
--
-- This is deliberately NOT the end state. WP-3 (people) and WP-5 (queues keyed by people) are
-- what promote the fields they need into stored columns with foreign keys, once the shape is
-- settled — the plan's §5 says the content-type question is still open, and designing those
-- columns tonight would be guessing. What this schema fixes now is the part that is not in
-- doubt: the identity, the order, and the fact that a row is a row.
--
-- ── Comments ─────────────────────────────────────────────────────────────────────────────
--
-- `sets.yaml` and `queues.yaml` are hand-edited over SMB and carry 79 comment lines between
-- them. The storage decision accepts losing a comment that belongs to no row; in the event
-- none of them do, and all 79 survive. Four slots, because a comment can hang off four
-- different nodes and only the first two are obvious:
--
--   comment_before / comment       the block above the row, and the trailing one on its line
--   inner_comments                 the ones on a key INSIDE the mapping — `requires_profile:
--                                  x` and the note under it. These carry the operational
--                                  knowledge, and they were the four lines the first cut lost.
--   queues.list_comment_before     a comment between `demo:` and its first entry, which belongs
--                                  to the LIST and to neither the key nor the entry. One line
--                                  in the live file, and it was the last one still being lost.
--   store_meta                     whole-document comments, and the ones on a top-level key —
--                                  including the FILE HEADER, which `yaml` hands to the first
--                                  key rather than to the document when no blank line splits
--                                  them. sets.yaml's 1,733-character header is exactly that.

PRAGMA foreign_keys = ON;

-- ── Meta ─────────────────────────────────────────────────────────────────────────────────

-- Schema version and anything else about the FILE. Kept apart from `store_meta`, which is
-- about the four stores inside it.
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Per-store bookkeeping: the document-level YAML comments, the top-level keys that belong to
-- no row (`sets.yaml`'s `global:`), the write counter behind `revision()`, and the YAML
-- importer's fingerprint. `store` is one of 'sets' | 'queues' | 'groups' | 'pending'.
CREATE TABLE IF NOT EXISTS store_meta (
  store TEXT NOT NULL,
  key   TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (store, key)
) WITHOUT ROWID;

-- ── Sets — the registry ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sets (
  -- THE WIRE ID. Verbatim from sets.yaml, never rewritten.
  id             TEXT PRIMARY KEY,
  -- Shelf order on the Home page = the order of the `sets:` list in the file.
  position       INTEGER NOT NULL,
  -- The set's whole mapping, `id` included, as JSON in the file's own key order.
  data           TEXT NOT NULL CHECK (json_valid(data)),
  comment_before TEXT,
  comment        TEXT,
  -- The comments INSIDE the mapping, keyed by their path from this row's node. `comment_before`
  -- and `comment` cover the block above the row and the trailing one on its line; this covers
  -- the ones that explain a FIELD, which is where the operational knowledge in these files
  -- actually lives. Without it the live registry lost four comment lines and undo/redo lost its
  -- byte-for-byte restore.
  inner_comments TEXT CHECK (inner_comments IS NULL OR json_valid(inner_comments)),
  -- Derived, never written. `id` and `data.id` disagreeing is a corrupt row, so the CHECK
  -- below refuses it at the INSERT rather than letting a wire id drift from its payload.
  label          TEXT    GENERATED ALWAYS AS (json_extract(data, '$.label'))            VIRTUAL,
  kind           TEXT    GENERATED ALWAYS AS (json_extract(data, '$.kind'))             VIRTUAL,
  source         TEXT    GENERATED ALWAYS AS (json_extract(data, '$.source'))           VIRTUAL,
  add_as         TEXT    GENERATED ALWAYS AS (json_extract(data, '$.add_as'))           VIRTUAL,
  behavior       TEXT    GENERATED ALWAYS AS (json_extract(data, '$.behavior'))         VIRTUAL,
  requires_profile TEXT  GENERATED ALWAYS AS (json_extract(data, '$.requires_profile')) VIRTUAL,
  superseded_by  TEXT    GENERATED ALWAYS AS (json_extract(data, '$.superseded_by'))    VIRTUAL,
  CHECK (id = json_extract(data, '$.id'))
);

CREATE INDEX IF NOT EXISTS sets_position ON sets (position);
CREATE INDEX IF NOT EXISTS sets_source   ON sets (source);

-- ── Queues — the curated entry lists ─────────────────────────────────────────────────────

-- One row per top-level key in queues.yaml. It exists so a queue can be EMPTY and still be a
-- queue: `queues.yaml` carries `kevin_kids_anime:` with no entries under it, and a design that
-- inferred the queue from its entries would delete that line on the first write.
CREATE TABLE IF NOT EXISTS queues (
  -- The same wire id as `sets.id`. NOT a foreign key, deliberately: the two files have always
  -- been allowed to disagree — a queue whose set was deleted keeps its entries until somebody
  -- clears them, and the app has never treated that as corruption. A FK here would delete
  -- household data as a side effect of a set edit. WP-5 revisits it with the admin screen that
  -- makes the orphan visible first.
  set_id         TEXT PRIMARY KEY,
  position       INTEGER NOT NULL,
  -- On the KEY node: the block above `demo:` and the trailing comment on that line.
  comment_before TEXT,
  comment        TEXT,
  -- On the LIST node: a comment between `demo:` and its first entry, which belongs to neither
  -- the key nor the first entry and was the last comment line the projection was losing.
  list_comment_before TEXT,
  list_comment        TEXT
);

CREATE TABLE IF NOT EXISTS queue_entries (
  set_id         TEXT NOT NULL REFERENCES queues (set_id) ON DELETE CASCADE ON UPDATE CASCADE,
  -- Play order. TOP plays next, so this is the whole ordering contract of the app.
  position       INTEGER NOT NULL,
  -- The entry's mapping as JSON — `{ratingKey, title}`, `{collection}`, `{title}` plus any
  -- override (`episodes`, `weight`, `start`, `batch_stops_at`, `done`, `done_at`). A
  -- pre-2026-08-21 SCALAR entry is stored as a JSON string rather than an object; it is
  -- refused by `loadEntries` exactly as it is refused off the file, and it is not this
  -- schema's job to launder it.
  data           TEXT NOT NULL CHECK (json_valid(data)),
  comment_before TEXT,
  comment        TEXT,
  -- See `sets.inner_comments`.
  inner_comments TEXT CHECK (inner_comments IS NULL OR json_valid(inner_comments)),
  -- Derived. `rating_key` is TEXT on purpose: a Plex ratingKey is a numeric STRING, and
  -- node:sqlite THROWS RangeError on an INTEGER past 2^53 where better-sqlite3 quietly lost
  -- the precision (driver difference #5). Keeping the column TEXT means that difference can
  -- never reach this table. The declared affinity converts a legacy numeric key on the way out.
  rating_key     TEXT    GENERATED ALWAYS AS (json_extract(data, '$.ratingKey'))      VIRTUAL,
  title          TEXT    GENERATED ALWAYS AS (json_extract(data, '$.title'))          VIRTUAL,
  collection     TEXT    GENERATED ALWAYS AS (json_extract(data, '$.collection'))     VIRTUAL,
  done           INTEGER GENERATED ALWAYS AS (json_extract(data, '$.done'))           VIRTUAL,
  done_at        INTEGER GENERATED ALWAYS AS (json_extract(data, '$.done_at'))        VIRTUAL,
  episodes       INTEGER GENERATED ALWAYS AS (json_extract(data, '$.episodes'))       VIRTUAL,
  weight         REAL    GENERATED ALWAYS AS (json_extract(data, '$.weight'))         VIRTUAL,
  batch_stops_at TEXT    GENERATED ALWAYS AS (json_extract(data, '$.batch_stops_at')) VIRTUAL,
  PRIMARY KEY (set_id, position)
);

CREATE INDEX IF NOT EXISTS queue_entries_rating_key ON queue_entries (rating_key);
CREATE INDEX IF NOT EXISTS queue_entries_done       ON queue_entries (set_id, done);

-- ── Groups — who is watching ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS groups (
  -- THE WIRE ID again, and this one is a URL: `/g/<id>` is bookmarked.
  id             TEXT PRIMARY KEY,
  position       INTEGER NOT NULL,
  -- The group's whole mapping — `label`, the claimed `sets:` list, the `accounts:` provider
  -- map. `sets` and `accounts` stay inside the JSON rather than becoming child tables because
  -- WP-3 replaces this model outright: a group becomes a saved set of PEOPLE, and building
  -- `group_sets` / `group_accounts` tonight would be building the thing WP-3 then has to drop.
  data           TEXT NOT NULL CHECK (json_valid(data)),
  comment_before TEXT,
  comment        TEXT,
  -- See `sets.inner_comments`.
  inner_comments TEXT CHECK (inner_comments IS NULL OR json_valid(inner_comments)),
  label          TEXT GENERATED ALWAYS AS (json_extract(data, '$.label')) VIRTUAL,
  CHECK (id = json_extract(data, '$.id'))
);

CREATE INDEX IF NOT EXISTS groups_position ON groups (position);

-- ── Pending — the two decisions the Pending screen stores ────────────────────────────────

-- A singleton. The CHECK is what makes it one: a second row cannot be inserted, so no code
-- path has to remember to UPDATE rather than INSERT.
CREATE TABLE IF NOT EXISTS pending_state (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  -- Epoch SECONDS, matching Plex's own addedAt.
  seen_through INTEGER NOT NULL DEFAULT 0,
  -- The INCLUDE list of Plex section ids as a JSON array, or NULL for "nobody has chosen".
  -- NULL and `[]` are different answers and the column keeps them different — `[]` means no
  -- libraries at all, and is a page the owner can choose.
  libraries    TEXT CHECK (libraries IS NULL OR json_valid(libraries))
);

CREATE TABLE IF NOT EXISTS pending_dismissed (
  -- Per ITEM on purpose: skipping one film must not hide everything added after it.
  rating_key TEXT PRIMARY KEY,
  position   INTEGER NOT NULL
);

-- ── Lead cooldowns — folded in from /config/promote.sqlite ───────────────────────────────
--
-- decision 2026-08-23-promote-sqlite-folds-into-the-book-of-record. This was a third durable
-- SQLite file whose rows are keyed by (set id, entry key) — that is, by the primary keys of
-- the two tables above it. It had shipped in code but had never been created on disk, so the
-- fold cost zero rows to migrate; it will never be that cheap again.
--
-- No FOREIGN KEY on `set_id` yet. Through the bridge release the app may run with
-- STORE_BACKEND=yaml, where `sets` is empty and every cooldown row would be refused. The FK
-- lands in the same change that removes the YAML reader.
CREATE TABLE IF NOT EXISTS lead_cooldown (
  set_id    TEXT NOT NULL,
  entry_key TEXT NOT NULL,
  -- Unix epoch SECONDS.
  led_at    INTEGER NOT NULL,
  PRIMARY KEY (set_id, entry_key)
);

CREATE INDEX IF NOT EXISTS lead_cooldown_led_at ON lead_cooldown (led_at);
