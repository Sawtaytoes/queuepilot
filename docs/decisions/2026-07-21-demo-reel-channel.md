# 2026-07-21 — Theater DEMO channel is an ordered "reel", not a queue or a shuffled channel

## Context
The user wanted a card-scannable "demo content" channel to show off the Family Room theater to
a guest (Sunday). Source material: the **Demo** Plex Home profile's history (1,751 plays / 620
distinct clips) plus the **Demos** (sec 2) and **Movie Clips** (sec 7) libraries — Dolby/THX/
Trinnov trailers and 4K Dolby-Vision/Atmos movie showpiece scenes.

## Decision
Add a third `source: queue` behavior — a **reel** (`reel: true`) — for the `demo` set:

- **Ordered**: file order == play order. The lineup is a deliberate arc (lights-down logos →
  4K/Atmos reference showpieces → dynamics/surround → musical crescendo → quiet outro).
- **Full**: the whole list plays back-to-back each scan (own 60-item safety cap, independent of
  `ROTATION_LENGTH`).
- **Replayable**: watched-state is ignored and nothing is ever marked `done` — a demo reel must
  play in full every time.

Engine: `plex.build_reel` (parallel to `next_queue`), selected in `do_start` when `cfg["reel"]`.

## Alternatives rejected
- **Normal curated queue** (`kind != anime`): plays only the *first* not-finished entry per scan
  → one clip, and (with watched-state) it would walk/advance or, pointed at the Demo profile that
  has already "watched" everything, mark all entries done and play nothing. Wrong for a reel.
- **Existing channel mode** (`kind: anime`): plays members back-to-back but **shuffled** and
  **capped at `ROTATION_LENGTH` (12)**. No deliberate arc, and drops 8 of 20 clips. Rejected —
  the user chose an ordered full reel.

## Notes / constraints
- Clips are keyed by **ratingKey**, so they resolve despite Demos/Movie-Clips being hidden from
  browsing. Verified live: 20/20 resolve, 0 unresolved, correct order.
- Built in an **isolated git worktree** (`feat/demo-reel-channel`, base `f430b23`) because a
  parallel agent was actively rewriting `config.py`/`plex.py`/`sets.js` in the main working tree.
  Changes are Python-only + docs to minimize merge conflict; `sets.js` parity (DEFAULT_YAML seed,
  `normalize()` reel passthrough) is a deferred follow-up.
- Go-live steps, the ready-to-paste `sets.yaml`/`queues.yaml` blocks, and NFC card wiring:
  `docs/demo-reel-channel.md`.
