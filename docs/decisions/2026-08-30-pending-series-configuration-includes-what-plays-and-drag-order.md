# Pending series configuration includes what plays and drag order

- **Status:** Accepted
- **Date:** 2026-08-30
- **Type:** UI / interaction
- **Supersedes:** The start-only scope in [Pending collections can pick a start point before the add](2026-08-30-pending-collections-can-pick-a-start-point.md)
- **Superseded by:** —

## Decision

The Pending control for a show or collection is **Configure…**, not **Start at…**. Its first
step chooses the start point. Saving that step continues directly to **What plays**, where the
same pre-add choice can include or skip episodes or collection members. A collection can also
set its member order there.

All choices remain local until **Add to** names a queue. A successful add writes the entry,
then its start point, the queue's merged skip list, its explicit specials and its collection
order. An abandoned configuration writes nothing. An item that was already in the destination
queue receives none of the pending choices.

Collection rows reorder through the site's drag interaction. Each row has one drag handle.
The same handle moves the row with Up Arrow and Down Arrow when it has keyboard focus. The
Earlier and Later buttons are removed.

## Context

Pending exposed a start-point dialog before an add, but it did not expose the skip list or the
collection order. Those settings existed only after the entry was in a queue. The collection
order editor also used one Earlier button and one Later button on every row even though the
rest of QueuePilot uses drag handles for direct ordering.

## Why

- One configuration flow collects the decisions that define how the new entry plays.
- Deferred writes preserve the established rule that a Pending choice does not edit storage
  until a real add succeeds.
- The drag handle matches the established site interaction and removes two repeated buttons
  from every member row.
- Arrow keys keep the ordering available without a pointer.

## Evidence

Owner, 2026-08-30, chat `t3code-4a0392df`:

> "It only lets you pick the starting episode. I'd also like to pick the skip-list/ordering at
> the same time as well."

> "Why not just drag 'n drop like the rest of the site? We have keyboard controls for that, so
> we should use it instead."
