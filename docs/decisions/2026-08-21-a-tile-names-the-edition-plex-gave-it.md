# A tile names the edition Plex gave it, in ONE chip

- **Status:** Accepted
- **Date:** 2026-08-21
- **Type:** fix / ux
- **Supersedes:** —
- **Superseded by:** —

Completes [2026-08-21 — every picker names the edition, and the entry it writes carries it
too](2026-08-21-every-picker-names-the-edition-and-the-entry-it-writes-carries-it.md), which
fixed the SEARCH rows and stopped there.

## Decision

1. **A poster tile shows Plex's edition label** whenever the resolved item has one. The queue
   grid, the Ordered Queues shelf and a pool's member grid all gain it, because all three
   render the same `TypeBadge` row.
2. **ONE chip carrying the label — not the Collection chip's two-part `kind` + `name`.**
3. It is a Charcuterie `Badge`, `appearance="outline"`, `intent="neutral"`, `size="sm"`,
   `className="badge edition"` — the same chip `Not in library` and `N watches` are.
4. **The plain edition stays plain.** Plex tags only the non-default item of a pair, so the
   twin renders nothing. No "Standard" label, matching the search row's rule.
5. **A collection's borrowed face claims no edition.** `tileFace()` sets `edition: null` on
   that branch.
6. The chip is a **new component (`EditionChip`, in `components/badges.tsx`)**, not a second
   caller of `components/EditionBadge.tsx`.

## Context

Owner, 2026-08-21:

> "Queue tile should show the edition like it renders 'Collection'"

The data existed and died one layer short of the wire. `plex.posterFields()` has set
`editionTitle` on every resolved movie/show since #139. `tiles.resolveTile()` — the ONE tile
resolver, shared by `/api/queues` and `/api/sets/:id/members` — copied `title`, `year`, `type`
and `childCount` off that object and never copied `editionTitle`. So a pick made in a picker
that correctly named the edition landed in a queue as one of two identical captions.

Both routes spread `...core`, so the field reaches the wire on both the moment the resolver
emits it; nothing in the route layer had to change.

## Why

### One chip, not two halves

The Collection chip is two-part because a bare collection NAME is indistinguishable from a
title: "Chaika: The Coffin Princess" needs the word "Collection" in front of it to say what
kind of thing it is. An edition label does not have that problem — nobody reads "Director's
Cut" or "3D" as a film title.

And the two-part shape costs the wrong half. A poster-wall tile is ~150px wide, and 132px in
the Narrow View. A fused "Edition" kind would spend most of that on the constant word and
ellipsise the variable one — the reader would get `Edition | Direct…` where the whole
question is *which cut is this*.

The kind is not lost, it moves to the hover: the tip reads `Plex edition: "…"`.

### Neutral, and that is not a free choice

[2026-08-15 — a badge intent means exactly one thing](2026-08-15-badge-intent-means-one-thing.md)
assigns every intent: `accent` = In Progress, `success` = Completed, `info` = Now playing,
`danger` = Not in library, `neutral` = every count and every NAME. An edition is a name, so it
is neutral. Note this is a **different** treatment from the search row's `.editionbadge`, which
is accent-outlined — that class lives inside `.results`, where no state axis competes for the
colour.

### It does not re-open the noise the type cull closed

The same record deleted the type chip because it fired on **every** tile and repeated what the
poster already said. This chip fires only when Plex actually tagged the item, which is rare —
in the fixture grid below, six of eight tiles render nothing. A chip that appears on two tiles
out of eight, and appears exactly because those two are otherwise identical, is the opposite
of the thing that was removed.

### A `Badge`, unlike the collection chip

The collection chip stayed hand-rolled because `Badge` puts its children in a single ellipsising
label span, which would have collapsed its two halves into one run of text. One label has no such
problem — and using the component is what brings `max-inline-size: 100%` plus the ellipsis, which
is the whole of the truncation handling. No new CSS rule was needed at any density.

One deliberate override: the chip passes `title=""`. `Badge` sets a native `title` of its own once
its label clips, which is exactly when this one clips, and a native tip beside the styled `Tip`
is the same sentence twice about 800 ms apart.

### A separate component from the search row's `EditionBadge`

`components/EditionBadge.tsx` renders `<span className="editionbadge">` and its only styling is
`.results .editionbadge` — an accent-outlined pill scoped to a search dropdown. Sharing it would
mean either putting accent (which means In Progress here) into the tile's badge row, or changing
how every picker looks. The two are the same FACT in two visual families, so they are two
components with one rule written down here.

## Not done

- **A collection MEMBER's edition.** `CollectionNextEp` carries `member`, `memberRatingKey` and
  `memberYear`, and no edition — so a collection tile borrowing a member's face says nothing
  about that member's cut. Reachable by adding the field to the next-up payload; nobody has hit
  it, because a collection holding both cuts of one film is not a shape Plex encourages.
- **The eligible-pool tiles in `ChannelPool.tsx`.** Those render from `/api/sets/:id/preview`
  buckets, not from `TileEntry`, and carry no edition field at all. The rewatch movie pool is
  where it would matter.
- **Existing entries are not rewritten**, exactly as the picker decision settled. The chip reads
  Plex live through the `ratingKey`, so an old entry gets it anyway.

## Evidence

- Owner quote above.
- Gate: `web/src/lib/tileFace.test.ts`, `tileFace` — a tagged edition reaches the face, the plain
  one stays null, an explicit null and an absent key agree, a long label is not shortened on the
  way, and a collection's borrowed face claims none.
- Before/after against a **stub** Plex, from `e2e/shot-tile-edition.ts`:
  `docs/images/2026-08-21-tile-edition-{grid,shelf,narrow}-{before,after}.png`. The library in
  them is invented — the shot must show one title TWICE, and the real pair would be the
  household's.
- The Narrow View frame is the poster wall at 390px, where `--tile` is 132px. The long label
  ellipsises inside the chip, the caption keeps its height, and the script asserts
  `scrollWidth - clientWidth` is not positive (it measures -15).
