# The whole card is the drag handle — on a fine pointer

**Status:** Accepted
**Date:** 2026-08-19
**Type:** UX / frontend interaction
**Amends:** [the-landing-is-one-wrapped-grid-of-typed-cards](2026-08-19-the-landing-is-one-wrapped-grid-of-typed-cards.md)
(same day; the grid, the kinds and the one-order drag all stand — only where the drag STARTS
changes) and the "only the handle starts a drag" clause of the 2026-08-17 landing-reorder work
**Superseded by:** —

## Decision

On a **fine** pointer the grip glyph is not rendered at all and **the card itself starts the
drag**. `cursor: grab` is the affordance the glyph used to be, and it costs no layout.

On a **coarse** pointer the glyph stays, always visible, and is still the only place a drag can
begin.

A press that lands on a link, a button or a listbox is never a drag — the name still navigates,
Play still plays. The existing 6px threshold is what keeps a plain click a click.

## Context

> "I don't like how this looks. The drag 'n drop is taking up precious space and leaving a huge
> margin, but it doesn't need to. If it's only on hover, then make the whole card draggable."
> (owner, 2026-08-19, with a screenshot)

The glyph sat in the card's first line as a flex item: `opacity: 0` until hover, but holding its
~22px of gutter at every moment. So every name on the page was indented past an empty column
that showed something 1% of the time — and on a 320px card that gutter is 7% of the width, which
is the difference between "Bob & Alice — Movies" fitting on one line and wrapping onto two.

## Why

- **Hiding a control with `opacity` does not give its space back.** That is the whole bug. The
  choice was between reserving the space permanently and not having the control in the layout;
  making the card grabbable is what allows the second.
- **The original objection was answerable.** "Only the handle starts a drag; the card is a link
  and its button plays things, so a whole-card drag would fight both" — true of a naive
  implementation, and avoided by skipping presses that land on an interactive descendant. The
  gesture already had a movement threshold, so a click was never at risk.
- **Touch genuinely cannot have this**, and the split is not timidity. Whole-card touch dragging
  needs `touch-action: none` on the card, and the card is the surface the page is scrolled
  by — the landing would stop scrolling under a finger. The handle is the only element that
  opts out of scrolling, so on touch it has to stay. It is always visible there because there is
  no hover to reveal it with, and a coarse pointer has the screen space for it in a way a
  four-across desktop grid does not.
- **CSS decides which mode applies, not React.** `@media (pointer: fine|coarse)` is the same
  fact the hover rule already keyed on, and keeping the element in the DOM means no re-render
  when a hybrid device changes pointer.

## Consequences

- `.playcard .rowdrag` is `display: none` by default and restored inside
  `@media (pointer: coarse)`. `cursor: grab` moves onto `.playcard` inside
  `@media (pointer: fine)`.
- `useRowReorder`'s `onDown` no longer requires `.rowdrag`: it requires a card, refuses touch
  without the handle, and refuses any press whose target is inside
  `a, button, input, select, textarea, [role="combobox"], [role="listbox"]`.
- The landing's sub-line drops the glyph it was naming — "Drag a card to reorder."
- `e2e/play-reorder-test.ts` grows three assertions that are the actual risk of this change:
  the name still navigates, the start button still opens its menu, and a coarse-pointer context
  still gets a handle whose computed `display` is not `none`. It also asserts the gutter is gone
  by computed style rather than by looking for the element.

## Evidence

Measured on the fixture landing at 1420px after the change: `.playcard` left edge 26.5px, its
name's left edge 39.5px — a 13px gap that is the card's own padding, with no reserved column.
`getComputedStyle(.rowdrag).display` is `none`, and the card's cursor is `grab`.
`play-reorder-test` 14/14 PASS, including both drag axes.
