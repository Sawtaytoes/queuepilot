# Picks queues keep the existing people and provider filters

- **Status:** Accepted
- **Date:** 2026-08-29
- **Type:** UI / reuse
- **Supersedes:** —
- **Superseded by:** —

## Decision

The Picks queues page renders the existing `LandingFilterBar` above its shelf list.
It keeps the existing multi-select people filter, provider filter, counts, URL shape and
group-aware matching rule. The filtered page is `/picks?people=…&only=…`.

## Context

The task-based home replaced the old queue-listing page. The `LandingFilterBar` stayed in
the unlinked compatibility overview, so the active Picks shelf list no longer had an easy way
to narrow its queues.

## Why

The filter already answers this question and already has its required semantics. Rebuilding it
would risk a second interpretation of audience groups, filter counts and query-string links.
The active list is the correct surface for the component.

## Evidence

Owner, 2026-08-29:

> "Yes. We had it built already. Just move the component we had"

`web/src/views/QueuesView.tsx` mounts the existing component and filters the shelves through
`membersMatchPeople`, the same group-aware predicate the compatibility overview used.

