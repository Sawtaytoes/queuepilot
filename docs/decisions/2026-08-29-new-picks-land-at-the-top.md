# New Picks land at the top

- **Status:** Accepted
- **Date:** 2026-08-29
- **Type:** Queue ordering / correction
- **Supersedes:** the addition-placement clause of [New Picks land at the end, and Priority order is directly editable](2026-08-29-new-picks-land-at-the-end-and-priority-order-is-directly-editable.md)
- **Superseded by:** —

## Decision

Every user-facing add-to-queue path inserts a new title at the top:

- the search inside one queue;
- the global Picks toolbar search;
- the Pending list's Add to menu.

The queue search applies the same placement to its optimistic state before the request lands.
The Add-to-position picker does not return. The editable Priority number and direct lane
controls remain the controls for later placement.

## Context

The previous decision removed the position picker and chose the bottom as a predictable
default. On a long queue, that sends the result away from the search and outside the current
viewport. The person then has to find the title before any direct order control can help.

## Why

- The new title stays in the area where the person is already looking.
- The result is visible before the person decides whether to keep or move it.
- One fixed placement keeps the add action simple.
- Existing direct controls handle later changes without another pre-add question.

## Evidence

Owner, 2026-08-29:

> *"I think it's simpler to add to the top of the queue and let me deal with it from there, so it's visually all in the area I'm looking."*

The frontend has three POST call sites for this action. All three now send `position: "top"`,
and the in-queue optimistic update prepends the matching tile.
