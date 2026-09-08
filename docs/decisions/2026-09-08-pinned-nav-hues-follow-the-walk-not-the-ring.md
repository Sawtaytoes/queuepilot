# Pinned navigation hues follow the walk, not the ring

**Status:** Accepted
**Date:** 2026-09-08
**Type:** UI / colour
**Supersedes:** —
**Superseded by:** —

## Decision

`NAVIGATION_CATEGORICAL` reads `CATEGORICAL_SEQUENCE`, not `CATEGORICAL_INDEXES`.

The map still exists and the landing tiles still pin their hues from it. Only the source
tuple changed.

## Context

The mode landing pins a hue per destination so the tile set and the navigation agree.
Queues is both the second primary action and the first management link, so without a pin
the two `ActionTiles` sets would each walk from their own index 0 and paint one
destination two colours.

The pin was built by reading `CATEGORICAL_INDEXES[position]` — the hue-ordered ring. That
gave the first two destinations index 1 and index 2, which are Red and Orange, 34 degrees
apart and the closest pair the palette has.

The owner reported it against the whole fleet:

> Now, the colors are in-order, so I get red and orange next to each other in my apps
> rather than contrasting colors like I used to have.

`@charcuterie/ui@4.3.0` answered that in the library: `ActionTiles` walks
`CATEGORICAL_SEQUENCE` instead of the ring. QueuePilot took the bump and **did not
change**, because a tile that names its own `categorical` keeps what it is given. Pinning
from the ring had opted this app out of its own fix. Every other app in the fleet moved;
this landing stayed Red beside Orange.

## Why

The pin is still right — one destination, one colour, is the reason it exists. What was
wrong is which tuple it read.

Reading the sequence keeps the pin and gets the spacing: Red, Lime, Blue, Pink, Amber for
the five destinations, with every neighbouring pair 105 degrees or more apart. The primary
pair is Red and Lime. The management row is Lime, Blue, Pink, Amber.

The 1-based lookup does not change and neither does the reason for it. The palette is
`1..10`, an `index as CategoricalIndex` over a zero-based position once produced a `0`,
and a `0` is `undefined` in every `Record<CategoricalIndex, …>` in the library — that took
the landing to a blank page with a green typecheck. Reading a value out of the tuple is
what makes the type honest.

## Evidence

The owner's report is quoted above, chat `f8d04598`. Before and after are committed beside
this record as `docs/images/2026-09-08-nav-walk-{before,after}-{light,dark}.png`, captured
from the landing in both schemes with `data-scheme` asserted on each shot.

Library change: `Sawtaytoes/charcuterie#243`. Library reasoning:
`docs/decisions/2026-09-03-the-ring-is-hue-ordered-and-the-walk-is-not.md` in Charcuterie.

## What this does not change

- That the landing pins a hue per destination.
- Which destination is which colour relative to the navigation — both read the same map.
- Any other colour in the app.
