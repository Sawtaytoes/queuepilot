# The mode landing is two `ActionTiles`, not eight hand-written links

**Status:** Accepted
**Date:** 2026-09-03
**Type:** UI / component adoption
**Supersedes:** —
**Superseded by:** —

## Decision

The front door at `/` draws its two starts and its four management links as two
Charcuterie `ActionTiles` sets (`@charcuterie/ui@4.1.0`).

```tsx
<ActionTiles
  className="mode-primary-actions"
  items={PRIMARY_TILES}
  label="Start something"
  minTileInlineSize={420}
  size="lg"
/>
…
<ActionTiles
  items={MANAGEMENT_TILES}
  label="Manage"
  minTileInlineSize={200}
  size="sm"
/>
```

Six CSS rule groups are **deleted** from `app.css`, not adjusted:
`.mode-primary-action`, `.mode-primary-icon`, `.mode-action-arrow`,
`.mode-management-link`, `.mode-management-icon`, `.mode-management-arrow` — plus their
`grid-template-columns` in the 760px media query. `.mode-primary-actions` survives as one
property, `margin-top`, because the gap to the intro above the set is still this page's to
state.

The `→` and `›` glyphs go with them. `ActionTiles` draws no arrow, and a card that is
plainly a card does not need one to say it is pressable.

Each destination gets a **named** hue, `NAVIGATION_CATEGORICAL` in
`PrimaryNavigation.tsx`, rather than the position each set would otherwise take.

The queue-type chooser is unchanged in structure — it has been an `ActionTiles` since
[2026-09-01](2026-09-01-the-queue-type-chooser-is-an-actiontiles-not-two-buttons.md) — but
its two tiles gain an `icon`, so the new colour lands on a glyph instead of only the left
bar.

## Context

The owner, looking at four apps side by side:

> mux-magic, points-market, and gallery-downloader have nice tiles. I'd like those to
> exist in Charcuterie. I don't like what we built for QueuePilot. It's not as flashy.
> Very boring, not colorful.

Three of those four had grown the same card independently, and each had coloured it
itself. Charcuterie took the shape and the colour on 2026-09-02: an `ActionTiles` walks a
ten-hue categorical palette in order, sits the icon beside the name, and hovers in the
tile's own hue. mux-magic, gallery-downloader and points-market adopted it the same day.
QueuePilot is the fourth, and the one the complaint was actually about.

Its landing was eight hand-written `<Link>`s under `.mode-primary-action` and
`.mode-management-link`: one accent colour for every glyph on the page, a neutral border
that went accent on hover, and an arrow character standing in for affordance. Nothing was
wrong with it. It just said the same thing eight times.

## Why

**The library owns the shape; the app owns the destinations.** `PrimaryNavigation.tsx`
already held the hrefs and the glyphs, with the comment *"The app owns the destinations
and glyphs. Charcuterie owns every layout they take."* The landing was the one layout
still drawing its own box. Deleting the rules rather than trimming them is the point: a
leftover rule here repaints one app's copy of a shape four apps now share, which is the
drift the component exists to end.

**A hue is named per destination, not taken per set.** The landing draws Queues twice —
once as the second primary start, once as the first management link. Two `ActionTiles`
sets each walk the palette from their own first index, so the one destination would have
been two colours and the eye would have read two places. `NAVIGATION_CATEGORICAL` is keyed
by `href`, because that is the identity a destination has here; the label is prose and has
been rewritten twice already.

**The column count comes from the container.** Both `grid-template-columns` declarations
and both of their media-query overrides are gone. A 600px panel on a 2560px monitor is
exactly as narrow as a phone, and a `max-width: 760px` query could never see it.

## Evidence

The owner's complaint, chat `f8d04598`:

> mux-magic, points-market, and gallery-downloader have nice tiles. I'd like those to
> exist in Charcuterie. I don't like what we built for QueuePilot. It's not as flashy.
> Very boring, not colorful.

And on the icon's place, which is why `ActionTiles` puts it beside the name rather than
above it:

> I like how Mux-Magic looks today with the icon to the left of the title.

**The palette is 1-based, and a type assertion hid an off-by-one.** The first draft built
`NAVIGATION_CATEGORICAL` as `index as CategoricalIndex` over the array position, so the
first destination got a `0`. `CategoricalIndex` is `1..10`; every lookup inside the library
is a plain `Record<CategoricalIndex, …>`, so the 0 resolved to `undefined` and the tile
died reading `.ghost` off it. The landing rendered as a blank page.

Nothing in the toolchain reported it. `as` is an assertion, so `tsc` believed the claim
instead of checking it; lint has no opinion about arithmetic; the unit suite does not
render the landing. It was a browser that caught it, one probe after the build. The fix is
to read the value out of `CATEGORICAL_INDEXES` — which needs no cast, because indexing the
tuple already yields the union.
