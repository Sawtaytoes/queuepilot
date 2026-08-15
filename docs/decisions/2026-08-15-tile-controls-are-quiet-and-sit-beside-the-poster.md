# 2026-08-15 — Tile controls are QUIET, and in `cards`/`list` they sit beside the poster, not on it

Status: Accepted
Date: 2026-08-15
Type: frontend (queue editor / tile chrome)
Supersedes: the always-on, always-overlaid `.check`/`.remove` placement introduced with the
  densities in
  [2026-08-14-entry-settings-are-tags-plus-a-panel](2026-08-14-entry-settings-are-tags-plus-a-panel.md)
  — specifically its point 2 clause that the three densities reshape the SAME DOM by CSS
  alone. The DOM moved (see "What this costs" below); everything else in that decision stands.
Superseded by: —

## Decision

**1. `.check` and `.remove` are hidden until you ask for them.**
Transparent at rest; revealed on `:hover` or `:focus-within` anywhere in the tile, and on
`.selected` (a ticked ✓ is *state*, not an affordance, so it stays lit whatever the pointer
is doing). Under `@media (hover: none)` — a touch device, where there is no hover to wait
for — they are simply always on.

**2. In `cards` and `list` they are LAID OUT, not overlaid.**
Those two densities become four-column grids — `✓ | poster | text | ✕` — so each control
gets its own gutter and neither one ever covers artwork. `posters` (and the channel member
grid, which has no density class) keeps the overlay: a full-size poster can afford it.

**3. The density formerly labelled "Rows" is called **List**.**
Label only. The stored value stays `rows`, so every persisted per-queue density, every
`ul.grid.rows` selector and every e2e read keeps working.

**4. A tile gets a ▶ that starts THAT entry.**
Centred on the poster in every density, hover-gated like the rest. This one *does* stay on
the artwork: it is about the thing in the picture, it is only there while you hover, and it
is where Plex puts the same control. Selecting exactly one entry also puts **▶ Play on ▾**
at the head of the selection bar. Both open the ordinary device menu — nothing in this app
plays without naming a device.

## Context

The owner reviewed the shipped densities against the real Anime channel and reported, in
order: the ✕ "is taking up most of the poster art" in the row view; the same two controls
"take up a ton of space" in cards and "should be in the card, not on the item"; and that
neither "should show up unless you're hovering or are on a touch device". He also pointed at
Plex's own hover state — a ▶ over the poster — and asked for the same reach-in-and-play from
here.

The row thumb is 40px. A 28px ✕ on it is not a control on a poster; it *is* the poster. The
first attempt at this had shrunk the button (`transform: scale(.75)`), which only made a
smaller thing sit on top of the same artwork — the placement was the problem, not the size.

## Why

**Off the poster, rather than smaller on it.** A gutter costs ~24px of a 340px card and
nothing at all in a full-width row, and it is reserved whether or not the control is
currently visible — so revealing on hover shifts no layout. Scaling could never win: the
thumb is 40px, and any control large enough to hit is large enough to cover it.

**Quiet by default.** Two always-on buttons per tile turned a wall of posters into a wall of
buttons, and neither is something you reach for while browsing. `opacity`, not `display`, so
Playwright's actionability checks (and therefore `verify-members` / `verify-member-optimistic`,
which click `.remove` without hovering first) are unaffected — both suites pass untouched.

**`hover: none`, not `pointer: coarse`.** Coarse also matches a games controller, and a
hover-capable stylus should still get the quiet treatment.

**Narrowing the ENTRY LIST is what makes ▶ honest.** `only` is applied at
`provider.buckets`, *before* the resolver, so the named entry goes through the same
next-unwatched / episodes-per-play / resume-offset machinery it would have got when the queue
reached it on its own. A one-entry start is the normal start with a shorter list — not a
second playback path that can drift from the first. Critically, an entry that is finished or
no longer in the file plays **nothing**: falling back to the queue's head would start
something the owner did not click.

## What this costs

The 2026-08-14 decision promised the densities were CSS-only over a fixed DOM, so a density
switch "can never be a markup regression". That is no longer strictly true: `.check` and
`.remove` moved out of `.thumb` to become its siblings, because a child of the poster cannot
be given a grid column of the tile. The *class contract* is intact — `li.tile`, `.thumb`,
`.poster`, `.check`, `.remove`, `.cap`, `.title`, `.next`, `.badges` all still exist on the
same tile — and every e2e selector is a descendant match (`li.tile .remove`), so nothing
broke. But a suite that asserted `.thumb > .remove` would have, and the guarantee is now
"same classes, same tile", not "same tree".

One trap, recorded because it cost a build: with the row left implicit, grid auto-placement
dropped `.cap` onto a second row. `.remove` precedes `.cap` in the DOM (tab order: select,
entry, remove) but sits in a *later* column, and auto-placement only moves forward — so
`.cap` could not get back to row 1. Every child is pinned `grid-row: 1` explicitly.

## Evidence

Owner, reviewing the live channel (2026-08-15):

> "The 'Rows' view should be called 'List'. In this view, the X to delete should be somewhere
> else. Maybe on the left? It's taking up most of the poster art."

> "I also think the X and Check shouldn't show up unless you're hovering or are on a touch
> device."

> "For those same controls in the Cards view, they should be in the card, not on the item as
> they also take up a ton of space!"

> "I also like that I can play right from here. It would be nice to have that from QueuePilot
> where I can select one in the list and just start that directly."

He asked for the ✕ "maybe on the left"; it went to the **right** gutter with ✓ on the left,
which is the conventional pairing (select leading, destructive trailing) and satisfies the
actual complaint — that it was on the artwork. Worth a second look if he disagrees.

Gate: `e2e/play-one-entry-test.mjs` (12 assertions, offline, in CI's engine block).
Shots: `__screenshots__/tiles-{posters,cards,list}-{rest,hover}-after.png`.
