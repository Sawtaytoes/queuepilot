# Plex Collections are first-class queue entries, expanded in collection order

- **Status:** Accepted
- **Date:** 2026-07-21
- **Type:** feature
- **Supersedes:** —
- **Superseded by:** —

## Decision

A Plex Collection can be added to a queue/channel as a single entry that **expands to the
collection's items in the collection's own order**.

- **On-disk shape:** the entry is the literal title string `"Collection: <name>"` — honoring
  [queue-entries-are-title-strings](2026-07-20-queue-entries-are-title-strings.md) (also accepted as
  a `{collection: <name>}` mapping). Node writes it via the normal add-item flow with
  `POST /api/queues/:set/items {value, type:'collection'}`.
- **Resolution (Python, `queue_builder/plex.py`):** a `Collection:` entry is looked up across the
  set's sections (`/library/sections/<id>/collections`, type=18), and its children fetched **in
  order** from `/library/collections/<ratingKey>/children` (respecting `collectionSort`). Movie/short
  children play once and drop when watched; show children expand to their unwatched episodes; when
  every child is watched the collection entry is marked `done` (per the mark-done decision); an
  unresolved name is kept and flagged.
- **Search (Node):** `GET /api/search?set=<id>&q=<q>&collections=1` appends collection results
  `{type:'collection', ratingKey, title, sectionId, childCount, hasThumb}`; default search is
  unchanged. The poster proxy handles type=18 thumbs.
- **Shorts case falls out for free:** a shorts *Collection* added as an entry behaves like a named,
  ordered show group instead of shuffling the whole Shorts section.

## Context

Plex Collections are curated, ordered groups that were invisible in this app. Bob wanted (1) to
"play a collection in order" as a queue entry, and (2) shorts to be pickable as Collections ("like
show series"), not one shuffled whole-section bucket.

## Why

- **Reuses Plex's own ordering** rather than re-curating — the collection *is* the order.
- **One entry, many items** keeps the wishlist compact and legible while still expanding correctly at
  play time.
- **Title-string storage** keeps the file hand-legible and consistent with the existing entry format;
  no new schema.
- **Shorts-as-collection** gives named, ordered groups the same footing as show entries — the
  behavior Bob asked for — while the whole-section fallback still exists.

## Evidence

Bob, 2026-07-21: *"play a collection in order"*; and for shorts, *"select Collections of shorts in
there (like show series)"* — a shorts Collection should behave like a show entry, not the whole
folder. Captured in `docs/web-ui-v2-feedback-handoff.md` §C.
