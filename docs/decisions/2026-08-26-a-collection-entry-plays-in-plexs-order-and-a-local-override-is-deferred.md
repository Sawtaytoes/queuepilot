# A collection entry plays in PLEX's order, and a local override is deferred

- **Status:** Accepted (the deferral). The override itself is **Proposed — low priority**.
- **Date:** 2026-08-26
- **Type:** product boundary / deferred feature
- **Supersedes:** —
- **Superseded by:** —

## Decision

**A collection entry plays its members in Plex's own order (`collectionSort`), and QueuePilot
does not re-order them.** Plex is where a collection is arranged; the app reads that
arrangement and keeps it current (see
[the re-read record](2026-08-26-a-collection-re-order-is-invisible-so-the-panel-re-reads.md)).

Two controls already act on a collection entry, and neither is an order:

- **A start floor** — begin at a named member; earlier members are skipped whole.
- **A skip list** — never play these leaves. This is what the "What plays" panel edits.

**A per-entry order override is DEFERRED, at low priority.** It is not rejected. Do not build
it as part of another task.

## Context

The owner asked, in the same message that reported the stale ordering:

> "Also, can we customize the ordering of a collection in QueuePilot? Not sure why, but it
> might be necessary in the future." — owner, 2026-08-26

and, once the two were separated:

> "Don't worry about custom ordering for now. Put it as low priority for the future." — owner,
> 2026-08-26

## Why

- **One arrangement, one place.** A collection already has an order the owner can drag in the
  Plex UI, and it is the order every other Plex client shows. A second order stored here means
  two answers to "what plays next" and a rule for which wins.
- **The reported problem was staleness, not the source.** Plex's order was right; the app's
  copy of it was old. Adding an override would have answered a question nobody asked and left
  the actual defect in place.
- **It is cheap to add later.** The entry mapping in `queues.yaml` carries open-ended extras
  that rewrites preserve verbatim, so an `order:` list of ratingKeys fits with no format
  change.

## If it is built

Sketch only — this is not a design, and the two open questions below are decisions, not
details.

- **Storage:** `order: [<ratingKey>, …]` in the entry's extras, sparse (absent = Plex's order).
- **Where it applies:** after `collectionChildren` returns, in the one place the member list is
  produced, so the panel, the tile's next-up and the engine cannot disagree.
- **UI:** drag the rows in the "What plays" panel, which already lists exactly the members an
  order would address.

Two things must be settled first:

1. **Where a member added later goes.** The proposal is that it keeps its Plex position among
   the members nobody has moved — an override that silently drops new films is the trap.
2. **How the override is cleared.** A "use Plex order" reset has to exist, or an override is a
   one-way door and re-arranging in Plex quietly stops working.

## Evidence

- Owner, 2026-08-26, both quotes above.
- Read live while answering: the entry's controls are `start` (a member floor) and `skipped`
  (a leaf list). Neither re-orders. `collection_members: split` is a **filtered pool** setting
  and does not apply to an ordered queue.
