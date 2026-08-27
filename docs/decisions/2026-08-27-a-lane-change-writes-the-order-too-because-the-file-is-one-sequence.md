# A lane change writes the order too, because the file is one sequence

- **Status:** Accepted
- **Date:** 2026-08-27
- **Type:** Data write / consistency
- **Supersedes:** point 5 of [A tile carries a lane control, and the select mark actually
  paints](2026-08-26-a-tile-carries-a-lane-control-and-the-select-mark-paints.md) — the rest
  of that record stands
- **Superseded by:** —

## Decision

1. **Every button-driven lane change writes `placement` and then the order.** The promote,
   the demote, "Play this next", and the selection bar's bulk apply. There is no case that
   writes one half.
2. **`moveEntryLane` is a toggle wrapper over `setEntryLane`, and computes nothing.** The
   arrow on a tile and the tile menu's two lane rows are the same write with different words
   on them.
3. **`orderAfterLaneMove` is the only function that decides a post-move file order.**
   `promotedOrder` is deleted. A second one is a regression, not a feature.

## Context

The tile's ↑ / ↓ arrow and the tile menu's lane rows were built four days apart, on branches
that were open at the same time, and each grew its own order helper — `promotedOrder` for the
arrow, `orderAfterLaneMove` for the menu. Rebasing the second onto the first put both in one
tree, where their two gates asserted opposite things about one operation:

| Gate | Claim about a DEMOTE |
| --- | --- |
| `e2e/tile-lane-test.ts` (the arrow) | writes NO order |
| `e2e/tile-menu-test.ts` (the menu row) | writes placement, THEN the order |

Both passed on their own branch. Neither could pass on both.

## Why

**The file is one sequence.** `sets.yaml` holds a single ordered list, and the lane an entry
is in comes from `placement`. An entry that is demoted but left in the middle of the priority
run leaves the file saying two things — and the next promote re-sequences it anyway, because
`orderAfterLaneMove` rebuilds priority-then-random from the placements it reads. So the
"saved" write was deferred, not avoided.

**The drag already writes both**, and the arrow's own comment says it is "the same write the
drag across the lane divider makes". It was not.

**Nothing on screen changes either way.** `splitLanes` re-derives both lanes from `placement`,
so this is a claim about the FILE, not about what anybody sees. That is precisely why it was
free to drift: no screen could show the disagreement, and only the two gates could.

The superseded reasoning was not wrong on its own terms — the pool IS shuffled at playback, so
the pool's own order means nothing. It just does not follow that the file's order can be left
contradicting the lane.

## Evidence

Found while rebasing PR #227 onto `main` after PR #233 merged, 2026-08-27. `tile-lane-test`
failed on exactly one check:

```
FAIL the demote writes NO order — the pool is shuffled, so its order means nothing
     — writes: placement → order
```

`tile-lane-test.ts` now pins the order write and that `placement` still goes first;
`tile-menu-test.ts` is unchanged in what it claims. Unit coverage moved from `promotedOrder`
to `orderAfterLaneMove`, including the "a key that is not in the queue is a no-op" case that
only the deleted helper had tested.
