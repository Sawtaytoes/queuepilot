# New Picks land at the end, and Priority order is directly editable

- **Status:** Accepted
- **Date:** 2026-08-29
- **Type:** Interaction / queue ordering
- **Supersedes:** the visible Add-to-position controls in the Picks toolbar and queue search
- **Superseded by:** [New Picks land at the top](2026-08-29-new-picks-land-at-the-top.md) (addition placement only)
- **Builds on:**
  - [the queue page is two lanes](2026-08-26-the-queue-page-is-two-lanes-and-the-drag-is-the-promote.md)
  - [the tile menu carries what the card cannot](2026-08-26-the-tile-menu-carries-what-the-card-cannot.md)

## Decision

Adding a title through either Picks search appends it to its queue. The Picks toolbar and the
queue search do not ask **Add to Top / Bottom** before each add.

Each Priority-queue tile shows its one-based position. The position is an editable number.
Changing it moves that entry to the requested Priority position and preserves the Random
pool after the ordered run.

Checked entries get direct **Move selected to Priority** and **Move selected to Random pool**
actions. One action moves the selection as one ordered group. The existing bulk write and
`orderAfterLaneMove` remain the implementation so the moved group keeps its relative order
and lands at the end of the destination lane.

The Picks toolbar does not carry a **Rules** link. The primary navigation already provides
that destination.

## Context

The toolbar asked where every new result should land even though each tile already has a
direct lane control and the queue page supports drag ordering. The selection bar could move a
checked group, but it hid that action behind a Lane picker plus Apply. Priority order had no
visible numbers, so a person had to infer it from poster position and drag to change it.

The owner asked to remove the Add-to control, make checked entries move together, show
Priority positions as `1`, `2`, and so on, and allow a position number to move an entry. The
owner also said the Picks-page **Rules** link is redundant beside the new navigation.

## Why

- Appending is predictable and does not displace an existing Priority plan.
- The tile's lane button answers Priority versus Random pool directly.
- A visible number makes the engine's play order explicit.
- A direct group action reveals capability that already existed but was difficult to find.
- The navigation rail is the one primary-navigation mechanism.

## Evidence

- Owner, 2026-08-29, current conversation and attached images 5 and 6.
- `state/queueView.orderAfterLaneMove` already preserves a selected group's relative order.
- `e2e/tile-menu-test.ts` already proved that the bulk placement write and the order settle
  occur together.
