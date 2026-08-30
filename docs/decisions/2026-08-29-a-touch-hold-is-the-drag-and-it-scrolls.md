# A touch hold is the drag, and it scrolls

- **Status:** Accepted
- **Date:** 2026-08-29
- **Type:** Bugfix / touch interaction / correction
- **Supersedes:** [A long press is the menu or the drag, never both](2026-08-26-a-long-press-is-the-menu-or-the-drag-never-both.md)
- **Superseded by:** —

## Decision

On a queue poster, touch has two timing states:

1. A quick tap opens the entry sheet.
2. A 200 ms hold picks up the tile. A later browser `contextmenu` event cannot reinterpret
   that same hold as the tile menu.

The drag scrolls the document while the pointer stays within 72 px of the visual viewport's
top or bottom edge. Each scroll refreshes the viewport-relative drop slots, so a destination
that starts below the visible three or four items becomes reachable without releasing the
tile.

The editable Priority number owns pointer and context-menu events inside its box. A hold on
the input cannot pass through to the poster's Play / lane menu.

Mouse right-click still opens the tile menu. Touch users can reach its actions through the
entry sheet and the controls already on the tile.

## Context

The previous split required a touch to stay down for 200 ms, move after that point, and move
before the browser emitted `contextmenu`. Too early was a page scroll or no drag. Too late was
the Play / lane menu. The gesture therefore had a narrow timing interval even though the code
described the menu and drag as exclusive.

The drag also captured only the initial viewport's drop slots and never moved the document.
On a phone, only three or four entries were reachable in one attempt.

The Priority number opted out of the grid's `pointerdown`, but its `contextmenu` still bubbled
to `PosterTile`. A hold intended to edit the number therefore opened the tile menu behind it.

## Why

- One hold has one stable meaning. The result does not depend on release timing.
- Edge scrolling makes every position reachable in one drag.
- The number is a direct order control and must own the complete touch sequence.
- The entry sheet preserves access to Play, lane, start and skip actions without sharing the
  drag gesture.

## Evidence

The owner reported on a phone:

> *"If I hold too long, I get a right-click context menu. If I don't hold long enough, nothing happens. If I hold just right, it lets me drag, but then I can't drag past the 3-4 items visibly on the screen."*

The owner also reported that editing a Priority number opened the Play / Random-pool dialog.
`e2e/lane-drag-test.ts` reproduces all three event paths at a 390 × 640 viewport and verifies
the number isolation, the stable hold and continued edge scrolling.
