# Completed queue entries auto-remove after a TTL (kept, then swept)

- **Status:** Accepted
- **Date:** 2026-08-07
- **Type:** feature / behavior
- **Supersedes:** —
- **Superseded by:** —

## Decision

A finished queue entry is still KEPT and tagged `done: true` when it finishes (decision
[2026-07-21-finished-queue-entries-marked-done-not-pruned](2026-07-21-finished-queue-entries-marked-done-not-pruned.md)).
It can now **auto-remove once it has been done longer than a configurable TTL**, but that is
strictly **opt-in per set** — the default (and today's behavior) is keep-forever.

**Default = OFF (keep forever).** A set with no `remove_completed_after` key never auto-removes;
the global default is `never`. The owner explicitly does NOT want anime completed-entries
auto-removed (an anime series has no "Season 2" — the finished series is the anchor a hand-added
sequel lands next to), so a blanket TTL would surprise-delete them. **Movie queues opt in** with
`remove_completed_after: 24h` in `sets.yaml` (seeded into the movie-queue defaults in
`server/src/sets.js`); **anime channels stay on the keep-forever default**.

- `mark_done` additionally stamps **`done_at`** (epoch seconds) next to `done: true`
  (`queue_builder/queues.py`, ruamel round-trip — comments/order preserved). That timestamp
  is the sweep's clock.
- A **sweep** (`queues.sweep_completed`) removes entries whose `done_at` is older than the
  set's window, reusing `prune` for the atomic, comment-preserving removal. It runs **on
  every scan**, wired into `plex.next_queue` right after `mark_done` (so an entry finished
  this same scan is never immediately swept).
- **Config keys** (locked): global default **`REMOVE_COMPLETED_AFTER` = `never`** (opt-in;
  `queue_builder/config.py`, env-overridable); per-set **`remove_completed_after`** read from
  `sets.yaml` → cfg is how a queue turns removal ON. Duration strings `24h` / `7d` / `90m` /
  bare-seconds; `0` / `never` (or absent) keeps forever. Parsed by `queues.parse_duration`.
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
(per-set); exempt `keep_completed` / `reel`. Owner clarification 2026-08-07: **global default
must be OFF (keep forever) — opt-in per set** so anime completed-entries are never
surprise-removed; movie queues set `remove_completed_after: 24h`, anime queues stay default.
Implemented on branch `feat/ttl-remove-completed`.
