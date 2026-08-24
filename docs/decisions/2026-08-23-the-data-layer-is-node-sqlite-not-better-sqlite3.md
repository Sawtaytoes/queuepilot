# The data layer is `node:sqlite`, not `better-sqlite3`

- **Status:** Accepted
- **Date:** 2026-08-23
- **Type:** architecture / dependencies
- **Supersedes:** —
- **Superseded by:** —
- **Builds on:** [2026-08-23-sqlite-is-the-book-of-record-and-cache-sqlite-stays-derived](2026-08-23-sqlite-is-the-book-of-record-and-cache-sqlite-stays-derived.md),
  [2026-08-03-sqlite-is-a-derived-plex-cache-not-the-store](2026-08-03-sqlite-is-a-derived-plex-cache-not-the-store.md)

## Decision

Every SQLite database this app opens goes through **`node:sqlite`'s `DatabaseSync`**. That
includes the book of record the absorb introduces, not only the derived cache.

**Board Game Picker's data layer is PORTED to `node:sqlite`.** `better-sqlite3` is not added
to this container, and the absorb is not the occasion to reverse the reason it was rejected.

The port gets a small compat layer — `prepare`, `exec`, `withTransaction` — so the absorbed
query code keeps its call shape. That is a shim to avoid touching a thousand lines of working
SQL, not a driver abstraction, and it is not an invitation to swap drivers later.

## Context

The two apps disagree about the driver, and one of them disagrees on purpose.

| | Board Game Picker | QueuePilot |
| --- | --- | --- |
| Driver | `better-sqlite3` `^12.4.1` (native build) | `node:sqlite` `DatabaseSync` |
| Where | `packages/server/src/db/database.ts` | `server/src/cache.ts`, `server/src/promote.ts` |
| Why | the default choice | stated in the module header, quoted below |

`server/src/cache.ts` states the constraint at the top of the file:

> STORAGE: node:sqlite's DatabaseSync, verified working on the image's Node (v24.18.1) with
> no experimental warning. Not better-sqlite3 — a native build inside `npm install
> --omit=dev` turns a missed prebuild into a deploy-time compiler hunt and buys nothing at
> tens of statements per request.

So absorbing Board Game Picker's server means one of two things: port its data layer, or add
a native dependency to a container that deliberately has none.

## Why

### The constraint is about the deploy, not about the benchmark

`npm install --omit=dev` runs inside `node:24-trixie-slim` in the Dockerfile. `better-sqlite3`
resolves to a prebuilt binary when one exists for that Node ABI and that platform, and falls
back to `node-gyp` when one does not. The failure is not that the fallback is slow. It is
that it happens **during a deploy**, on a slim image with no toolchain, and the first sign of
it is a failed build of an app that worked yesterday — after a Node bump, a base-image bump,
or an upstream release that has not published a prebuild yet.

Nothing about the absorb makes that trade better. It makes it worse: the book of record is
now the file the household's queues live in, so a container that will not build is a
household that cannot start anything.

### The port is mechanical, and the surface was measured

Counted across `packages/server/src/` in Board Game Picker, including its test files:

| `better-sqlite3` API | Uses in BGP | `node:sqlite` answer |
| --- | --- | --- |
| `.prepare()` + `.get` / `.all` / `.run` | 104 | same names, same shape |
| `.transaction(fn)` | 11 | no equivalent — a ~10-line `withTransaction()` helper (`BEGIN` / `COMMIT` / `ROLLBACK`) |
| `.pragma('…')` | 3 | `db.exec('PRAGMA …')` for 2; the third returns rows and becomes `db.prepare('PRAGMA table_info(…)').all()` |
| `.function()` / `.aggregate()` / `.backup()` / `loadExtension` | **0** | nothing to port |

The zero row is the load-bearing one. No user-defined SQL function, no custom aggregate, no
online backup API and no loaded extension means there is nothing in the absorbed code that
only `better-sqlite3` can do. What is left is naming.

The 104 is the `.prepare()` call-site count, and each one is followed by `.get` / `.all` /
`.run` with the same signature on both drivers, which is why the shim is three functions and
not a driver layer.

**The pragma row is the one place the surface is not a rename.** `node:sqlite`'s `exec()`
returns nothing, so a pragma that *sets* something translates directly, and a pragma that
*reads* rows — `PRAGMA table_info(<t>)`, which Board Game Picker's `addMissingColumns()` uses
to decide which `ALTER TABLE` to run — has to go through `prepare().all()`. Verified against
`node:sqlite` rather than assumed: `db.prepare('PRAGMA table_info(t)').all()` returns the
`cid` / `name` / `type` / `notnull` / `dflt_value` / `pk` rows the caller expects.

### The precedent is already in this repo, twice

`cache.ts` is the derived cache and `promote.ts` is a durable store — a schema that migrates
rather than wipes, keyed rows, WAL. `promote.ts` is the one that matters here, because it
proves `node:sqlite` already backs data this app is not allowed to lose. The book of record
is the same shape at a larger size.

### What the port must not become

Two failure modes are worth naming before someone finds them:

- **A driver abstraction.** The shim exists so `repository.ts` does not have to be rewritten
  line by line. It is not a seam for swapping SQLite drivers, nothing may branch on which
  driver is underneath, and a second implementation of it is a mistake.
- **A behaviour drift.** `.transaction(fn)` in `better-sqlite3` handles nesting with
  savepoints and re-throws after rolling back. `withTransaction()` must match that on the
  paths the absorbed code actually uses, and Board Game Picker's own `db/*.test.ts` suites
  move over **unchanged** as the gate. A port that passes its own new tests and not the
  originals has proved nothing.

## Evidence

- `server/src/cache.ts` header, quoted above — the constraint is stated in the module, dated
  2026-08-03, and predates the absorb.
- `server/src/promote.ts` — the second `node:sqlite` module in this app, and the durable one.
- Counts measured over Board Game Picker's `packages/server/src/` on 2026-08-23:
  104 `.prepare(`, 11 `.transaction(`, 3 `.pragma(`, and zero across `.function(`,
  `.aggregate(`, `.backup(` and `loadExtension`. The 11 transactions sit in three files
  (`db/merge.ts` 5, `db/repository.ts` 5, `import/collection.ts` 1); the three pragmas are
  all in `db/database.ts` — two setters in `openDatabase()` and the `table_info` read in
  `addMissingColumns()`.
- `PRAGMA table_info` through `node:sqlite`'s `prepare().all()` run and checked, not assumed.
- Board Game Picker pins `better-sqlite3` at `^12.4.1` with `@types/better-sqlite3` beside
  it; both leave with the port.
