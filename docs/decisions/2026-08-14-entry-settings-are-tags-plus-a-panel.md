# 2026-08-14 — Entry settings are TAGS plus one panel, and the queue view has a density

Status: Accepted
Date: 2026-08-14
Type: frontend (queue editor)
Supersedes: the always-on per-tile `episodes` dropdown from
  [2026-07-31-collection-tiles-are-member-first](2026-07-31-collection-tiles-are-member-first.md)
  (that decision's point stands — the control carried no "Play" label because it spoke
  for itself; what changes is that it is no longer always on screen), and the per-tile
  `batch_stops_at` dropdown from
  [2026-08-12-batch-stops-at-season-and-member-boundaries](2026-08-12-batch-stops-at-season-and-member-boundaries.md)
Superseded by: —

## Decision

**1. Settings show as tags; editing happens in one panel.**
A queue tile no longer carries a control per setting. An entry at its defaults shows
NOTHING; every tag it does show — `3 eps`, `3x as often`, `Ends at season`, `Start S2E1`
— is a deviation worth reading. Clicking a tag, or the tile's quiet `Edit` chip, opens
one panel (`#entrymodal`) holding all four. Each field writes on change (they are
separate PATCHes server-side), so the footer says **Done**, not Save.

**2. The queue has a VIEW: Posters / Cards / Rows.**
Same `li.tile` DOM in all three — only `app.css` reshapes it — so every e2e selector
(`li.tile`, `.thumb`, `.poster`, `.check`, `.remove`, `.cap`, `.title`, `.next`,
`.badges`) holds in every density and a density switch can never be a markup regression.

**3. Filtering a queue is not searching Plex.**
The box at the top only ADDS (now with type / library / year / watch-state filters —
the last two answered from what the section listing already carries, so neither costs a
request — and its results split out what is already in this queue, where picking one
jumps to that entry and opens its panel). A separate row above the grid FILTERS the entries you already have: free text,
type, state (including **Completed / fully watched**), and sort.

**4. Counts + weight are `1 / 2 / Custom…`.**
`CountPicker` offers the two common answers and hands over a real number field for
anything else. `episodes` is clamped server-side to the engine's own
`QUEUE_SERIES_LENGTH` (40), not a second smaller number.

**5. Density and filters persist PER QUEUE** (`queuepilot:view:<setId>` in
localStorage), and the toolbar always shows how many entries are hidden plus a
**Clear filters** button.

**6. Bulk edits.** The selection bar applies episodes / weight / batch-stop — or resets
to defaults — across the selection in ONE `PATCH /api/queues/bulk`, and is now flush to
the bottom edge, full width, square-cornered.

## Context

The owner reviewed a served HTML mock-up of three layouts (per
[2026-07-25 preview-UI-changes-as-served-HTML](../../../agentic/docs/decisions/2026-07-25-preview-ui-changes-as-served-html.md))
and answered:

> "I don't like A. I like B but without the `1 ep`. `2 eps` and beyond is fine… And the
> number of eps should be able to scale way past that. So it should be 1, 2, and custom
> where you can type into a number input… I think C is my preferred. It should also be
> 3-up or higher cards on wider screens. I also think we should have a view selector at
> the top which can slim down the UI to *not* display a bunch of extra info similar to
> the poster-view we have today… To summarize, I like the tags used in B because you can
> show only important info with them. I like the UI for C."

And, on the search box:

> "I don't see a way to filter down the current results… The goal for filtering (rather
> than searching), is the ability to modify the settings on an existing item AND to check
> if it's already in the queue."

Plus, mid-build: *"I want another filter option too that shows all 'watched' or
'completed' items to see if I wanna manually remove any. For instance, I'll be adding
season 2 to Frieren, so keeping it here 'completed' is fine."*

## Why

- **Four dropdowns per tile buried the tile.** A 45-entry channel rendered ~180 controls
  to say "default, default, default", and the two things a tile is FOR — which show it is
  and what plays next — competed with them. Tiles also grew unequal heights as controls
  appeared, so the grid raggedly reflowed (visible in the before/after on the PR).
- **A default should be silent.** Weight makes this sharper: `1x` on every tile is noise
  on a wall of posters, while `3x as often` on one tile is the whole point.
- **A filter that hides entries must say so.** Hence the always-visible
  "showing N of M" + Clear filters: a forgotten filter is otherwise indistinguishable
  from a queue that lost its contents.
- **One bulk request, not N.** Every `queues.*` writer takes the cross-process YAML lock
  and rewrites the whole file; a 20-entry selection fired as 20 PATCHes is 20 locks, 20
  rewrites and a half-applied edit if one loses the race.

## Evidence

- Mock-ups served at `…temp.t3code.example.com` and reviewed by the owner, 2026-08-13/14.
- Before/after screenshots on the PR, driven against the real app with the live
  `queues.yaml` copied to `/tmp`.
- Gates: `web` typecheck + 40 unit tests, `e2e/yaml-roundtrip-test.mjs` (weight writes
  preserve comments and drop at 1), the four golden-corpus parity gates, and
  `e2e/kbd-undo-test.mjs` driving the rebuilt grid.
