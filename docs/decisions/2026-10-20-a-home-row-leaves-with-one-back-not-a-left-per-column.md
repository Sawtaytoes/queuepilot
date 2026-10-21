# A Home row leaves with one Back, not a Left per column

- **Status:** Accepted
- **Date:** 2026-10-20
- **Type:** Performance / reliability
- **Supersedes:** —
- **Superseded by:** —
- **Extends:**
  [2026-10-11](2026-10-11-modern-plex-menu-navigation-uses-visible-focus-stops.md)

## Decision

**When the modern Plex UI has focus on a Home row tile, the profile walk sends ONE
`KEYCODE_BACK` to open the navigation rail, not one `KEYCODE_DPAD_LEFT` per column.**

1. One Back per walk, only from a focused node on `screen-home` that is not in the secondary
   navigation. A Back that does not open the rail falls back to the old one-Left step; a
   second Back on Home could leave Plex.
2. The collapsed-rail case (a focused node whose right edge is at most 32 px) still gets
   RIGHT, and a Home screen with no focused node still gets LEFT to acquire focus.
3. **Do not replace this with a batched LEFT.** A Home row drops arrows that arrive while it
   scrolls: one `input keyevent` with eight LEFTs moved the focus three columns, from
   `row-scroller-0-8` to `row-scroller-0-5`. Rail UP batches and picker batches are not
   affected, because neither list scrolls.

## Context

The owner, after a queue start took about a minute: *"It goes one by one. Is there a faster
way to do it?"*

The log showed the cost was the profile walk, not the queue. Focus sat eight tiles deep in a
Home row, and the walk took one dump (about 3.3 s) and one LEFT per column: about 26 s. The
walk then hit `ADB_MAX_PRESSES` (12) one press before CENTER on Switch Profile, so the first
attempt failed and the second one started from the rail.

## Why

- One Back replaces N reads and N presses with one of each, whatever the row or column.
- The walk from deep in a row is now 6 presses (Back, 3 Up, Right, Center) and fits the
  12-press budget with room left; a LEFT per column could not, from column 8 or beyond.
- Measured on the Shield (Plex `tv.plex.app.MainActivity`), 2026-10-20:
  - Row 0 column 8, and row 2 column 6: one Back opened the rail with
    `primary-navigation-home` focused.
  - From there, one batch of 3 UP reached `primary-navigation-account`, RIGHT reached
    `secondary-navigation-account-switch-user`, and CENTER opened the picker.
  - A batch of 8 LEFT from row 0 column 8 moved to column 5.
- Run live with this code from row 2 column 20: Back, 3 Up, Right, Center, picker up. The
  old walk needed 20 LEFTs there, past the 12-press budget, so it could never have finished.
- Each tile's container is `row-scroller-<row>-<column>`, with the column absolute, not the
  visible slot. The focused node is sometimes that container and sometimes an unnamed child
  of it, so the Back rule keys on `screen-home` plus a focused node, not on either id.

## Evidence

- Owner request, T3 Code chat in worktree `t3-e59fbe56`, 2026-10-19.
- Docket task `task_7fyq8h3lmvg4cubb`.
- Unit tests: `plexControlModern.test.ts` — "leaves a deep Home row with one Back instead of
  a Left per column" and "sends Back on Home only once, and acquires a missing focus with
  Left". Both fail on the previous code.
