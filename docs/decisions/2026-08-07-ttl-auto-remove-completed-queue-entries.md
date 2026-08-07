# Completed queue entries auto-remove after a TTL (kept, then swept)

- **Status:** Accepted
- **Date:** 2026-08-07
- **Type:** feature / behavior
- **Supersedes:** —
- **Superseded by:** —

## Decision

A finished queue entry is still KEPT and tagged `done: true` when it finishes (decision
[2026-07-21-finished-queue-entries-marked-done-not-pruned](2026-07-21-finished-queue-entries-marked-done-not-pruned.md)),
but it is now also **auto-removed once it has been done longer than a configurable TTL** —
it no longer lives forever waiting on a manual "Remove all completed" click.

- `mark_done` additionally stamps **`done_at`** (epoch seconds) next to `done: true`
  (`queue_builder/queues.py`, ruamel round-trip — comments/order preserved). That timestamp
  is the sweep's clock.
- A **sweep** (`queues.sweep_completed`) removes entries whose `done_at` is older than the
  set's window, reusing `prune` for the atomic, comment-preserving removal. It runs **on
  every scan**, wired into `plex.next_queue` right after `mark_done` (so an entry finished
  this same scan is never immediately swept).
- **Config keys** (locked): global default **`REMOVE_COMPLETED_AFTER` = `24h`**
  (`queue_builder/config.py`, env-overridable); per-set override **`remove_completed_after`**
  read from `sets.yaml` → cfg. Duration strings `24h` / `7d` / `90m` / bare-seconds;
  `0` / `never` disables. Parsed by `queues.parse_duration`.
- **Exemptions:** a set with `keep_completed: true` OR `reel: true` is never swept. A
  `done: true` entry that carries **no** `done_at` (a hand-marked or legacy entry) is also
  never auto-removed — only system-stamped finishes age out, so nothing is deleted without a
  timestamp the service itself wrote.
- The Node mirror (`server/src/queues.js`) gains `parseDuration`, `entryDoneAt`,
  `DEFAULT_REMOVE_COMPLETED_AFTER`, and `sweepCompleted` so the web editor agrees on the same
  rule (`done_at` is preserved through every existing Node round-trip). The Python service is
  the authority that actually runs the sweep on scan.

## Context

Finished entries were kept + tagged so the anime "no Season 2" anchor stays visible, cleared
only by an explicit UI sweep. In practice the done pile grows unbounded until someone clicks.
A TTL keeps the just-finished anchor around long enough to add a sequel next to, then tidies
itself — while a per-set `keep_completed` / `reel` opt-out preserves the "keep forever" case.

## Why

- **Self-tidying, but not hair-trigger.** 24h keeps a fresh finish visible through the day;
  the sweep runs on scan, so cleanup needs no cron.
- **Conservative deletion.** Only entries the service stamped with `done_at` age out; a
  hand-marked `done: true` or a `keep_completed`/`reel` set is left alone. `0`/`never`
  disables fleet- or set-wide.
- **Reuses the proven writers.** `mark_done`'s stamping and `prune`'s atomic, comment-safe
  removal are the same round-trip discipline already trusted for the file.

## Evidence

Roadmap §B.3 (shared spec for the parallel §B PRs): locked keys `remove_completed_after`
(per-set) + global default 24h; exempt `keep_completed` / `reel`. Implemented on branch
`feat/ttl-remove-completed`.
