# SQLite is the book of record, and `cache.sqlite` stays derived

- **Status:** Accepted
- **Date:** 2026-08-23
- **Type:** architecture / storage
- **Supersedes:** [2026-08-03-sqlite-is-a-derived-plex-cache-not-the-store](2026-08-03-sqlite-is-a-derived-plex-cache-not-the-store.md)
  — **only** its "do not migrate config into SQLite / YAML stays the long-term store"
  clause. Everything that record says about `cache.sqlite` being derived, wiped and
  deletable is still true, and this record restates it rather than replacing it.
- **Superseded by:** —
- **Implements:** the household absorb decision, named rather than linked because it lives
  in a sibling workspace repo that is not on GitHub —
  `agentic:docs/decisions/2026-08-22-queuepilot-absorbs-board-game-picker-tonight-pick.md` §2.

## Decision

Durable state moves into **`/config/queuepilot.sqlite`** — sets, queues, entries, groups,
people, the absorbed board-game collection, the play log and known-how. That file is the
**book of record**: it is backed up, it is migrated on a schema change, and losing it loses
data no re-read can regenerate.

**`/config/cache.sqlite` does not change and does not absorb any of it.** Its contract is
the one 2026-08-03 wrote and every line of it stands: derived from Plex reads only,
schema-versioned by DROP-and-recreate, gitignored, never backed up, and `rm` is a supported
recovery step.

**The book of record and the derived cache are two files, never one.** There is no version
of this where they merge, and nothing in the absorb creates a reason to revisit that.

| File | Role | Wiped on schema mismatch? | Backed up? |
| --- | --- | --- | --- |
| `/config/queuepilot.sqlite` | book of record — sets, queues, entries, groups, people, collection, plays, known-how | no, migrated | yes |
| `/config/promote.sqlite` | durable lead cooldowns ([2026-08-23](2026-08-23-promote-cooldowns-live-in-promote-sqlite.md)) | no, migrated | yes |
| `/config/cache.sqlite` | derived Plex / Kavita cache | **yes, every table DROPped** | no, deletable |

`promote.sqlite` predates this record and is already durable for the same reason the book of
record is. Whether it folds into `queuepilot.sqlite` or stays a separate file is a WP-2
implementation call and is not settled here. What is settled is that it never moves into
`cache.sqlite`, which is what its own record already says.

**YAML's remaining role is an import bridge and nothing else.** `sets.yaml`, `queues.yaml`,
`groups.yaml` and `pending.yaml` are read once by a one-shot importer that copies them aside
first and is idempotent. Through one release the app keeps writing them as a rollback path,
then stops. After the cutover no request path reads a `.yaml` file, and no code may
reintroduce one "just for this field".

## Context

The absorb pulls Board Game Picker's data into this app: eleven relational tables, a play
log, per-person known-how claims, and a collection with foreign keys between games, boxes and
people. That data has never been YAML and cannot become YAML without inventing a join engine
on top of a text file.

At the same time the four config files stay small — `sets.yaml` is 7 KB and `queues.yaml` is
23 KB — so the 2026-08-03 finding still holds: **parsing them was never the slow thing.**
This record is not a performance argument and must not be read as one. Nothing here revises
the measurement that `/api/queues` costs 2.6–2.8 s of Plex I/O and single-digit milliseconds
of YAML.

The reason to move is that the app is about to hold relational data with two writers and no
whole-file rewrite that is safe.

## Why

### Merging the two files makes the deletable file undeletable

This is the whole of it, and it is worth saying without hedging.

`cache.sqlite` earns its shape from two behaviours that are only acceptable because nothing
in it matters: a schema-version mismatch **DROPs every table**, and `rm /config/cache.sqlite`
is a documented recovery step a person is invited to take when the cache is wrong.

Put a queue in that file and both become data loss. A schema bump deletes the household's
queues without asking. The recovery step a user was told was safe deletes them by hand. The
only way out is to stop wiping the file — and a cache that cannot be wiped is not a cache. It
is a database with a stale-Plex problem and no cheap way to fix it, which is strictly worse
than what exists today.

So a merge does not save a file. It spends the one file that can be thrown away, and gets
nothing.

### The four costs 2026-08-03 said a migration must answer

That record ends by demanding this list, so it gets answered rather than skipped.

1. **git-diffability.** Weakest of the four, because it was never true of these files: they
   live in `/config`, not in the repo, and git has never seen them. What is reviewed as text
   is `store/schema.sql`, which *is* in the repo. Cost: a decision doc quotes a query instead
   of quoting five lines of YAML. Accepted.

2. **SMB hand-editing.** Real, and deliberately spent. `/config` is a share and hand-editing
   the registry was a named workflow. It stops being one, which puts the burden on the admin
   surfaces: WP-3 and WP-5 rebuild people and queues, and they have to be complete enough
   that hand-editing is not the fallback. `sqlite3` over the share remains for an emergency,
   the same way it does for `cache.sqlite` today. **If an admin screen is missing, that is a
   bug in this migration, not a reason to keep a YAML writer alive.**

3. **Comment round-tripping.** Real, partly unrecoverable, and the one genuine loss. The two
   live files carry 79 comment lines between them, and the `yaml` Document API preserves them
   today. A row has nowhere to put a comment. A comment that explains one set or one queue
   should migrate into a `note` column on that row and the importer should carry it across; a
   comment that explains the file as a whole, or sits between two unrelated blocks, has no
   row to land on and is lost. The importer's copy-aside is what keeps the original text
   readable after the fact. Accepted as a loss, not argued away as a non-loss.

4. **The title-string entry format.** Already spent, by a different decision, before this
   one. [2026-08-21](2026-08-21-a-queue-entry-is-an-object-and-carries-its-rating-key.md) made
   every queue entry a mapping carrying its rating key, and a bare string is now refused by
   entry. The "human-typed string is a text-file affordance" argument describes a format this
   app no longer has.

### What buys them

Three things the absorb needs that a whole-file YAML rewrite cannot do:

- **Relations.** The absorbed collection is games, boxes, people and plays with foreign keys
  between them. `PRAGMA foreign_keys = ON` and a cascade are the feature; re-deriving them
  from four flat files on every read is not.
- **Append-heavy history.** The play log and known-how claims grow per session and are read
  by joins. That is the same argument 2026-08-03 already accepted for the `history` table —
  no index, whole-file rewrite per update, no crash atomicity.
- **Two writers.** HTTP and MQTT both mutate this state, and a queue reorder that lands while
  a play is being logged has to be atomic. A YAML write is read-modify-write of the whole
  file, and the losing writer's edit disappears with nothing reporting it.

### Why this is a record and not just the plan

The absorb is ten work packages and several agents. Without this file, the next agent to open
`cache.ts` finds a working SQLite database, a set of YAML files, and a 2026-08-03 record
saying config must not move into a database — and either reverts the migration or, worse,
merges the two files because there is already one there.

## Evidence

- Owner, 2026-08-22, on the absorb: *"absorb into QueuePilot and pull in all my Board Game
  data and BGG. Both should be on SQLite."*
- 2026-08-03's own closing demand: *"If that is ever proposed, it needs its own decision that
  answers the four costs listed under Why below."* This is that decision; the four are
  answered above.
- [2026-08-23-promote-cooldowns-live-in-promote-sqlite](2026-08-23-promote-cooldowns-live-in-promote-sqlite.md)
  reached the same conclusion three weeks later on a single table, for the same reason: a
  user decision cannot live in a file whose recovery step is `rm`. This record generalises
  that, it does not contradict it.
- `server/src/cache.ts`'s header states the derived-cache contract at the top of the module,
  and it is unchanged by this record.
