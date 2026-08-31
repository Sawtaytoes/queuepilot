# Search fields use the large clear target

Status: Accepted
Date: 2026-08-31
Type: UI correction
Supersedes: [2026-08-30](2026-08-30-search-fields-clear-with-the-shared-icon-button.md)
Superseded by: None

## Decision

All four QueuePilot search and text-filter fields use Charcuterie `SearchInput` with
`size="lg"`. This applies to the global library search, queue-list filter, queue-entry filter,
and board-game collection search. None uses `sm` or inherits the medium default.

## Context

The first shared-component adoption left the queue-list and queue-entry filters at `sm`.
The global and collection searches inherited `md`. The clear actions were real icon buttons,
but QueuePilot still presented them at two smaller sizes.

## Why

These searches are primary controls. Their clear action is frequent and must offer the large
pointer target without requiring precise aiming. One explicit size also prevents route drift.

## Evidence

Owner, chat `t3code-95952451`: “But don't make them small ones. The ones in QueuePilot
especially should be the larger variants.”
