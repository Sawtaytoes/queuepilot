# The tile menu carries what the card cannot, and Remove is not one of those things

- **Status:** Accepted
- **Date:** 2026-08-26
- **Type:** UX / interaction
- **Supersedes:** —
- **Superseded by:** —
- **Builds on:** [the queue page is two lanes](2026-08-26-the-queue-page-is-two-lanes-and-the-drag-is-the-promote.md)
  — which made the promote a DRAG, and left it reachable no other way

## Decision

The tile context menu (right-click / long-press) holds only actions the **card does not
already carry**.

| Row | Where it appears | What it does |
| --- | --- | --- |
| **Play this next** | a queue entry not already leading the Priority queue | promote, and put it at the HEAD of that queue |
| **Move to the Priority queue** | a queue entry in the Random pool | promote, appended to the END of the Priority queue |
| **Move to the Random pool** | a queue entry in the Priority queue | demote |
| **Start from an episode… / Start automatically** | a startable entry | the manual start point |
| **Skip “<item>”** | an entry with a leaf to skip | drop the one item, keep the entry |

- **Remove is NOT a row.** Every editable grid puts a ✕ on the tile
  ([decision](2026-08-21-any-tile-in-an-editable-grid-gets-the-remove-control.md)), so the
  menu must not repeat it.
- An entry with **none** of these rows opens **no menu at all**. `openTileMenu` no-ops
  rather than painting an empty box.
- The **selection bar** gains a **Lane** field, so the same promote or demote applies to a
  whole selection. It settles the ORDER behind the write, so the moved entries land at the
  end of their new lane instead of at their old file positions.

## Context

The lanes shipped the day before. A promote was a drag across the lane divider and nothing
else. The owner, on a tablet:

> *"QueuePilot pools, touch holding on an item gives the option to remove from the queue,
> but I'd prefer options that aren't on the card such as 'make priority' or 'deprioritize'
> or 'remove all from queue' etc."*

Both halves of that were true on screen. A long press on a queue tile opened a menu holding
exactly one row — *Remove from this queue* — six pixels from the ✕ that already does it.
And the two actions a menu is genuinely for, the promote and the demote, were a drag
gesture: hard to aim with a finger, and impossible to find if nobody tells you.

The *"remove all from queue"* half was withdrawn in the same conversation and replaced by
the real gap:

> *"Sorry, that's when you use the checkbox. I conflated two ideas. You can't switch
> priority of a group or remove a group from the pool."*

The selection bar could re-weight, re-batch, move between queues and remove — but not
change a lane, because a lane was only ever a drag, and a drag is one entry at a time.

## Why

- **A menu that repeats the card is a menu with nothing in it.** The test for a row is not
  "is this action useful" but "can the card already do it". Remove fails that test
  everywhere the menu appears, because the ✕ rule is fleet-wide.
- **The promote needed a non-gesture door.** A drag is direct manipulation and stays the
  fast path; it is not a discoverable one, and on touch it competes with the scroll.
- **"Play this next" is a separate row because the lane rows cannot reach the head.**
  "Move to the Priority queue" appends, so a promote never displaces what is already
  promoted. Putting an entry FIRST is the other thing somebody wants, and it is one row.
- **A promote lands at the END of its new lane rather than at its file position.** The pool
  is displayed alphabetically and shuffled at playback, so an entry's position in the file
  means nothing to anyone looking at the screen; dropping it into the middle of the Priority
  queue would read as arbitrary. One function decides this for the menu and for the
  selection bar — `state/queueView.orderAfterLaneMove` — so the two cannot drift.
- **An empty menu is worse than no menu.** A rules channel's curated member that is a movie
  has no start point, no leaf to skip and no lane, so its menu would have been a blank box.
  The long press does nothing instead, and the ✕ is still on the card.
- **A lane is not an "override", so `Reset to defaults` does not clear it.** A lane is where
  the entry IS. Folding it into reset would silently demote a selection somebody only meant
  to put back to 1x.

## Evidence

- Owner, 2026-08-26, both quotes above.
- `e2e/tile-menu-test.ts` — the menu's rows, the absence of Remove, both lane writes
  (`placement` first, then the order, as the drag does), the head-of-queue order that
  "Play this next" writes, and the selection bar's Lane field applied to two entries.
- `web/src/state/queueView.test.ts` — `orderAfterLaneMove` and `effectiveLane`: the
  promote-to-the-end, the play-next-to-the-head, the demote, a bulk move that keeps the
  selection's relative order, and the file staying one priority-first sequence.
