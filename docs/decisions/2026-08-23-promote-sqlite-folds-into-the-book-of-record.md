# `promote.sqlite` folds into the book of record

- **Status:** Accepted
- **Date:** 2026-08-23
- **Type:** storage
- **Supersedes:** [2026-08-23-promote-cooldowns-live-in-promote-sqlite](2026-08-23-promote-cooldowns-live-in-promote-sqlite.md)
  — **only** its choice of FILE. Everything that record says about a lead cooldown being a
  user decision that must not live in a wipeable cache is still true, and this record is that
  argument carried one step further.
- **Superseded by:** —
- **Builds on:** [sqlite-is-the-book-of-record-and-cache-sqlite-stays-derived](2026-08-23-sqlite-is-the-book-of-record-and-cache-sqlite-stays-derived.md)

## Decision

The `lead_cooldown` table lives in **`/config/queuepilot.sqlite`** — the book of record —
beside `sets`, `queues`, `queue_entries`, `groups` and `pending`.

**`/config/promote.sqlite` is gone, and `PROMOTE_PATH` is gone with it.** `server/src/promote.ts`
keeps its queries and its API; it stops owning a file, a schema and a version check.

`cache.sqlite` is untouched and this changes nothing about it. The rule the storage decision
defends — the book of record and the derived cache are two files, never one — is unchanged.
Three durable files was never that rule.

## Context

WP-0 found this while writing the storage decision and deliberately left it open:

> **"Two SQLite files, never one" is already three.** `/config/promote.sqlite`
> (`server/src/promote.ts`, `PROMOTE_PATH`) is a durable `node:sqlite` store with its own
> 2026-08-23 decision. The rule in §1 still holds … but WP-2 must decide explicitly whether
> `promote.sqlite` folds in.

The storage decision itself says the same thing and hands it over: *"Whether it folds into
`queuepilot.sqlite` or stays a separate file is a WP-2 implementation call and is not settled
here."* This is that call.

## Why

### It had never been created on disk, and it never will be that cheap again

`promote.ts` shipped on 2026-08-23, the same day WP-2 started. `ls /config` on the live app
that evening: `cache.sqlite`, `cache.sqlite-shm`, `cache.sqlite-wal`, and no `promote.sqlite`.
The lead:once path had not fired yet.

So the fold is **zero rows migrated**. Doing it later means writing a migration, testing it
against a file whose contents are a user decision, and getting it right the first time,
because a lost cooldown is a promote that fires twice in one sitting. Doing it now is deleting
an `openDb()`.

### A cooldown row is keyed on the primary keys of two tables it now sits beside

`lead_cooldown (set_id, entry_key)` is exactly `(sets.id, an entry key inside queues)`. It was
a foreign key with a file boundary in the way.

Two things follow. A cooldown for a set that has been deleted is an orphan row that nothing
will ever collect, and once the YAML reader is gone the FK plus `ON DELETE CASCADE` collects
it. And the join a future "why did this not lead?" answer wants — cooldown against entry
against set — is one query instead of two connections.

The FK is **not** in the schema yet, on purpose, and `schema.sql` says why: through the bridge
release the app may run with `STORE_BACKEND=yaml`, where `sets` is empty and every cooldown
insert would be refused. It lands in the same change that removes the YAML reader.

### The old file's schema bump WIPED, which is the cache's contract on data that is not a cache

`promote.ts openDb()` DROPped `lead_cooldown` and `meta` on a version mismatch and logged
loudly about it. Its own header says a lead timestamp is a user decision that must survive a
cache clear — and then treats a schema bump the way the cache does.

The book of record **migrates**. `schema.sql` is `CREATE TABLE IF NOT EXISTS` throughout, so
adding a column is additive, and `migrate()` refuses to open a file written by a newer build
rather than writing rows it may misread. That is a strictly better contract for the same data.

### One fewer file to remember to back up

The reason `cache.sqlite` is separate is that it is *deletable*. Nothing about `promote.sqlite`
was deletable, so its separateness bought nothing and cost a line in every backup discussion,
every deploy runbook and every "which files matter" list. The storage decision's own table
already listed three rows where the argument only supports two.

## What was considered and rejected

**Leave it alone; it works.** True, and it is the cheap answer tonight. It is the expensive
answer in a month, when the file exists, holds real cooldowns, and the fold needs a migration
and a proof. The cost curve only goes one way.

**Fold it into `cache.sqlite` instead.** Never. That is the thing both records exist to
prevent.

## Evidence

- `/mnt/TrueNAS-Apps/App-Configs/queuepilot/` on 2026-08-23: `cache.sqlite`,
  `cache.sqlite-shm`, `cache.sqlite-wal`. No `promote.sqlite`.
- `server/src/promote.ts` before this change: `opened.exec('DROP TABLE IF EXISTS
  lead_cooldown; DROP TABLE IF EXISTS meta;')` on a version mismatch.
- The absorb plan's WP-0 status block, correction 2, which names this as WP-2's call.
- [sqlite-is-the-book-of-record-and-cache-sqlite-stays-derived](2026-08-23-sqlite-is-the-book-of-record-and-cache-sqlite-stays-derived.md):
  *"Whether it folds into `queuepilot.sqlite` or stays a separate file is a WP-2 implementation
  call and is not settled here."*
