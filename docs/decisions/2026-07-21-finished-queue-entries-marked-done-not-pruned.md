# Finished queue entries are kept and marked `done`, not pruned from the file

- **Status:** Accepted
- **Date:** 2026-07-21
- **Type:** feature / behavior
- **Supersedes:** the prune half of [movie-queue-sets-yaml-wishlist](2026-07-16-movie-queue-sets-yaml-wishlist.md) (its point 3 "finished movies are pruned from the file")
- **Superseded by:** —

## Decision

A finished queue/channel entry is **kept in `queues.yaml` and tagged `done: true`**, never
auto-removed. The service (`queue_builder/plex.py:next_queue`) excludes done entries from the play
lineup but leaves them in the file; removal happens **only** by an explicit user action — the web
UI's "Remove all completed" button (`POST /api/queues/:set/remove-completed`) or a per-item delete.

- **On-disk format:** a done entry is a mapping carrying `done: true`. A plain title string (or bare
  ratingKey) stays a not-done entry; a finished entry is wrapped/annotated in place with
  `done: true`, preserving its title/identity and the file's comments and order (ruamel round-trip,
  same atomic-rewrite discipline as the old prune). Absence of the flag = not done.
- `queues.py` gains `mark_done(set, keep_keys)`; `next_queue` calls it instead of `queues.prune()`.
- Node surfaces `done: boolean` per item on `GET /api/queues`; the grid renders done tiles
  greyed/disabled.
- Applies to **both** movie queues and anime channels; the driving case is channels.

## Context

Finished members used to auto-prune out of `queues.yaml`. Bob wants them kept and marked instead.
The decisive reason is anime: **an anime series has no "Season 2"** — a sequel is a *separate* Plex
series he adds by hand. If the finished entry vanishes, he loses the anchor to add the sequel next to.
So a finished entry must stay visible (disabled), and only a deliberate "remove all completed" sweep
clears them.

## Why

- **Keeps the sequel anchor.** The finished series stays in place so the hand-added sequel lands
  beside it, in order.
- **User-controlled cleanup, not silent deletion.** Nothing leaves the file without an explicit
  click — no surprise data loss, and the file still reads as "what's left + what I just finished"
  until the user sweeps.
- **Round-trip-safe + reversible.** The `done: true` wrapping preserves identity, comments, and
  order; a mis-marked entry can be un-marked by hand.
- This intentionally reverses the "prune over derived-skip" rationale from the 2026-07-16 wishlist
  decision — that doc optimized the file to read as *only the remaining* list; Bob now wants
  *remaining + recently-finished (disabled)*, cleared on demand.

## Evidence

Bob, 2026-07-21 (v2 live session): *"if I finish one, … mark it for removal as I might wanna add
the sequel… show it somehow disabled and have a button at the top 'remove all completed'."* Rationale
he gave: anime has no Season 2 — the sequel is a separate series he adds by hand next to the finished
one. Captured in `docs/web-ui-v2-feedback-handoff.md` §B.
