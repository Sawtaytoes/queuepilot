# A `keep_completed` queue flag makes a set non-consuming (a re-showable playlist)

- **Status:** Accepted
- **Date:** 2026-08-07
- **Type:** feature / behavior
- **Supersedes:** —
- **Superseded by:** —

## Decision

A curated (`source: queue`) set may carry **`keep_completed: true`** in `sets.yaml`. A set
with it set is **non-consuming**: `queue_builder/plex.py:next_queue` **never** calls
`queues.mark_done()` for it, so its entries are never tagged `done: true` and never removed
when played. The owner can re-show the whole lineup (e.g. the Theater Demo Reel) repeatedly.

- Parsed in `queue_builder/config.py` (`_load_sets_yaml`, queue branch) into `cfg["keep_completed"]`.
- **Decoupled from `reel`.** `reel: true` ALSO replays the whole lineup every scan (via
  `plex.build_reel`, ignoring watched-state); `keep_completed` governs **only consumption**
  (whether entries are marked done). They are orthogonal knobs — but `reel: true` **implies**
  `keep_completed` (a reel never consumes either), so a reel needs no separate flag.
- Nothing is ever written to disk for a `keep_completed` set (no `done` / `done_at`), so it is
  inherently exempt from any finished-entry TTL sweep — the exemption falls out of "never marks
  done", it does not depend on the sweep's code.
- **Web UI needs no change.** The "Completed" badge renders off `item.done`, which comes from
  `queues.yaml`. A `keep_completed` set never writes `done: true`, so its items never render as
  consumed — the behavior is mirrored by construction.

## Context

The reel path (`build_reel`) already ignores watched-state and never marks done, but that also
forces play-the-whole-lineup-every-scan. The consumption behavior (does a played entry get marked
`done` and drop out) is a separate axis from the play-all axis. Splitting them lets a set be a
non-consuming playlist without necessarily being a full reel, and gives `reel` a clean, explicit
definition (`reel` ⇒ `keep_completed`).

The default remains the 2026-07-21 behavior: a finished entry is kept and tagged `done: true`
(`2026-07-21-finished-queue-entries-marked-done-not-pruned.md`). `keep_completed` opts a set out of
that marking entirely.

## Why

- **Re-showable playlists.** A demo reel / showcase set stays fully playable every scan instead of
  greying out as its items are "finished".
- **Orthogonal, composable flags.** Consumption and play-all are independent; a future set can want
  one without the other. `reel` stays a convenience that implies both.
- **No new state, no sweep coupling.** Writing nothing is the simplest exemption from any
  finished-entry cleanup, and it needs no coordination with the TTL-sweep work.

## Open decision (owner)

Whether the demo reel should keep playing the **whole lineup every scan** (current `reel`) or
**advance one item per scan** as a loop is the owner's call and is **out of scope** here — this
change adds only the consumption flag and does not alter `reel`'s play-all-every-scan behavior.

## Evidence

Feature spec (§B.4, 2026-08-07 session): add an explicit per-set `keep_completed: true` — "a queue
with it set NEVER marks entries done and never removes them when played — so the owner can re-show a
playlist (e.g. the Theater Demo Reel) repeatedly. Decouple this from `reel`… `reel: true` implies
`keep_completed`."
