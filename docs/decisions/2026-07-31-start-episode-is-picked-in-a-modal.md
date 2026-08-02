# The start episode is PICKED in a modal — no inline control on the tile

- **Status:** Accepted
- **Date:** 2026-07-31
- **Type:** UI
- **Supersedes:** the "UI (planned)" section of
  [`2026-07-31-per-entry-start-episode-override`](2026-07-31-per-entry-start-episode-override.md)
  (the behavior/data model there is unchanged — only how it's edited)
- **Superseded by:** —

## Decision

A tile carries **no always-on start control**. The inline `Start [au]` number box is gone from
both the queue grid and the channel member grid. Instead:

- **The tile's yellow next-up line is the button.** Tap/click it → the "Start from…" modal.
  (Touch-reachable — Bob works from a tablet, so a right-click-only affordance is not enough.)
- **Right-click / long-press a tile** → a context menu: *Start from an episode… / Start
  automatically (clear override) / Remove*.
- **An entry that HAS an override shows one amber chip** (`Start E20`), which is also a button
  back into the modal. Tiles without an override show nothing.

Everything in the modal is **picked, never typed**:

| Entry | Fields |
| --- | --- |
| Show, one season (every anime) | Episode (`E12 · For Lost Love`, watched ones say so) |
| Show, several seasons | Season, then Episode |
| Collection | **Series** (the collection's members, in play order, with `12/14 watched`), then Season/Episode inside it — or nothing more when the member is a movie |

A collection's stored start is `{series, season, episode}`, where `series` is the member's
**ratingKey** (a hand-written YAML entry may name it by title instead — the engine matches
either). Members before it are skipped entirely; that member's episodes are floored; later
members are untouched.

## Context

Bob, 2026-07-31:

> *"I don't want that 'Start au' in there. It takes up space when it could be a right-click
> context menu or modal. I'd rather select the show/series, season, and episode number from
> that form to ensure I'm doing it correctly rather than adding more visual noise. In this
> case, once that field is set, the yellow 'E2 - <title>' shows up, so it's very clear which
> is which."*

The old control also had a cosmetic bug that made the point for it: its `auto` placeholder was
clipped by the cramped inline field and read as a meaningless **"au"**.

## Why

- **The tile is a display surface, not a form.** One rarely-used override does not earn
  permanent space on every tile in the grid.
- **Picking can't be wrong.** A typed number can name an episode that doesn't exist, or the
  wrong season; a list of real episode titles (with watched marks) can't.
- **The state is already visible.** The yellow line shows exactly where the entry will start,
  so the editor only needs to exist while you're editing.

## Evidence

- User quote above, chat 2026-07-31, with annotated screenshots of the "Start au" tiles.
- Verified end-to-end in a real browser: `e2e/verify-start-modal.mjs` (picker contents, both
  write paths, the chip, the menu, clearing). Engine floor: `e2e/collection-start-test.py`.
