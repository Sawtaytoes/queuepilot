# Pending has a poster view and a list view, and neither one clamps the words

- **Status:** Accepted
- **Date:** 2026-08-22
- **Type:** UI
- **Supersedes:** —
- **Superseded by:** —

## Decision

The Pending screen gets the same choice the queue grid has always had: **Posters** or
**List**, a `SegmentedControl` at the top right, persisted for the screen
(`queuepilot:pending-view`).

- **Posters** — a wall of artwork with three **icon** controls: ＋ adds, a clock picks the
  start episode (shows only), ✕ dismisses. A 158px column cannot hold three named buttons.
- **List** — the poster beside the words at a fixed 84px, and every control keeps its name.
  Minimum column 400px, which is what "Add to ▾ / Start at… / Dismiss" measures beside that
  poster; at 330px they wrapped.

Two views and not three. The queue grid's middle density (Cards) exists because a queue entry
carries knobs a poster cannot show — a batch, a weight, a start point. A pending item has
none of that.

**Nothing is clamped and nothing is padded.** The title takes as many lines as it needs, the
library name follows it immediately, and the controls follow that — so within a row the
controls sit at different heights, and that is deliberate. **The poster is the only fixed
thing**: one 2:3 box, `object-fit: cover`, which is what keeps a row of artwork aligned when
Plex's own posters are not all the same shape.

`.pendingtile` no longer claims `block-size: 100%`.

## Context

The owner asked for both views, and rejected the uniform-card layout that had been drawn to
fix the ragged one:

> *"I think we can have both list and poster views."*

> *"The 'Movies' or 'Anime' being down a fixed-height. I thought about it, and I don't like
> that because I'm losing content and we're creating gaps. There are better ways to make this
> look, and those gaps are awkward. So for C, just put the buttons below where they can go.
> For D, same thing, just put the library name text up to the bottom of the title rather than
> a fixed-height below."*

What he was looking at before that: every tile's controls landed wherever its title ended, so
a three-line title dropped its buttons a row below its neighbours', and the posters were not
even the same height as each other.

## Why

**The poster is the right thing to fix, and the text is not.** Uniformity was never the goal
— alignment was. A row of artwork reads as a row when the artwork lines up; forcing the
*words* to a common height buys the same alignment by truncating titles and padding short
ones, which trades content for tidiness. The owner named the trade and refused it.

**Icons in the poster view, words in the list view.** The two views differ in what they have
room for, so they differ in the controls. `IconButton` requires a `label`, so the glyph never
carries the meaning alone — the accessible name and the tooltip both say the words.

**The glyphs are inline SVG, not characters.** `＋`, `⏱` and `✕` render as tofu in some
fonts. This repo already refused a `✓` glyph for that reason when the Watched chip was
written.

**`key={density}` on the grid.** `VirtualizedGrid` caches the row heights it measures, and a
340px poster tile and a 132px list row share nothing. Without the remount the first screenful
of the new view is laid out to the old view's heights.

## Evidence

- Owner (2026-08-22), both quotes above.
- The rendered comparison he chose from was served live from the workspace, not committed:
  it was drawn with the owner's own library artwork, and this repo is public
  (`2026-08-19-pr-screenshots-are-fixture-data-and-pinned-to-the-merge`).
- Screenshots: `docs/images/2026-08-22-pending-views-before.png` against `-posters.png` /
  `-list.png`, all from the stub-Plex fixture in `e2e/shot-pending-views.ts`.
