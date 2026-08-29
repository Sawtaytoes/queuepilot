# Queue shelf headings use avatar badges and one baseline

- **Status:** Accepted
- **Date:** 2026-08-29
- **Type:** UI
- **Supersedes:** [Queue shelf headings use audience names only](2026-08-29-queue-shelf-headings-use-audience-names-only.md)
- **Superseded by:** —

## Decision

The `/queues` shelf heading shows the queue title, item count, lane summary, the chevron,
audience avatar badges and audience names. It omits the provider kind label. The chevron,
avatar badges and names use one baseline so the heading reads as one row.

## Context

The owner corrected the previous names-only change:

> "Not only is the chevron vertically higher up, but now the names are also slightly higher
> than that. They don't align to the same baseline. Aren't those supposed to be avatar badges
> anyway?"

## Why

- The initials circle is the app's audience avatar badge, not a provider logo.
- The audience badge and name are the established `PeopleRow` shape used on the landing cards.
- Removing the badge made the audience row inconsistent and exposed the baseline mismatch.
- The provider kind label still repeats information expressed by the queue's provider colour.

## Evidence

- Owner quote above, 2026-08-29, current conversation.
- `e2e/ui-test.ts` checks that `/queues` headings contain avatar badges, omit the provider label,
  and use baseline alignment for the heading, link and audience row.
- `e2e/shot-queue-people.ts` captures the fixture-backed `/queues` heading with avatar badges and
  audience names.
