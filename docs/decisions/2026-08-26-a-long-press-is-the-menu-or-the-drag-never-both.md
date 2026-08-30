# A long press is the menu or the drag, never both

- **Status:** Accepted
- **Date:** 2026-08-26
- **Type:** Bugfix / interaction
- **Supersedes:** —
- **Superseded by:** [A touch hold is the drag, and it scrolls](2026-08-29-a-touch-hold-is-the-drag-and-it-scrolls.md)

## Decision

On the queue grid, a press decides between two gestures and commits to one:

1. **Hold, then MOVE** → the reorder drag. The pick-up is deferred to the first move past
   the threshold; the 200 ms hold only ARMS it.
2. **Hold, and stay still** → the browser's long-press menu. The `contextmenu` event ends
   the press outright, so no tile is picked up and the `pointerup` that follows cannot
   settle as a tap.

Two more rules fell out of the same screen:

3. **`pointerdown` is primary-button only.** A right-click no longer opens a press.
4. **The menu closes on a scroll that MOVES the page**, not on a zero-delta scroll event.

## Context

The owner, on a tablet, about the tile menu:

> *"It also messes up the UI when you close that menu."*

Driven in a browser at 500 x 900 with touch, the hold does this:

- **200 ms** — the hold timer fires and calls `beginDrag()`. The tile lifts out of its card,
  wears the drag ring, and the card it came from is left empty.
- **~500 ms** — the browser fires its own long-press `contextmenu`. The tile menu opens **on
  top of** the tile that is mid-drag.

One hold, two gestures, both half-done — the tile in
[`2026-08-26-tile-menu-before.png`](../images/2026-08-26-tile-menu-before.png) is wearing the
drag ring, pulled out of the card the menu is floating over.

Two more defects were found in the same gesture and are fixed here, because all three are
the same press:

- **A right-click on the poster opened the ENTRY SHEET, not the menu.** `pointerdown` fires
  for the right button too, so the press its own `pointerup` settled as a TAP — and a tap on
  a poster opens the sheet ([decision](2026-08-17-a-poster-tap-opens-the-entry-sheet.md)).
  The menu the same click had just opened went under it.
- **The menu could close in the frame it opened.** Chromium fires a `scroll` at the document
  with the position unchanged when the menu opens over a grid that was scrolled into view,
  and the menu closed on any scroll at all. It read as a long press that did nothing.

## Why

- **The two gestures cannot both own the hold, so the hold has to be a fork.** The platform
  owns the long-press menu and its timing; the app owns the drag. Deferring the pick-up to
  the first MOVE is what makes them exclusive without taking either away — the finger has
  already declared which one it meant by the time the menu would appear.
- **The 200 ms hold is still needed.** It is what lets a vertical swipe scroll the grid
  instead of dragging it. Arming on movement alone would take the scroll back.
- **The drag is unchanged for anyone using it.** Hold, then move, and the tile lifts on the
  first move rather than under a stationary finger — which is where the eye is anyway.
- **`preventScroll` on the menu's own focus is not a nicety.** The menu is already clamped
  into the viewport, so there is nothing to scroll to, and the scroll a plain `focus()`
  causes is indistinguishable from a real one.
- **A scroll SHOULD still close the menu.** It is `position: fixed` and pinned to where the
  tile was, so a page that moves leaves it pointing at nothing. What changed is only that a
  scroll event carrying no movement is not a scroll.

## Evidence

- Owner, 2026-08-26, quoted above.
- `e2e/tile-menu-test.ts` — a held finger picks nothing up; the menu opens with the tile
  still in its card; lifting the finger leaves the menu open and opens no entry sheet; a
  hold followed by a move still arms the drag; a right-click on the poster opens the menu
  and not the sheet.
- `e2e/drag-stability-test.ts` unchanged: 0 reversals, 2 re-inserts, 12 style writes.
