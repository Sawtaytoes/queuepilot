# Collection is a picker with one route per maintained collection

- **Status:** Accepted
- **Date:** 2026-08-29
- **Type:** Product / routing / UI
- **Supersedes:** [The board-game shelf is `/board-game-collection`, not `/collection`](2026-08-25-the-board-game-shelf-is-board-game-collection.md)
- **Superseded by:** —

## Decision

`/collection` is the Collection landing. It presents one card for each QueuePilot-maintained
collection. `/collection/board-games` is the Board Games detail page. Future collections receive
their own stable segment under `/collection`.

The landing does not combine unlike provider records into one shelf. It selects a collection. The
selected detail page owns its search, filters, cards, and actions.

`/board-game-collection` becomes a compatibility redirect to `/collection/board-games` when the
new route table lands.

## Context

The Board Games shelf occupied the whole Collection destination. The owner expects more
QueuePilot-maintained collections and may later connect media sources. One shelf cannot represent
those distinct sources without making the first collection a special case.

## Why

A picker keeps the navigation stable while each collection gets a focused detail surface. The
nested path identifies both the category and the selected collection. It also leaves room for
provider-specific behavior without putting unavailable controls on every item.

## Evidence

> "It needs to be a card picker page where you can select which collection to view like Board Games. We'll have multiple that are QueuePilot-maintained."

Owner direction, 2026-08-29. Chat id unavailable in this repository session.
