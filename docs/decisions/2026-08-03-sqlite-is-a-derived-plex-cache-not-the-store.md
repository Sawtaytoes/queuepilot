# SQLite is a derived Plex cache, not the store — YAML stays the source of truth

- **Status:** Accepted
- **Date:** 2026-08-03
- **Type:** architecture / storage
- **Supersedes:** —
- **Superseded by:** —
- **Clarifies:** [2026-07-21-real-webapp-sse-yaml-not-sqlite](2026-07-21-real-webapp-sse-yaml-not-sqlite.md)

## Decision

`queues.yaml` and `sets.yaml` remain the **durable, hand-editable source of truth**. A new
SQLite database at `/config/cache.sqlite` is introduced as a **derived cache of Plex reads
only**. It is:

- **deletable** — `rm /config/cache.sqlite` is a supported recovery step; the app rebuilds it
- **gitignored** and **never backed up** — it holds nothing a Plex re-read cannot regenerate
- **schema-versioned** — a `meta.schema_version` mismatch DROPs every table and recreates them;
  a stale cache schema is never worth migrating
- **never authoritative** — no code path may read a config value from it, and no config
  mutation may be considered committed until the YAML write returns

**Do not later migrate config into the database we already have.** The existence of a SQLite
file in `/config` is not an argument for moving `sets.yaml` into it. If that is ever proposed,
it needs its own decision that answers the four costs listed under *Why* below.

## Context

First-load performance was measured (Lighthouse against the live host plus `curl` timings) and
`GET /api/queues` was found to take **2.6–2.8 s on every request, uncached**. The cause is Plex
I/O — roughly sixty sequential-ish HTTP calls to resolve ten shelves' worth of tiles, posters
and next-episode lookups.

The tempting reading of that number is "YAML parsing is slow, move to a database." It is not.
`queues.yaml` and `sets.yaml` are **2–5 KB**; parsing them is single-digit milliseconds, well
under 1% of the 2.7 s. The slow thing is Plex, and the thing that dies on every container
restart is the in-process `Map` caches in `server/src/plex.js`.

So the cache is what goes into SQLite. The config does not.

## Why

**Why cache Plex in SQLite rather than in memory:** the in-process `Map`s (`_titleCache`,
`_playCtx`, `_thumbPath`) are correct but evaporate on restart, which is exactly when the user
notices — every deploy makes the next load fully cold. A file-backed cache with indexed point
lookups survives restarts and gives the `history` table (~50k rows) somewhere to live that a
JSON file cannot serve: no index, whole-file rewrite per update, no crash atomicity.

**Why `node:sqlite`'s `DatabaseSync` and not `better-sqlite3`:** `better-sqlite3` is a native
build, and `npm install --omit=dev` already runs inside `node:24-trixie-slim` in the Dockerfile.
A missing prebuild turns a deploy into a compiler hunt, and it buys nothing at tens of
statements per request. `node:sqlite` is verified working on the image's Node (v24.18.1) with
no experimental warning.

**Why the config does NOT move**, even though a database is now present:

1. **git-diffability** — the YAML files are reviewed as text; a decision doc can quote them.
2. **SMB hand-editing** — `/config` is a share, and hand-editing the registry is a named,
   accepted workflow.
3. **Comment round-tripping** — the files carry explanatory comments that the `yaml` Document
   API preserves. A database has nowhere to put them.
4. **The title-string entry format** — `2026-07-20-queue-entries-are-title-strings` makes the
   entry itself a human-typed string. That is a text-file affordance.

All four are decisions already taken. Moving to a database would spend them to save something
measured at under ten milliseconds.

## Consequences

- `server/src/cache.js` owns the schema and the version constant. Every export has an `async`
  signature even though `DatabaseSync` bodies are synchronous — that makes relocating the module
  into a `worker_thread` free if p99 ever suffers.
- Redundant YAML re-parsing is removed by mtime memoization (`queues.listAll`, a memoized
  `getRegistry`), not by changing the storage model.
- `/config/cache.sqlite`, `-wal` and `-shm` are gitignored.
