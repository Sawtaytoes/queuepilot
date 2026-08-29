# Queue shelf headings use audience names only

- **Status:** Accepted
- **Date:** 2026-08-29
- **Type:** UI
- **Supersedes:** —
- **Superseded by:** [Queue shelf headings use avatar badges and one baseline](2026-08-29-queue-shelf-headings-use-avatar-badges-and-one-baseline.md)

## Decision

The `/queues` shelf heading shows the queue title, item count, lane summary and audience
names. It does not show the provider kind or the initials face marker. The face marker remains
on landing cards and editor surfaces where the row is not already dense.

## Context

The owner reported:

> "I don't like how QueuePilot shows the \"PLEX\" thing after the names and the logo before it
> on the `/queues` page. It looks ugly."

## Why

- The provider kind repeats information already expressed by the queue's provider colour and
  its start control.
- The face marker repeats the audience name beside it and adds visual weight to an already
  crowded shelf heading.
- The audience names still distinguish queues that have the same activity title.
- Other surfaces keep the face marker, so this is a layout-specific change rather than a
  change to the people model or its accessible names.

## Evidence

- Owner quote above, 2026-08-29, current conversation.
- `e2e/ui-test.ts` checks that every `/queues` shelf heading omits both markers.
- `e2e/shot-queue-people.ts` captures the fixture-backed `/queues` heading and checks the
  names-only state at Wide View and the no-horizontal-scroll state at Narrow View.
