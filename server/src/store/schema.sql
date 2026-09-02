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
--   presentation                   the ones on a key INSIDE the mapping — `requires_profile:
--                                  x` and the note under it. These carry the operational
--                                  knowledge, and they were the four lines the first cut lost.
--                                  The same column records HOW each node was written, so a
--                                  hand-typed `- {title: "X"}` is not rewritten as block.
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
-- importer's fingerprint. `store` is one of 'sets' | 'queues' | 'groups' | 'pending' |
-- 'people' — the last of which has no YAML file and uses this only for the version counter
-- and the people-mapping fingerprint.
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
  -- Everything about the row that is not its value, keyed by the path from this row's node:
  -- the comments attached to a key INSIDE the mapping, and how each node was written (flow vs
  -- block, and a scalar's quoting). `comment_before` and `comment` cover the block above the
  -- row and the trailing one on its line; this covers the rest. Without it the live registry
  -- lost four comment lines and every hand-typed flow entry in `queues.yaml` would be
  -- rewritten as block on the first save.
  presentation TEXT CHECK (presentation IS NULL OR json_valid(presentation)),
  -- Derived, never written. `id` and `data.id` disagreeing is a corrupt row, so the CHECK
  -- below refuses it at the INSERT rather than letting a wire id drift from its payload.
  label          TEXT    GENERATED ALWAYS AS (json_extract(data, '$.label'))            VIRTUAL,
  kind           TEXT    GENERATED ALWAYS AS (json_extract(data, '$.kind'))             VIRTUAL,
  source         TEXT    GENERATED ALWAYS AS (json_extract(data, '$.source'))           VIRTUAL,
  add_as         TEXT    GENERATED ALWAYS AS (json_extract(data, '$.add_as'))           VIRTUAL,
  behavior       TEXT    GENERATED ALWAYS AS (json_extract(data, '$.behavior'))         VIRTUAL,
  requires_profile TEXT  GENERATED ALWAYS AS (json_extract(data, '$.requires_profile')) VIRTUAL,
  superseded_by  TEXT    GENERATED ALWAYS AS (json_extract(data, '$.superseded_by'))    VIRTUAL,
  -- WP-5. WHAT YOU ARE DOING — 'watching' | 'reading' | 'video-games' | 'board-games'. It is
  -- the ACTIVITY and not a finer content list: "Anime" and "Movies" are two queues under one
  -- activity, told apart by what is in them
  -- (decision 2026-08-25-a-queue-is-people-plus-an-activity §1). A finer list was rejected
  -- because it puts one queue under two headings.
  --
  -- NULL is the normal state and is not missing data: the activity is DERIVED from the set's
  -- provider (`server/src/activity.ts`), and that derivation is exact for every provider this
  -- app has. The column holds only the override somebody typed, so migration day writes no
  -- bytes to `sets.yaml` at all.
  activity       TEXT    GENERATED ALWAYS AS (json_extract(data, '$.activity'))         VIRTUAL,
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
  list_comment        TEXT,
  -- Everything about those two nodes that is not a comment — chiefly the BLANK LINE above
  -- `demo:`, which is how a 782-line file separates one queue from the next.
  presentation        TEXT CHECK (presentation IS NULL OR json_valid(presentation))
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
  -- See `sets.presentation`.
  presentation TEXT CHECK (presentation IS NULL OR json_valid(presentation)),
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

-- Queue-owned episode history. This is deliberately separate from Plex history: one person
-- can watch later episodes under the same Plex profile while a different queue continues its
-- own run from an earlier point. `entry_key` is the stable line identity every queue mutation
-- uses — `id:…` when the entry carries one, else `rk:…`, else `title:…`. It names ONE line, so
-- two lines for the same file (a queue that holds it twice) get two independent runs with no
-- schema change. A start-point reset deletes this entry's rows and begins a new run.
CREATE TABLE IF NOT EXISTS queue_entry_history (
  set_id       TEXT NOT NULL,
  entry_key    TEXT NOT NULL,
  item_key     TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  -- Existing rows predate position tracking and are completed rows, hence DEFAULT 1.
  is_completed INTEGER NOT NULL DEFAULT 1 CHECK (is_completed IN (0, 1)),
  position_ms  INTEGER NOT NULL DEFAULT 0,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (set_id, entry_key, item_key)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS queue_entry_history_entry
  ON queue_entry_history (set_id, entry_key, completed_at);

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
  -- See `sets.presentation`.
  presentation TEXT CHECK (presentation IS NULL OR json_valid(presentation)),
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

-- ── People — the household, and the identity the absorb needs ────────────────────────────
--
-- WP-3. The decision (2026-08-22-queuepilot-absorbs-board-game-picker-tonight-pick §6) says to
-- EXTEND groups rather than invent a second identity system, so this is not a parallel model:
-- a PERSON is the human, and a GROUP becomes a SAVED SET OF PEOPLE — a one-tap shortcut on the
-- Tonight form. The group keeps its wire id, its label and its `sets:` claim list; what it
-- gains is `group_people`.
--
-- ── Why real columns here, and JSON above ────────────────────────────────────────────────
--
-- `sets` and `groups` keep their whole mapping in `data` because they are projections of a
-- HAND-EDITED YAML file, where a key nobody thought to promote must survive the round trip.
-- People have no file and no hand-edited source — they arrive from Board Game Picker's
-- `players` table and from this app's own editor — so there is nothing to lose and a column is
-- the honest shape. This is the promotion the `sets` header says WP-3 would do.
--
-- ── The rule that outranks the rest of this section ──────────────────────────────────────
--
-- IDENTITY MATCH IS MANUAL, NEVER FUZZY. Board Game Picker knows a player by display name;
-- this app knows the same human by a Plex account and a Kavita account that spell him
-- differently. A name-matching heuristic that gets that wrong writes the wrong person's
-- "knows the rules" claim, which is a per-person fact a play may RENEW and must never INVENT
-- (board-games 2026-08-17-knowing-the-rules-is-a-per-person-fact-not-a-play-count). So the
-- import reads an owner-confirmed mapping file and refuses to run without one —
-- `store/migrate/people.ts`.

CREATE TABLE IF NOT EXISTS people (
  -- A WIRE ID, like `sets.id` and `groups.id`, and for the same reason: it is a URL. Immutable
  -- once created; the display name is what a rename changes.
  id           TEXT PRIMARY KEY,
  -- Roster order, the way `sets.position` is shelf order. Not an identity.
  position     INTEGER NOT NULL DEFAULT 0,
  display_name TEXT NOT NULL DEFAULT '',
  -- Board Game Picker's three per-person picker fields, ported with their own names.
  -- `birth_year` rather than an age, because an age is wrong within a year of being written.
  birth_year   INTEGER CHECK (birth_year IS NULL OR birth_year BETWEEN 1900 AND 2200),
  -- The heaviest game this person will sit down to, on BoardGameGeek's 1–5 weight scale.
  -- NULL is "no ceiling stated", which is NOT the same as 5 — the picker treats the two
  -- differently, so the column keeps them different.
  max_weight   REAL CHECK (max_weight IS NULL OR (max_weight > 0 AND max_weight <= 5)),
  -- `is_beginner`, not `beginner`: a boolean carries an `is`/`has` prefix (house rule).
  is_beginner  INTEGER NOT NULL DEFAULT 0 CHECK (is_beginner IN (0, 1)),
  -- Provenance, and the reason the import is idempotent. `source` is 'board-game-picker' for a
  -- migrated player and NULL for a person created here; `source_id` is that player's uuid. A
  -- second run of the import finds the row by (source, source_id) and updates it rather than
  -- writing a twin under a different id.
  source       TEXT,
  source_id    TEXT,
  -- ISO 8601. Nullable because a person created before this column existed has no honest
  -- answer, and inventing `now` would make an old row look new.
  created_at   TEXT
);

CREATE INDEX IF NOT EXISTS people_position ON people (position);
-- Partial, so the many rows with no provenance do not collide on (NULL, NULL).
CREATE UNIQUE INDEX IF NOT EXISTS people_source_id ON people (source, source_id)
  WHERE source_id IS NOT NULL;

-- The provider account map — exactly what `groups.yaml`'s `accounts:` holds, one row per
-- (person, provider kind, account name). A child table rather than a JSON column because this
-- is the join the whole feature exists for: Plex knows a person by one handle, Kavita knows the
-- same human by another, and "show me everything of theirs" is a lookup BY ACCOUNT.
--
-- N-to-M in both directions, and both directions are real: one person may hold two Plex
-- accounts, and two people may share one.
CREATE TABLE IF NOT EXISTS person_accounts (
  person_id   TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE ON UPDATE CASCADE,
  -- Lower-cased provider kind: 'plex', 'kavita', …
  kind        TEXT NOT NULL,
  -- The account name as the PROVIDER spells it, verbatim. Never normalised on the way in —
  -- it is shown back to the person who typed it.
  account     TEXT NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  -- The match key. `groups.ts` has always compared account names case-insensitively, because a
  -- Plex handle and a Kavita display name are typed by hand into a YAML file and a capital
  -- letter is not a different person. Generated rather than stored so it cannot drift.
  account_key TEXT GENERATED ALWAYS AS (lower(trim(account))) VIRTUAL,
  PRIMARY KEY (person_id, kind, account)
);

CREATE INDEX IF NOT EXISTS person_accounts_lookup ON person_accounts (kind, account_key);

-- Which people a group stands for — the "saved set of people" half of the decision.
--
-- ⚠️ NO FOREIGN KEY ON `group_id`, and this one is not a bridge-release compromise like
-- `lead_cooldown`'s. `store/db/groups.ts writeDoc()` and the YAML importer both replace the
-- whole `groups` table with DELETE + INSERT on EVERY write, so an `ON DELETE CASCADE` here
-- would silently empty every group's roster the next time anybody renamed a group. The
-- membership is repaired by the importer and reported by `store/db/people.ts orphanGroupIds()`,
-- never enforced by a constraint that deletes household data as a side effect.
CREATE TABLE IF NOT EXISTS group_people (
  group_id  TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE ON UPDATE CASCADE,
  position  INTEGER NOT NULL DEFAULT 0,
  -- WP-5. 'required' | 'optional', and it is what `groups.min_present` counts.
  --
  -- The rule the owner asked for is "at least one of these two, and this third may join", and
  -- that is TWO facts about one roster, not one: which people the count is over, and how many
  -- of them are enough. So the roster carries the role and the group carries the number. A
  -- group with three required people and `min_present` NULL means all three, which is what
  -- every group written before this column meant.
  --
  -- Defaulted to 'required' so an existing row keeps its meaning when this column is ALTERed
  -- in: before WP-5 a roster member was simply a member, and "a member is required" is the
  -- reading that changes nothing.
  role      TEXT NOT NULL DEFAULT 'required' CHECK (role IN ('required', 'optional')),
  PRIMARY KEY (group_id, person_id)
);

CREATE INDEX IF NOT EXISTS group_people_person ON group_people (person_id);

-- HOW MANY of a group's required people are enough — the other half of "at least one of them".
--
-- ── Why a table of its own, and not a column on `groups` ─────────────────────────────────
--
-- Because `store/db/groups.ts writeDoc()` replaces the whole `groups` table with DELETE +
-- INSERT on every write. A real column there would be wiped the next time anybody renamed a
-- group — the same trap `group_people` sits beside, and the same answer.
--
-- ── Why it is not in `groups.yaml` either ────────────────────────────────────────────────
--
-- The first cut of WP-5 put it in the group's mapping so it would survive the YAML rollback.
-- That was wrong and it was wrong in an obvious way once written down: the ROSTER the number
-- counts over lives only in `group_people`, which has no YAML twin at all (WP-3 —
-- "people arrived after the cutover and have never had a file"). A file carrying
-- `min_present: 1` next to no people is a rule nobody can read. The number belongs with the
-- roster.
--
-- One row per group, and only for a group that has a rule. An ABSENT row means "all of the
-- required roster", which is what every group written before WP-5 meant — the absence is not
-- defaulted to 1, the same discipline `people.max_weight` and `pending.libraries` carry.
--
-- No foreign key on `group_id`, for the DELETE + INSERT reason above.
CREATE TABLE IF NOT EXISTS group_membership (
  group_id    TEXT PRIMARY KEY,
  min_present INTEGER NOT NULL CHECK (min_present >= 1)
) WITHOUT ROWID;

-- ── Queue people — WP-5, and the reason a queue no longer needs a name ───────────────────
--
-- A QUEUE IS REQUIRED PEOPLE + OPTIONAL PEOPLE + ONE ACTIVITY
-- (decision 2026-08-25-a-queue-is-people-plus-an-activity). Every movies queue is called
-- "Movies"; what tells two of them apart is the row of faces on the card. There is no
-- generated name, no override and no separator — all three were drawn in the mockup and none
-- of them ship.
--
-- ── Why a member may be a GROUP and not only a person ────────────────────────────────────
--
-- Because a kids group is one card in a tray and carries its own count. Flattening it to its
-- people at write time would lose the rule — the queue would then say "both of them", and the
-- whole point is that EITHER of them is enough. So the queue points at the group and inherits
-- `min_present`.
--
-- ⚠️ A group used this way must still resolve to EXACTLY ONE provider profile at play time,
-- or the two `requires_profile` queues break: a queue gated on the Older Kids Plex profile
-- signs into that profile no matter which of the kids turned up. `server/src/queuePeople.ts
-- groupPlayProfile()` is that resolution and `PUT /api/sets/:id/people` refuses a member that
-- cannot answer it.
--
-- ── No foreign keys, for two different reasons ───────────────────────────────────────────
--
-- `set_id` follows `queues.set_id` and `lead_cooldown.set_id`: the registry and its
-- neighbours have always been allowed to disagree, and a cascade here would delete a queue's
-- audience as a side effect of a set edit. `member_id` cannot have one at all — it names a
-- row in `people` OR in `groups`, and `groups` is replaced wholesale by DELETE + INSERT on
-- every write, which is the same trap `group_people` documents above. `orphanQueueMembers()`
-- in `store/db/queuePeople.ts` reports instead.
CREATE TABLE IF NOT EXISTS queue_people (
  set_id      TEXT NOT NULL,
  -- 'person' | 'group'. Part of the key, so a person and a group that happen to share an id
  -- are two different members rather than one row overwriting the other.
  member_kind TEXT NOT NULL CHECK (member_kind IN ('person', 'group')),
  member_id   TEXT NOT NULL,
  -- 'required' = the Must be here tray, 'optional' = Nice to have. The two trays ARE this
  -- column; there is no third value, because "Everyone else" is the absence of a row.
  role        TEXT NOT NULL DEFAULT 'required' CHECK (role IN ('required', 'optional')),
  position    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (set_id, member_kind, member_id)
);

CREATE INDEX IF NOT EXISTS queue_people_member ON queue_people (member_kind, member_id);
CREATE INDEX IF NOT EXISTS queue_people_role   ON queue_people (set_id, role);

-- ── Board games — the absorbed collection ────────────────────────────────────────────────
--
-- WP-4b. Twelve tables out of Board Game Picker's fifteen: `players`, `groups` and
-- `group_players` do NOT appear here, because they merged into `people` / `groups` /
-- `group_people` above rather than arriving as a second identity system.
--
-- ── Why every one of them carries a `board_game_` prefix ─────────────────────────────────
--
-- Exactly ONE of the fifteen literally collides with a table above: `groups`. The prefix is
-- not about that collision, it is about the ones that have not happened yet. A bare `games`
-- table meaning *board-game titles* is a name the Steam and MiSTer work will fight over inside
-- this same file; `categories` is the most generic name in a schema that also has to hold Plex
-- and Kavita content; and `plays` reads as "a play of anything" the first time somebody logs a
-- film. Renaming was free at the copy and is never free again.
--
-- ── The shape came from the LIVE database, not from the source repo's schema file ────────
--
-- `PRAGMA table_xinfo` on the running collection, table by table — and that is not pedantry.
-- `game_overrides.is_excluded_source` EXISTS in the live data and is absent from the source
-- repo's `schema.sql`: it was added by an additive-column list and never written back. A copy
-- built from the file would have dropped it and merged the rows an owner excluded BY HAND with
-- the ones a scheduled sync removed — and the next sync would then silently re-offer every one
-- of the hand-excluded titles. It is the only column that had drifted. The shape was read off
-- the live file anyway, because the class of bug is what matters and not the one instance.
--
-- ── TEXT for an id, REAL for a measurement, INTEGER for arithmetic ───────────────────────
--
-- `bgg_id` and `listing_bgg_id` are TEXT. They are identifiers and are never added up, and
-- `queue_entries.rating_key` set the precedent for exactly this reason: node:sqlite THROWS
-- `RangeError` on an INTEGER past 2^53 where the old driver quietly lost the precision (WP-4a
-- difference #5). Today's largest is six digits, so the difference cannot bite yet — there is
-- simply no reason to hold two rules about the same kind of value. `store/db/boardgames.ts`
-- converts to `number` at ONE boundary, because the ported engine's `Game.bggId` is a number.
--
-- `weight` and `rating` stay REAL — both are compared and averaged. Ages, playtimes and player
-- counts stay INTEGER — all of them are arithmetic.
--
-- ── No `data` blob and no generated columns here ─────────────────────────────────────────
--
-- `sets`, `queues` and `groups` keep their whole mapping as JSON because they are projections
-- of a HAND-EDITED file where a key nobody thought to promote must survive the round trip.
-- These twelve are already normalised, with settled columns, and have never had a file behind
-- them. Copying the JSON-blob pattern here would be cargo cult. Same answer `people` gave.
--
-- ── Nothing here is seeded by this file ──────────────────────────────────────────────────
--
-- The source repo seeds one `categories` row with an `INSERT OR IGNORE` inside its own schema
-- file, and gets away with it only because nobody has ever deleted that row. `open.ts` runs
-- this whole file on EVERY open, so a seeded row would resurrect itself on the first restart
-- after the owner removed it. Seeding belongs to the one-shot migration
-- (`store/migrate/boardgames.ts`) and to nothing else.

-- A TITLE. Not a box — one title is often several physical boxes on a shelf, and collapsing
-- the shelf into a list of playable things is the whole point of the app this came from.
CREATE TABLE IF NOT EXISTS board_games (
  id                       TEXT PRIMARY KEY,
  name                     TEXT NOT NULL,
  -- The box claim, recorded but never filtered on alone: a lid saying "2–5" is a
  -- manufacturing statement. `best_with` / `recommended_with` are the community's verdict and
  -- are what the picker actually reads.
  min_players              INTEGER NOT NULL,
  max_players              INTEGER NOT NULL,
  -- JSON arrays of player counts. An empty array, never NULL.
  best_with                TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(best_with)),
  recommended_with         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(recommended_with)),
  -- 1.0–5.0 complexity. NULL is unknown and is NOT 0 — a 0 here would read as "trivial" and
  -- win every complexity filter it should have failed.
  weight                   REAL,
  min_playtime             INTEGER,
  max_playtime             INTEGER,
  min_age                  INTEGER,
  -- JSON array. A game is often several of these at once — a co-op box with a solo mode is
  -- both — so a single column would have to pick a winner and hide the rest.
  interaction_types        TEXT NOT NULL DEFAULT '["competitive"]' CHECK (json_valid(interaction_types)),
  -- 'import' | 'owner' | 'derived'. A guess that cannot be told apart from a fact is how a
  -- collection loses the owner's trust, so every derived value carries where it came from.
  interaction_types_source TEXT NOT NULL DEFAULT 'derived',
  -- The upstream's own auto tags: a palette, not the truth. The owner's own tags are rows in
  -- `board_game_category_members`.
  categories               TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(categories)),
  publishers               TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(publishers)),
  year_published           INTEGER,
  -- TEXT — see the header. Nullable by design: a game need not exist on any external listing.
  bgg_id                   TEXT,
  rating                   REAL,
  source                   TEXT NOT NULL DEFAULT 'import',
  -- Served from this app's own origin, never hotlinked. The files live beside the book of
  -- record in `/config/board-game-images/` and are NOT a cache — 32 of them are covers the
  -- owner picked by hand, and the upstream has turned access off before.
  image_path               TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS board_games_name ON board_games (name COLLATE NOCASE);

-- A PHYSICAL THING ON A SHELF. This is what you get up and fetch.
CREATE TABLE IF NOT EXISTS board_game_boxes (
  id                TEXT PRIMARY KEY,
  game_id           TEXT NOT NULL REFERENCES board_games (id) ON DELETE CASCADE ON UPDATE CASCADE,
  label             TEXT NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'standalone' CHECK (kind IN ('standalone', 'expansion')),
  bgg_id            TEXT,
  -- The inventory-app link the schema was designed around and which has never been used: 0 of
  -- 562 rows carry either. Carried anyway, because the ported engine keeps the field name and
  -- renaming it would be a schema change rather than a port.
  homebox_entity_id TEXT,
  location_text     TEXT,
  image_path        TEXT,
  version_nickname  TEXT,
  version_year      INTEGER,
  version_languages TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(version_languages)),
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS board_game_boxes_game ON board_game_boxes (game_id);

-- THE OWNER'S LAYER ON TOP OF AN IMPORTED TITLE. One row per game, and it is nearly empty:
-- every scalar override is unset on all but a handful of rows. What it really holds is an
-- exclusion flag and 32 hand-picked covers, so do not read it as "147 hand-tuned games".
CREATE TABLE IF NOT EXISTS board_game_overrides (
  game_id            TEXT PRIMARY KEY REFERENCES board_games (id) ON DELETE CASCADE ON UPDATE CASCADE,
  min_players        INTEGER,
  max_players        INTEGER,
  best_with          TEXT CHECK (best_with IS NULL OR json_valid(best_with)),
  recommended_with   TEXT CHECK (recommended_with IS NULL OR json_valid(recommended_with)),
  weight             REAL,
  min_age            INTEGER,
  interaction_types  TEXT CHECK (interaction_types IS NULL OR json_valid(interaction_types)),
  -- "Owned, but never offer it to me."
  is_excluded        INTEGER CHECK (is_excluded IS NULL OR is_excluded IN (0, 1)),
  -- ⚠️ THE COLUMN THIS WHOLE MIGRATION WAS SHAPED AROUND. 'owner' when a human took the game
  -- off the shelf, 'sync' when an upstream refresh removed it. A sync may take back its OWN
  -- removal and must NEVER take back the owner's, so losing this merges the two and the next
  -- sync silently re-offers every title the owner excluded by hand. It is absent from the
  -- source repo's schema file and present in the source repo's database; the copy was built
  -- from `PRAGMA table_xinfo` for exactly this reason.
  is_excluded_source TEXT CHECK (is_excluded_source IS NULL OR is_excluded_source IN ('owner', 'sync')),
  notes              TEXT,
  -- An owner-picked cover. Wins over the imported one and over the first box that has art.
  image_path         TEXT,
  updated_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS board_game_overrides_excluded
  ON board_game_overrides (is_excluded, is_excluded_source);

-- A WAY OUT OF THE APP and into something that explains the game you were just handed.
--
-- Nothing here names a video site or a rulebook host. One deployment's rulebooks sit in a
-- comics library and its how-to-play videos on a streaming site; the next has neither. So the
-- app stores A URL, and a *linker* is an optional, replaceable thing that fills them in.
CREATE TABLE IF NOT EXISTS board_game_links (
  id         TEXT PRIMARY KEY,
  game_id    TEXT NOT NULL REFERENCES board_games (id) ON DELETE CASCADE ON UPDATE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('rulebook', 'howToPlay', 'reference')),
  -- What the button says.
  label      TEXT NOT NULL,
  url        TEXT NOT NULL,
  -- 'owner' is typed by hand and no linker ever touches it; 'derived' was written by one and
  -- the same linker may replace it on its next run.
  source     TEXT NOT NULL DEFAULT 'owner' CHECK (source IN ('owner', 'derived')),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS board_game_links_game ON board_game_links (game_id);
CREATE UNIQUE INDEX IF NOT EXISTS board_game_links_url ON board_game_links (game_id, url);

-- ONE WAY TO PLAY a game — a module, a deck set, a campaign arc. Empty today, and not dead:
-- the feature is complete and seeding it is opt-in per game, which nobody has switched on.
--
-- `is_hidden` from the source table is DELIBERATELY ABSENT. Its own comment there says it is
-- vestigial, that nothing reads or writes it, and that it survives only because that app's
-- column list is additive-only and dropping a column from a deployed database unattended at
-- every startup is not a thing an app gets to do. This is a fresh CREATE in a different file,
-- so that constraint does not follow it — and this was the one moment it could leave without
-- an unattended ALTER. Confirmed before dropping: zero references in that app's source outside
-- one test comment.
CREATE TABLE IF NOT EXISTS board_game_modules (
  id         TEXT PRIMARY KEY,
  game_id    TEXT NOT NULL REFERENCES board_games (id) ON DELETE CASCADE ON UPDATE CASCADE,
  name       TEXT NOT NULL,
  -- 'derived' was seeded from an expansion box and a re-derive may rename it; 'owner' was
  -- typed by hand and nothing automated touches it.
  source     TEXT NOT NULL DEFAULT 'owner' CHECK (source IN ('owner', 'derived')),
  -- The box it came from, when it came from one. No FOREIGN KEY: a box can leave the shelf
  -- while the way of playing it taught stays true, and a cascade would delete the owner's row
  -- as a side effect of a re-import.
  box_id     TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS board_game_modules_game ON board_game_modules (game_id);
CREATE UNIQUE INDEX IF NOT EXISTS board_game_modules_name ON board_game_modules (game_id, name);

-- THE OWNER'S OWN CATEGORY VOCABULARY, separate from the upstream's auto tags on
-- `board_games.categories`. One row today, and the membership table below is empty: a feature
-- the owner asked for by name and then did not use. Not seeded here — see the header.
CREATE TABLE IF NOT EXISTS board_game_categories (
  name       TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS board_game_category_members (
  game_id TEXT NOT NULL REFERENCES board_games (id) ON DELETE CASCADE ON UPDATE CASCADE,
  name    TEXT NOT NULL REFERENCES board_game_categories (name) ON DELETE CASCADE ON UPDATE CASCADE,
  PRIMARY KEY (game_id, name)
);

CREATE INDEX IF NOT EXISTS board_game_category_members_game ON board_game_category_members (game_id);

-- ── The grouping rules — the largest hand-made artifact in the collection ────────────────
--
-- decision 2026-08-23-the-collections-grouping-rules-are-rows-not-source. The rules that
-- collapse a shelf of boxes into a list of playable titles are DATA. This repo keeps the
-- algorithm and this table shape; the CONTENTS live in `/config/queuepilot.sqlite` and in the
-- seed file beside it, and never in git. A fresh container starts with this table EMPTY, which
-- is not broken: the algorithm decides most of a collection with no rule at all, and reports
-- the ones it cannot decide rather than guessing.
--
-- TWO KINDS OF ROW, and the CHECK is what keeps them apart:
--
--   `box_label`  an OWNER row. "This exact box is that title." Written by the Collection
--                screen, one row per physical box label.
--   `prefix`     a SEEDED row. "Every box whose title starts with this is one title." One row
--                per prefix — a rule with two spellings of the same franchise is two rows.
--
-- `prefix` is a LITERAL, already in comparison form (lower case, punctuation and dashes folded
-- to single spaces), and the store never compiles a pattern out of a text column. The match is
-- `normalized === prefix || normalized.startsWith(prefix + ' ')` — a word boundary, so a rule
-- for one word does not swallow a longer word that merely starts the same way.
--
-- `source` is the column that cannot be added later without guessing which existing rows were
-- which. Without it a re-run doubles a merge, or an unattended re-seed reverses a correction —
-- and neither is visible until a title quietly stops being offered.
--
-- THE REASON FOR A RULE IS NOT A COLUMN. Each of these rulings already has a dated decision
-- record in the private workspace repo. A `reason` column would be a second, worse copy of an
-- argument that already exists somewhere better. The row is the ruling; the record is why.
CREATE TABLE IF NOT EXISTS board_game_groupings (
  box_label               TEXT,
  prefix                  TEXT,
  -- The single literal a matching box must NOT contain to stay in the family. One rule in the
  -- seed uses it. Owner rows never do — they name one box and have nothing to escape.
  except_contains         TEXT,
  game_id                 TEXT NOT NULL,
  game_name               TEXT NOT NULL,
  -- The external listing for the resulting title, used when no owned box IS that listing.
  -- TEXT for the same reason as `board_games.bgg_id`.
  listing_bgg_id          TEXT,
  -- Create this title even though every box that matched is flagged as an expansion upstream.
  -- Some things are an expansion by a taxonomy and a separate game on the owner's shelf.
  is_game_from_expansions INTEGER NOT NULL DEFAULT 0 CHECK (is_game_from_expansions IN (0, 1)),
  -- First match wins among the prefix rules, so the source order is part of the answer and not
  -- a presentation detail. Owner rows name one box each and never compete.
  position                INTEGER NOT NULL DEFAULT 0,
  source                  TEXT NOT NULL DEFAULT 'owner' CHECK (source IN ('owner', 'migration')),
  created_at              TEXT NOT NULL,
  -- Exactly one of the two, never both and never neither.
  CHECK ((box_label IS NULL) <> (prefix IS NULL))
);

-- Partial, because the other kind of row is NULL there and NULLs would all collide.
CREATE UNIQUE INDEX IF NOT EXISTS board_game_groupings_box_label
  ON board_game_groupings (box_label) WHERE box_label IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS board_game_groupings_prefix
  ON board_game_groupings (prefix) WHERE prefix IS NOT NULL;
CREATE INDEX IF NOT EXISTS board_game_groupings_source ON board_game_groupings (source, position);

-- "IS THIS REALLY ITS OWN TITLE?" — the question the grouping pass raises, and the owner's
-- answer to it. A row with a `reviewed_at` is answered and never asked again; a row without
-- one is still on the review list.
--
-- The seeded rows are the same ruling made in source by an agent editing the importer, which
-- the source app's own comment already said out loud. They arrive with `status =
-- 'confirmedSeparate'` and `source = 'migration'`, and their `box_label` is the COMPARISON
-- FORM of the title rather than a label off a lid — which is what the algorithm matched
-- against, and which is stable under the same normalisation the owner rows go through.
--
-- ⚠️ SO THE TWO KINDS OF ROW DO NOT COLLIDE ON THIS PRIMARY KEY, and a seed must NOT rely on
-- `ON CONFLICT` to leave an owner's answer alone: `Tidewright Expeditions` and
-- `tidewright expeditions` are two different strings and one open question. `seedReviews()`
-- compares the NORMALISED form of both in code before it inserts, and that is what actually
-- stops a seed answering a question the owner deliberately left open.
CREATE TABLE IF NOT EXISTS board_game_grouping_reviews (
  box_label      TEXT PRIMARY KEY,
  -- Where it landed anyway, if anywhere.
  game_id        TEXT,
  -- The title it was NEARLY filed under — the one whose prefix it shares. Carried because
  -- answering "yes, one game" is a merge, and a merge needs a survivor: without it the screen
  -- can only offer to merge into the NEW title, which keeps the wrong id and the wrong
  -- listing.
  parent_game_id TEXT,
  -- One line, because `open.ts addMissingColumns()` parses this file one column per line and
  -- would otherwise re-add the column without its CHECK.
  status         TEXT NOT NULL CHECK (status IN ('orphan', 'ambiguous', 'possibleEdition', 'distinctAfterNormalizing', 'confirmedSeparate')),
  -- The sentence shown to a person, written by the pass that raised the question.
  reason         TEXT,
  reviewed_at    TEXT,
  source         TEXT NOT NULL DEFAULT 'owner' CHECK (source IN ('owner', 'migration'))
);

CREATE INDEX IF NOT EXISTS board_game_grouping_reviews_open
  ON board_game_grouping_reviews (reviewed_at, status);

-- ── The play log, and the two tables keyed on a PERSON ───────────────────────────────────

-- ONE SITTING.
--
-- ⚠️ A PLAY WITH NOBODY AT THE TABLE IS NORMAL HERE, AND THE MIGRATION CARRIES IT ACROSS AS IT
-- FOUND IT. Every play in the source arrived through the deliberately anonymous door — the
-- landing another app hands you when you are already standing at a table — so
-- `board_game_play_people` is EMPTY while this table is not. Whether every one of those is the
-- door working as designed or a writer that should have recorded participants is an open
-- question about the SOURCE app, being answered elsewhere; it is not this migration's to
-- settle.
--
-- What IS this migration's, and is absolute: **do not invent a participant row to make the
-- data look consistent, and never back-fill one from another table.** A play must not create a
-- known-how claim. `board_game_known_how` below says why — the claim is a thing a person
-- states, and the two facts are separate on purpose.
--
-- No row count is written down here on purpose. The source app is still live and still logging
-- plays, so a number in this comment is wrong within a week; the counts that matter are the
-- ones the migration asserts against the source at run time.
CREATE TABLE IF NOT EXISTS board_game_plays (
  id        TEXT PRIMARY KEY,
  game_id   TEXT NOT NULL REFERENCES board_games (id) ON DELETE CASCADE ON UPDATE CASCADE,
  -- ISO 8601.
  played_at TEXT NOT NULL,
  notes     TEXT
);

CREATE INDEX IF NOT EXISTS board_game_plays_game ON board_game_plays (game_id, played_at);

-- ⚠️ `person_id` ON THE NEXT TWO TABLES HOLDS AN UNRESOLVED ID UNTIL THE PEOPLE IMPORT RUNS,
-- and that is deliberate rather than a gap.
--
-- The people import is GATED on an owner-confirmed mapping file and has not been applied, so
-- `people` is empty. A migration that waited for it would have to hold the collection hostage
-- to a decision about identity; a migration that invented person ids would write the wrong
-- person's claim, which is the one thing the whole people package exists to prevent. So the
-- rows arrive holding the SOURCE APP'S OWN player ids, verbatim, and the same confirmed apply
-- that creates the people re-keys them — `store/migrate/people.ts`, in the same transaction.
--
-- NO FOREIGN KEY, for the same reason `group_people.group_id` has none: a constraint here
-- would refuse every row until the gate opens, which turns "not yet re-keyed" into "lost".
-- `store/db/boardgames.ts unresolvedPersonIds()` REPORTS the ids that do not resolve, the way
-- `orphanGroupIds()` does. A thing to look at, never a thing a cascade deletes.
CREATE TABLE IF NOT EXISTS board_game_play_people (
  play_id   TEXT NOT NULL REFERENCES board_game_plays (id) ON DELETE CASCADE ON UPDATE CASCADE,
  person_id TEXT NOT NULL,
  PRIMARY KEY (play_id, person_id)
);

CREATE INDEX IF NOT EXISTS board_game_play_people_person ON board_game_play_people (person_id);

-- ONE PERSON KNOWS ONE GAME well enough to sit down and play it without opening the rulebook.
--
-- A SEPARATE FACT FROM A PLAY, never a summary of one. Six plays of a heavy game and you may
-- still reach for the book; a game learned at somebody else's table has no play row here at
-- all. It is a claim a person STATES, which a play may RENEW and must never INVENT — the
-- refresh on logging a play is an UPDATE, guarded so a backdated play cannot make a claim look
-- fresher than it is, and there is no INSERT on that path.
--
-- These are the rows a wrong identity match would actually damage, and there are very few of
-- them — which is the argument for the manual gate, not against it: a handful of rows is
-- exactly the size at which nobody notices one is attached to the wrong person. Named for
-- board games rather than made activity-agnostic on purpose. The same fact is coming for video
-- games, and designing that table now would be generalising from a table this small.
CREATE TABLE IF NOT EXISTS board_game_known_how (
  person_id    TEXT NOT NULL,
  game_id      TEXT NOT NULL REFERENCES board_games (id) ON DELETE CASCADE ON UPDATE CASCADE,
  -- ISO 8601 — when this was last known to be true. It never expires on its own; the screen
  -- just says how long ago it was.
  confirmed_at TEXT NOT NULL,
  PRIMARY KEY (person_id, game_id)
);

CREATE INDEX IF NOT EXISTS board_game_known_how_game ON board_game_known_how (game_id);
