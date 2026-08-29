# The Picks page is `/picks` and starts collapsed

- **Status:** Accepted
- **Date:** 2026-08-29
- **Type:** product / UI / routing
- **Supersedes:** —
- **Superseded by:** —

## Decision

The Picks shelf page uses `/picks` as its canonical route. The retired `/queues` path remains
a replace redirect so an old bookmark reaches `/picks` without leaving a dead Back entry.
Links inside the app use `/picks` directly.

Every Picks shelf is collapsed on a first visit. The toolbar's one state-aware control says
**Expand all** when every shelf is collapsed and **Collapse all** otherwise. A person's first
use of that control creates the saved preference: an explicit empty saved set means expand
all, while no saved value means the product default of collapse all. This distinction keeps
the default from overriding a person who deliberately expanded everything.

## Context

The page had already been renamed **Picks** in its heading and navigation, but its route kept
the older implementation name `/queues`. It also already had a Collapse all / Expand all
toggle, while its storage default was an empty collapsed set, so every shelf opened on a first
visit.

The owner asked:

> "QueuePilot \"Picks\" page should have the route be named `/picks` and not `/queues` right?"

> "Also, can we make it so there's a way to expand and collapse all?"

> "Lastly, I think they should be collapsed by default, not expanded."

## Why

- The public URL now uses the product term that the page and navigation already show.
- The redirect preserves existing bookmarks and copied links.
- Collapsed shelves make the page a queue index first. A person expands only the shelves they
  want to inspect.
- One toggle presents the only useful next bulk action and uses less toolbar space than two
  buttons whose disabled states would repeat the same information.
- Absence and an explicit empty saved set have different meanings. Treating both as `[]` made
  it impossible to add a collapsed default without also erasing a saved expand-all choice.

## Evidence

- Owner quotes above, 2026-08-29, current conversation.
- `web/src/lib/routePaths.test.ts` pins `/picks` as the page and `/queues` as the legacy route.
- `e2e/routing-test.ts` pins the app link, client-side navigation and canonical Back target.
- `e2e/ui-test.ts` pins the collapsed first visit and both toggle directions.
