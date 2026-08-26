# The queue page is two lanes, and the drag across the divider is the promote

- **Status:** Accepted
- **Date:** 2026-08-26
- **Type:** UX / interaction
- **Supersedes:** —
- **Superseded by:** —
- **Builds on:** [kind-is-picks-or-rules](2026-08-23-kind-is-picks-or-rules.md) §2 — which
  defined the lanes in the DATA, and left the page showing one flat grid

## Decision

A Picks queue's page is **two stacked sections**:

| Lane | Order | Drag |
| --- | --- | --- |
| **Priority queue** | FILE order — what the engine plays | reorder within it, and it is the promote target |
| **Random pool** | ALPHABETICAL, for lookup | not hand-orderable; dragging out of it is the promote |

- Dropping a tile in the other lane writes its `placement` — a **promote** upward, a
  **demote** downward. `placement` first, then the order, both in one gesture.
- **Both lanes are always drawn.** The empty one is a slim dashed **drop strip**, not the
  app's `EmptyState` box, and not nothing.
- **The pool is not hand-ordered.** A drag that begins and ends in it saves nothing at all.
- Stacked, never side by side.

## Context

The lanes shipped in the data on 2026-08-26 and the page did not change: one grid, and a
promoted entry was a chip on a tile somewhere in it. The owner's first use of it:

> *"I can't reorder the priority items. I was hoping they'd show up at the top of the list,
> and I could organize them, then there'd be another section for that unordered ones, and I
> could drag 'n drop between the two."*

Every part of that was already true underneath — the engine takes the Priority lane in file
order, and `/queues/:set/order` writes file order — and none of it was reachable, because
one grid cannot show which half of itself plays first.

## Why

- **The gesture already means "change the order", so it should mean "change the lane" too.**
  Promoting through the entry sheet's Lane picker works and is two clicks and a panel away
  from the thing you are looking at. The drag is the direct manipulation of the same fact.
- **The empty lane is a drop STRIP because it has to have height at all.** An empty `<ul>`
  is zero pixels tall, so a queue with nothing promoted would have nothing to aim at — and
  that is the exact case the feature exists for. It is a strip rather than a box because it
  is a drop target the width of the grid, not an explanation.
- **The pool is not hand-ordered because its order does not survive playback.** It is
  shuffled. Offering a gesture that saves a number nothing reads is a lie the file then
  keeps. The owner chose this over a consistent gesture:
  *"No, lock the pool to a sort."*
- **Stacked, not side by side, and that is the grid rule.** Each lane holds poster tiles,
  which are card-shaped and want a responsive grid that gains columns as its container
  widens ([workspace rule](https://mkdocs.octen.dev/workspace/agentic/)). Two columns of
  lanes would halve the width each grid has to do that in, on the widest window, on a page
  whose whole job is showing artwork.
- **The page-wide alphabetical sort became the POOL's sort.** A random-order queue used to
  list its whole page alphabetically. That was right when the page was one pool and wrong
  the moment half of it is an ordered queue being edited.

## Charcuterie first — surveyed, and this is not that shape

`@charcuterie/ui` ships a **`Board`** (`useBoardDrag`, `BoardCard`, `BoardLaneList`) whose
description matches this almost word for word: lanes of cards, moved between lanes by
pointer or keyboard, with the move handled as a first-class operation. It was read before
any of this was written.

It is the wrong component here, for a reason that is about the CARD and not the board.
`BoardCard` is a text row in three shapes — two lines, one line, or a card — chosen by the
lane's container width. A queue tile is a **poster**: artwork, badges, an edition chip, a
play control, a remove ✕, in three densities the owner switches between. `BoardItem` cannot
carry one, and a lane that is a single-column list cannot lay a wall of them out.

So the shared shape stays Docket's, this page keeps its own grid, and what got extended is
this app's `useGridDrag` — which already owns the 2D slot geometry, the tap-versus-drag rule
and the no-re-render-during-drag constraint that a poster grid needs and a text board does
not. If a second app ever wants a poster wall in lanes, THAT is the thing to move upstream.

## Evidence

- Owner, 2026-08-26, quoted above, and on the two open questions: the empty lane is
  *"a slim labelled drop strip"*; the pool is *"lock the pool to a sort"*.
- `e2e/lane-drag-test.ts` — nine assertions over a real pointer drag: the promote, the order
  that follows it, placement-before-order, the demote, the empty lane as a target, and the
  pool drag that writes nothing.
- `e2e/drag-stability-test.ts` still passes unchanged in behaviour (0 reversals, 2
  re-inserts, 12 style writes) — its insert counter had to be retargeted at the lane,
  because `#grid` is the container now and the old test would have counted zero and passed
  while measuring nothing.
