# Rules and Picks use the same collapsible queue region

- **Status:** Accepted
- **Date:** 2026-08-29
- **Type:** UI / correction
- **Supersedes:** The Rules-card clause of [Queues is one index, and creation starts with kind](2026-08-29-queues-is-one-index-and-creation-starts-with-kind.md)
- **Superseded by:** —

## Decision

The `/queues` index presents every Picks queue and every Rules queue as the same collapsible
horizontal shelf. A Rules shelf loads a sample of its eligible titles when it expands. It uses
the same poster tiles, horizontal overflow treatment, audience row, provider accent, detail link,
configuration action and page-wide Expand all / Collapse all control as a Picks shelf.

The Rules preview is read-only. Its posters have no drag handle, lane action, remove action or
cross-queue drop target because they are the result of eligibility filters rather than stored
queue entries. The Rules detail page remains the place to inspect and configure the complete
eligible set.

## Context

The first unified index rendered Rules queues as a separate grid of summary cards above the Picks
shelves. That kept both kinds on one route but retained two visual models for the same queue
concept. It also hid every eligible title until the user left the index.

The owner corrected the result:

> "Not like this. I want them in the collapsible regions like the others. You can't drag 'n drop
> stuff in and outta them, but you'll be able to see some of what's available to play. The point
> is to have the same UI for everything."

## Why

- One queue concept has one index shape.
- An eligible-title preview makes a Rules queue recognizable before navigation.
- Read-only posters state the data boundary honestly: filters generate membership.
- Lazy preview loading avoids provider scans for collapsed shelves.
- One page-wide collapse control behaves consistently across both queue kinds.

## Evidence

Owner quote above, 2026-08-29, current conversation and attached `/queues` screenshot.
