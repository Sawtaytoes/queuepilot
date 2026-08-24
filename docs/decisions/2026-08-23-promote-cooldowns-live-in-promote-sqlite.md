# Lead cooldowns live in durable `promote.sqlite`, not `cache.sqlite`

- **Status:** Superseded in part
- **Date:** 2026-08-23
- **Type:** storage / playback semantics
- **Supersedes:** —
- **Superseded by:** [2026-08-23-promote-sqlite-folds-into-the-book-of-record](2026-08-23-promote-sqlite-folds-into-the-book-of-record.md)
  — **only** the choice of file. The reasoning below about `cache.sqlite` is unchanged and is
  what the later record carries forward.
- **Builds on:** [kind-is-picks-or-rules](2026-08-23-kind-is-picks-or-rules.md),
  [sqlite-is-a-derived-plex-cache-not-the-store](2026-08-03-sqlite-is-a-derived-plex-cache-not-the-store.md)

## Decision

Priority-queue **lead cooldowns** (`lead: once` + `promote_window`) are stored in
**`/config/promote.sqlite`** (`PROMOTE_PATH`), a durable sqlite next to
`sets.yaml` / `queues.yaml`.

They do **not** live in `cache.sqlite`. That file is a derived Plex cache: wiped on
schema bump and safe to `rm`. A lead timestamp is a user decision about "this title
already led in this window"; losing it on a cache clear would let a promote fire twice
in one sitting.

## Why

- `cache.sqlite`'s contract is "deletable, regenerable from Plex" — lead cooldowns are
  neither.
- A second tiny sqlite keeps the wipe rule honest and avoids teaching the cache module
  to preserve one table forever.
- YAML was considered (stamp on the entry) and remains allowed as an override field;
  the *window clock* still needs a store that survives pause-and-resume across process
  starts without rewriting `queues.yaml` on every successful lead.

## Evidence

- Owner, 2026-08-23: lead cooldown cannot live in wipeable `cache.sqlite`; put a durable
  `promote.sqlite` (or an entry stamp) in the cutover.
