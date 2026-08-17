# The Play landing reorders by drag, and a shelf's drop rewrites the whole order

- **Status:** Accepted
- **Date:** 2026-08-17
- **Type:** feature / ux
- **Supersedes:** —
- **Superseded by:** —

## Decision

Every row on the Play landing has a **drag handle**, and dragging reorders that shelf. All
three shelves get it: Filtered Pools, Curated Pools and Ordered Queues.

**A drop sends the COMPLETE set order**, with only the dragged shelf's own slots permuted
(`spliceOrder`). Every other shelf's rows, and every row a group filter is hiding, keep the
positions they had.

The handle starts the drag; the row does not. It is **quiet until the row is hovered** (always
visible on a coarse pointer, which has no hover to reveal it with). Touch **arms on a ~200 ms
long-press**, so a swipe still scrolls.

The reorder is applied **optimistically** to the local store before the PATCH.

## Context

> "I also have no way to reorder these items." — owner, 2026-08-17, with a screenshot of the
> Curated Pools and Ordered Queues shelves.

He was right, and it was worse than it looked: drag existed only on the **Queues configurator**
(`useHomeDrags`, whole shelves), so **Curated Pools and Filtered Pools could not be reordered
anywhere in the app**, and the landing — the screen the household actually opens — had no
reorder at all.

## Why

- **The gestures copy `useHomeDrags` deliberately**, because they are the same gesture: mouse
  past a threshold, touch on a long-press, transform-only movement, a single `insertBefore` per
  crossing, and the dragged node restored to where React last rendered it before any state
  update — skipping that last one is what produces `NotFoundError` on a later commit.
- **The whole order goes back because `reorderSets` ranks what it is told and appends the
  rest.** Sending one shelf's ids would sweep every other set to the end of `sets.yaml`. The
  same mechanism is what makes reordering correct under a **group filter**: a hidden row is not
  in the shelf's list, so its slot is never touched.
- **Optimistic is not polish here.** The drop restores the dragged node to React's position, so
  the row visibly snaps BACK until new data arrives — and waiting for `load()` holds that
  snap-back for as long as `/api/queues` takes, which is **7–9 s warm** against Plex.
- **The handle is quiet** because reordering is occasional; a permanent grip glyph on every row
  is chrome nobody asked for. It is `aria-hidden`: it is a pointer affordance, and it is not
  the only way to get anywhere.

## Evidence

- Owner quote and screenshot above.
- Gate: `e2e/play-reorder-test.ts` — browser, **no Plex**, its own server and files. It seeds a
  **filtered pool between two ordered queues in file order** and drags the third queue to the
  top. Its sharpest assertion is about the row it did *not* drag: *"the untouched pool did NOT
  get swept to the end of the file"*, which is exactly what a partial PATCH would have caused.
  It also drives the drag in **twelve small steps**, because the hook swaps on crossing a
  neighbour's midpoint and a single jump would test nothing about the crossing, and it reloads
  the page to prove the write rather than the optimistic DOM.
- 5 unit tests on `spliceOrder`, including the group-filter case and an id the full order has
  never heard of (a row deleted in another tab between the drag and the drop).
- One bug found by the gate and worth recording: the hook first kept its commit callback in a
  plain `{ current }` object rebuilt every render, so the listeners held the **first** render's
  closure — the one render where `GET /api/sets` had not answered, so the commit read an empty
  set list and returned. The drag worked, the drop did nothing, and nothing said why. It is a
  real `useRef` now.
