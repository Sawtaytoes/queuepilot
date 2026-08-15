# The reading list is REBUILT on launch, not appended to

- **Status:** Accepted
- **Date:** 2026-08-15
- **Type:** bug
- **Supersedes:** —
- **Superseded by:** —

## Decision

**`materialize()` clears the set's reading list before filling it.** What belongs in the list
is exactly this launch's lineup; anything already there is a previous launch's answer to a
question nobody is asking again.

**Items are removed; the LIST is not deleted and recreated.** Its id is user-visible — it is
the `/lists/153` the owner had open in Kavita, and Kavita's own UI links to it — so a fresh id
per launch would break every bookmark. Verified live: the id survives a rebuild.

Clearing is **best-effort per item**. One row that refuses to delete must not abort the
rebuild and leave the reader with no lineup at all: a leftover row is visible and self-corrects
next launch, whereas a throw here is a dead card.

## Context

The owner, 2026-08-15, looking at the live list:

> "I don't understand why, but can we fix this Kavita connection? It's got stuff in here I
> absolutely did *not* add. are we auto-adding anything or are we only adding the ones in
> QueuePilot?"

The list held **23** series. It had held 12 that morning.

Two separate causes, and only one of them was the bug fixed earlier the same day:

1. **The lineup came from the library shelf** rather than the queue's 93 entries — fixed in
   [a curated reading queue is its entries](2026-08-15-a-curated-reading-queue-is-its-entries.md),
   and **not yet deployed** when he looked.
2. **`materialize()` never cleared the list.** It found the existing list by title and
   appended. So the list is the UNION of every lineup ever built for that set.

The second is this record. It is independent of the first: even with a perfectly correct
lineup, a queue whose shuffle picks a different twelve each launch would accumulate its whole
library into the list over a few weeks.

## Why this survived

**The method's own docstring already claimed the fixed behaviour**, and had since it was
written:

> "Rebuilt on launch, in order … Unlike Plex's playQueue, a Reading List PERSISTS … we reuse
> one list per set rather than littering the user's list view with a new one per launch."

The code implemented the second sentence and not the first. "Reuse the list" was read as "find
it and add to it".

**The gate was true and insufficient.** `materialize REUSES the set's existing list instead of
littering new ones` asserted `art.readingListId === 42` and `lists.length === 1`. Both stayed
green forever, because the fault was never about how many lists exist — it was about what is
*in* one. A test that names the artifact but never inspects its contents cannot see an append.

That is the transferable lesson: **the assertion has to be about the artifact's contents, not
its identity.** The new gate checks that the pre-existing rows are gone, that they were
addressed by their own item id, and — the invariant that actually matters — that every delete
happens *before* the first add, since clearing afterwards would erase the launch's own lineup.

## Implementation notes

- `POST /api/ReadingList/delete-item` with `{readingListId, readingListItemId}`. **Verified
  against the live instance** on a throwaway list, because the surrounding client methods carry
  a comment saying they were written from the spec in a read-only session and never exercised.
  The `DELETE`-with-query-params spelling is a 404.
- **The id is the ITEM's, not the chapter's.** `KavitaReadingListItemDto` gained `id` for
  exactly this; passing a `chapterId` there removes the wrong row or nothing.
- A brand-new list is not enumerated or cleared — there is nothing to clear, and the round trip
  would be pure waste on the launch path.

## Consequences

- The live list self-heals on the **next launch after deploy**. No manual purge is needed, and
  purging before deploy would be pointless — the running build would refill it.
- A reading list is now genuinely a runtime artifact, which is what
  [the seam ADR](2026-08-12-backends-are-providers-behind-a-media-neutral-seam.md) and
  `docs/why-queues-not-plex-playlists.md` both already asserted it was.
- Read PROGRESS is unaffected: Kavita tracks it per chapter/series, not on the list.

## Evidence

- Owner quote + the live list at 23 items, 2026-08-15.
- `POST /api/ReadingList/delete-item` probed live on a throwaway list (created, exercised,
  deleted) the same day; the `DELETE` spelling returned 404.
- End-to-end live probe on a throwaway list: launch 1 → two series, launch 2 (a different
  single series) → **one** series, list id stable `155 → 155`.
- The new gate **fails on the pre-fix code** with "the stale items were not cleared — the list
  accumulates", and passes after. Checked by restoring the old file, not assumed.
