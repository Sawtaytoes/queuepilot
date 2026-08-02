# A show entry can pin a manual START episode — a floor for "next", never a watched-write

- **Status:** Accepted — fully implemented 2026-07-31 (show + collection entries). The
  editor is the modal in
  [`2026-07-31-start-episode-is-picked-in-a-modal`](2026-07-31-start-episode-is-picked-in-a-modal.md),
  which supersedes the "UI (planned)" section below.
- **Date:** 2026-07-31
- **Type:** behavior / data model
- **Supersedes:** —
- **Superseded by:** —

## Decision

A show entry (a curated **queue** entry OR a channel **member**) may carry an optional
**`start`** override: the episode to begin at, as an alternative to automatic
next-unwatched. It is a **floor**, not a watched-write — episodes **before** the start are
**skipped** (never played), and Plex watched-state is **left untouched** (nothing is marked
watched). From the start point on, playback advances automatically (skipping anything already
watched at-or-after it), exactly like a normal show entry.

Use cases (Bob, 2026-07-31): *"some shows I'd already seen on Crunchyroll, but I haven't
seen them on Plex. I would like to start where I left off without marking previous ones as
watched on Plex… say 'start from episode 20', and then it will be automatic after that."* and
*"skip episodes… 'start from episode 180' (Dragon Ball Z) because we skipped the Garlic Junior
saga."*

## The start-point shape (per Bob)

Type-aware, with a single-season simplification:

- **Show entry** → **`{season, episode}`**. If the show has only **one season** (the usual
  anime case), the editor collects just an **episode** number and stores the sole season —
  so "DBZ episode 180" is entered as a single number.
- **Collection entry** → **`{series, season, episode}`** — you must also pick **which member
  series** of the collection to start at (series before it in collection order are skipped);
  and again, a single-season series collapses to `{series, episode}`.

Bob: *"Season + Episode, but also, if it's a collection, it's series + season + episode. For
anime, there's always 1 season, and in the case of 1 season… series + episode instead."*

## Engine (built)

In `resolve_member` (`queue_builder/plex.py`), after listing `show_episodes(rk)`, every
episode whose `(season, episode)` sorts **before** `start` is dropped — combined with the
existing unwatched + `_keep_episode` filters — before the `episodes:` batch cap. A collection
entry applies the floor inside `collection_items`: members before the named series are skipped
entirely, that member's episodes are floored, and later members are untouched (a `series` with
no episode — a movie member — just skips what comes before it). `start` is stored on the
entry/member alongside `episodes:` (whole-array replace via the existing member/queue write
paths); it survives until the user clears it (it does not auto-advance the stored value — the
floor just stops mattering once you've watched past it). Tests: `e2e/collection-start-test.py`.

## UI (built)

A modal, opened from the tile's next-up line / right-click menu — not an inline field. See
[`2026-07-31-start-episode-is-picked-in-a-modal`](2026-07-31-start-episode-is-picked-in-a-modal.md).

## Why

- Matches real ingest reality: watched-elsewhere or deliberately-skipped arcs shouldn't force
  a fake "mark watched" sweep on Plex (which would corrupt other views/history).
- A floor is the least-surprising primitive: it only ever *removes* earlier episodes from
  consideration; everything downstream (batching, rotation, next-episode display) is unchanged.

## Evidence

- User quotes above, chat 2026-07-31.
