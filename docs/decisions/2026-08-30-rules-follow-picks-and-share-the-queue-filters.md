# Rules follow Picks and share the queue filters

- **Status:** Accepted
- **Date:** 2026-08-30
- **Type:** UI / correction
- **Supersedes:** [Picks queues keep the existing people and provider filters](2026-08-29-picks-queues-keep-the-existing-filters.md) (Picks-only scope)
- **Superseded by:** —

## Decision

The `/queues` people and provider filters apply to both Picks and Rules queues. Their counts
include both kinds. The page lists Picks first and Rules below them.

## Context

The Rules shelves joined the unified queue index after the existing Picks filter was restored.
They rendered outside its predicate, so a selected person or provider hid Picks shelves while
every Rules shelf remained visible. The Rules section also appeared first even though Picks are
the queues changed routinely and Rules are normally configured once.

## Why

- One filter bar must describe every queue displayed below it.
- A count must match the number of queues that its filter can show.
- Frequently changed Picks need the earlier position.
- Rules remain available without occupying the page's primary position.

## Evidence

Owner, 2026-08-30, current conversation:

> "Filtering doesn't work with Rules now added. Also, add Rules below Picks. Typically, you'd
> set them up once and forget about them whereas you're going to be consistently updating Picks."
