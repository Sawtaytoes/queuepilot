# A tile carries a lane control, and the select mark actually paints

- **Status:** Accepted
- **Date:** 2026-08-26
- **Type:** UI / bugfix
- **Supersedes:** —
- **Superseded by:** —

Extends [✓ stacks under ✕; Edit is a pencil pill by the
labels](2026-08-25-checkmark-under-x-edit-by-the-labels.md) — the stack keeps its order and
gains a third control — and [the queue page is two lanes, and the drag across the divider is
the promote](2026-08-26-the-queue-page-is-two-lanes-and-the-drag-is-the-promote.md), which
stays exactly as it is.

## Decision

1. **The select mark is an SVG, and every state it has is written at the same specificity.**
   Unchecked is an empty ring; hovering the ring ghosts the mark in; checked fills the circle
   with the accent and paints the mark solid.
2. **The select control is a `<button aria-pressed>`**, not a `<span aria-hidden onClick>`.
   It holds state, so it announces state, and it can be reached from a keyboard.
3. **A third control sits under it**: ↑ moves the entry into the Priority queue, ↓ moves it
   back out to the Random pool. The arrow points the way the tile moves on screen.
4. **A promote lands at the END of the Priority lane** (`promotedOrder`), never at its head.
5. **A demote writes no order at all.** The pool is shuffled at playback, so its order means
   nothing, and writing one would be a change to the file's bytes and nothing else.
6. **The drag across the divider stays.** This is the same write, for a pointer that would
   rather press than drag — and the only way across on a touch device without a long press.

## Context

Two reports in one message, 2026-08-26, with a screenshot of the Random pool:

> "Checkbox icon isn't working. Also, instead of right-click, I think we should add a 3rd icon
> under the checkbox that allows you to move it into Priority or out of Priority."

**The checkbox.** The click always worked — the tile got `.selected`, the selection bar
appeared and said "1 selected". What never happened was the PAINT. Measured in the browser on
the live app, with the tile carrying `class="tile selected"`:

```
color:      rgba(0, 0, 0, 0)          ← .editable .tile .tilechrome .check   (0-3-1)
background: rgba(19, 24, 34, 0.44)    ← …the scrim, same rule
```

`.tile.selected .check` is 0-2-1 and loses. So both of its declarations were dead, and the
mark under them was a text `✓` painted in `color: transparent` — which meant the circle looked
identical checked and unchecked, in every density and both schemes. A control whose state
cannot be seen is a control that is not working, and that is exactly how it was reported.

**The lane control.** Moving an entry between lanes was a drag, or the entry sheet's Lane
picker. The drag is a good gesture and a poor discovery: nothing on the tile says the lanes
can be crossed, and on a touch device the drag starts with a long press.

## Why

- **Specificity, not `!important`.** The fix is to state every state of the circle at the same
  weight as the rule that draws it, so the cascade is decided by order and reads top to bottom.
  Raising one rule with `!important` would have left the next person the same trap.
- **An SVG, for the reason `.remove` already gives.** Its × has been an SVG since the chrome
  was built ("font glyphs drift off-center at fractional zoom"), and this file has a second
  note saying a `✓` is a tofu box in some fonts. The mark had no business being text.
- **`aria-pressed` rather than a class on an ancestor.** The state has to reach the control
  anyway, now that the control paints from it. A screen reader was previously told to ignore
  the only multi-select in the app.
- **The promote lands last, and that is the conservative reading.** A drag says where; a
  button cannot, so it must pick. The Priority lane plays in FILE order, so an entry dropped
  wherever its stored position falls can silently become the next thing that plays. Last in
  the lane means "before the pool, after everything already promoted", which is what
  promoting one entry out of a pool means.
- **Offered on every queue page.** Both lanes are drawn on all of them — a random-order
  queue's Priority lane is precisely where a promote goes — so gating this on the queue's own
  default would have hidden it on the queues that need it most. The first cut did exactly
  that, and the gate caught it.

## Evidence

Owner, 2026-08-26 (this session), with a screenshot of the Random pool showing empty rings:
*"Checkbox icon isn't working. Also, instead of right-click, I think we should add a 3rd icon
under the checkbox that allows you to move it into Priority or out of Priority."*

Measured on the deployed app before the change: a tile with `class="tile selected"` computed
`color: rgba(0, 0, 0, 0)` and the scrim background — the checked rule never applied.

Gate: `e2e/tile-lane-test.ts`, 16 checks, in CI on every PR (no Plex needed). It asks the
BROWSER what it painted, because nothing else can: tsc does not read CSS, Biome sees a string,
and axe passes an invisible glyph. It pins that the mark is invisible unchecked and opaque
checked, that the two states differ in fill, the `aria-pressed` announcement, both arrow
labels, that a promote PATCHes placement THEN order, that it survives a reload, and that a
demote writes no order. Unit tests cover `promotedOrder`. Shots:
`e2e/shot-tile-lane.ts [before|after]`, dark scheme, fixture data.
