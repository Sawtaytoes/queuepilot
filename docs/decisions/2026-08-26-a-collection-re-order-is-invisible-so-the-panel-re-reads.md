# A collection RE-ORDER is invisible to the cache, so the panel re-reads Plex

- **Status:** Accepted
- **Date:** 2026-08-26
- **Type:** bugfix / cache invalidation
- **Supersedes:** —
- **Superseded by:** —

## Decision

**Opening "What plays" on a collection re-reads that collection's members from Plex, and the
panel says it is doing it.**

1. The panel paints the CACHED rows at once. It never sits empty waiting on a Plex round trip.
2. It then asks `GET /api/collection/<rk>/children?fresh=1`, which throws the cache row away
   and re-reads Plex.
3. While that is in flight the panel shows a **Checking Plex…** chip. If the order changed it
   shows **Updated from Plex** and swaps the rows.
4. A changed order also bumps the cache generation and refetches the grid behind the panel.
   The tile names the next member BY POSITION, so a re-order makes the tile wrong too.

The user's own ticks outrank the re-read. A row keeps its checkbox across the swap because the
row is keyed on its ratingKey, and a member Plex has since ADDED seeds from the set's stored
skip list.

**The 24-hour TTL is unchanged for every other reader.** This is one explicit re-read at the
moment the answer has to be right, not a shorter clock everywhere.

**Rejected: a shorter TTL, and a manual Refresh button.** Both were offered and the owner
declined both — "Manual is unnecessary because I can just refresh now. Soft TTL is
unnecessary." A clock cannot solve this in any case; see Why.

## Context

The owner re-ordered a film collection in Plex to put a fanedit first. QueuePilot went on
listing the old order, and went on playing it: the queue tile said the second film was next
when the first had changed.

> "I re-ordered these so the anti-DNR one is first. I already added this to QueuePilot, but it
> doesn't appear to have updated the ordering of the collection." — owner, 2026-08-26

Measured on the live app the same evening:

- Plex answered `/library/collections/<rk>/children` with the NEW order, and the collection
  carried `collectionSort: "2"` (custom).
- The `collection_children` row had been written about four hours earlier and held the OLD
  order. It had another twenty hours of TTL to run.

## Why

**No freshness test the cache owns can see a re-order.** There are three, and all three miss:

| Test | Why it misses |
| --- | --- |
| The `(updatedAt, childCount)` validator | `/children` answers with a container carrying `size` and **nothing else** — no `updatedAt`, no `childCount`. So the stored `updated_at` is always `0` and can never equal a real one. The validator argument was passed as `null` and the path was dead code. |
| The collection's own `updatedAt` | Read live: it was more than a year older than the change. Plex does not move it for a re-order. |
| `childCount` | A re-order adds and removes nothing. The count is identical on both sides. |

That leaves the 24-hour TTL, and a re-order is invisible to a clock as well: the cached copy is
not *old*, it is *wrong*, and it becomes wrong at a moment nothing reports.

**So the trigger has to be a person opening the panel.** That is the one moment the app knows
the answer is about to be acted on, and it costs a single container read.

**Cached-first rather than a blocking live read**, because the owner asked for that shape
directly:

> "the cache can update *after* the first page load, so it doesn't have to be immediate, it
> would load from cache and fix itself quickly and show something to the user that it's fixing,
> so it doesn't just pop in with new content randomly." — owner, 2026-08-26

The chip is the second half of that sentence and is not decoration. A list that silently
re-orders itself under somebody mid-edit is worse than a slow one.

**`dropCollectionChildren` is the missing twin of `dropLeaves`.** Nothing could bust this table
at all — the MQTT now-playing watch drops a show's leaves and has never touched a collection.

## Evidence

- Owner, 2026-08-26, on the ordering and on the shape of the fix (quoted above); and on scope,
  "Yes. But just the first."
- Live Plex read: children in the new order, `collectionSort: "2"`, collection `updatedAt` over
  a year stale.
- Live cache row: written 4 h before the report, old order, `updated_at: 0`, `child_count: 7`.
- Gate: `e2e/collection-reorder-test.ts` — nine assertions over a stub Plex whose member order
  is moved under a warm cache. Fails pre-fix on exactly four of them: the chip is absent and
  the rows keep the cached order.
- Shots: `e2e/shot-collection-reorder.ts`, before and after, on fixture data.
