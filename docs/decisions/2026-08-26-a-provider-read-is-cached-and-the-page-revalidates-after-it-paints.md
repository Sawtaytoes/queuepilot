# A provider read is cached, and the page revalidates after it paints

- **Status:** Accepted
- **Date:** 2026-08-26
- **Type:** performance / cache architecture
- **Supersedes:** —
- **Superseded by:** —

## Decision

**`GET /api/queues` serves the item-resolution caches whatever their age, and the browser
re-reads the providers once, right after the page paints.**

Three parts:

1. **Three new cache tables** hold the reads that had none: `item_meta` (one Plex item by
   ratingKey, per account), `section_collections` (a section's collection listing), and
   `kavita_item` (Kavita's `series` and `series-detail`, per series). Read-through, and **no
   TTL** — see Why.
2. **`?fresh=1`** re-reads all three and rewrites them. Nothing else does.
3. **Phase 3.** `store.load()` finishes by calling `revalidate()`, which asks for
   `/api/queues?fresh=1` and swaps the result in. While it runs, `isRevalidating` puts a thin
   indeterminate `ProgressBar` on the header's bottom edge.

Measured on the live registry — 340 entries across 19 sets:

| | Before | After |
| --- | --- | --- |
| Warm `/api/queues` | 5.1 s | **~0.1 s** |
| Provider calls, warm | 566 | 0 (plus the leaves validator, below) |
| The refresh pass | — | 6.8 s, off the critical path |

**What is NOT in scope, deliberately:** `leaves` and `collection_children`. Both have real
validators, and busting them would trade 566 cheap calls for a full library re-read.

⚠️ **The leaves validator still runs on every read, and an attempt to skip it was reverted the
same hour.** See Why.

## Context

> "Honestly, I'd like the whole page to load faster in general. Queues take FOREVER to load."
> — owner, 2026-08-26

and, in the same message, the shape he wanted:

> "the cache can update *after* the first page load, so it doesn't have to be immediate, it
> would load from cache and fix itself quickly and show something to the user that it's fixing,
> so it doesn't just pop in with new content randomly." — owner, 2026-08-26

The first measurement of this was **wrong and is worth recording**, because the mistake is easy
to repeat: a counter wrapped around `globalThis.fetch` reported zero Plex traffic on a warm
load, and the conclusion drawn was "the Plex half is cached, the cost is CPU". `plex.ts` calls
`undici.request` directly (`plex.ts:7`), so every Plex call was invisible to it. Instrumenting
`plexGet` itself gave the real number:

| Read | Calls per warm load | Cumulative |
| --- | --- | --- |
| Plex `/library/metadata/<rk>` | **339** | 10.6 s |
| Plex `/library/sections/<id>/collections` | 24 | 1.7 s |
| Plex `/status/sessions/history/all` | 13 | 0.2 s |
| Kavita `series` + `series-detail` | **189** | 17.8 s |

339 of those are one per queue ENTRY, every load. The cache covered episode lists, collection
children, title lookups and section listings — and missed the hottest path in the app.

## Why

**No clock is right for these.** A TTL long enough to be useful is long enough to be wrong, and
one short enough to be safe brings the 566 calls straight back. Kavita has no webhook and
nothing here polls, so there is no event to hang an invalidation on either. The browser asking
once, right after it paints, is the only trigger that matches how the data is actually used: a
row is then only ever as stale as the seconds between the first paint and the refresh landing.

**The chip and the line are not decoration.** They are the second half of the owner's sentence,
and the reason he gave for wanting them — content must not "pop in randomly". A page that
silently rearranges itself is worse than a slow one.

**A `ProgressBar`, not a status toast.** Toasts here auto-dismiss after four seconds and the
pass takes about seven, so the message would leave before the work did. It is at the header's
bottom edge rather than beside the title because the tiles about to change are below it, at
every scroll position.

**An in-process memo sits in front of the Kavita rows, and it is not a micro-optimisation.** A
`series-detail` DTO is the whole series, every chapter. Reading 188 of them back out of SQLite
cost **17 seconds of cumulative blocking time** per warm load — more than the network calls it
replaced. `node:sqlite`'s `DatabaseSync` blocks the event loop, so those reads do not overlap
whatever concurrency the caller uses. Measured rather than guessed: the ordered-chapter walk
those payloads feed is **2 ms**, so none of it was the work and all of it was getting the bytes
back. With the memo, warm went from 2.0 s to 0.1 s.

**A miss is cached as well as a hit.** A dead rating key is exactly the entry that sits in a
queue for months; without `{v: null}` it costs a live round trip for ever. A **thrown** read
caches nothing: "Plex was unreachable" stored as "this item does not exist" would paint an
unresolved tile that never repairs itself.

**The leaves validator was NOT skipped, and the attempt is the useful part of this record.**
`allLeaves` revalidates its cached episode list against the show's live
`(updatedAt, viewedLeafCount)` on every read
([2026-08-07](2026-08-07-leaves-cache-revalidates-on-read.md)), which is one Plex call per show
— 121 of them, about half a second. Skipping it on the cache-preferred read looked free and was
tried. It is not free, and `isFresh` cannot express the difference: **the browser's first paint
and the ENGINE building a lineup read through the same function with the same flag.** A second
of staleness is fine in the first and not in the second, because there the stale answer gets
queued and played rather than merely displayed. `e2e/leaves-revalidate-test.ts` failed on
exactly that within minutes, which is what the gate is for. Reverted; 0.1 s instead of 0.05 s
is not worth a settled correctness decision.

The cheap version of that is real and is **not built**: a section listing already carries
`(updatedAt, leafCount, viewedLeafCount)` for every show in it, so one call could validate all
121. It needs its own record, because that listing has a five-minute soft TTL and "revalidates
on read" would quietly become "revalidates within five minutes".

## Evidence

- Owner, 2026-08-26, both quotes above; and, choosing the scope, both caches together with a
  thin progress line at the top of the page.
- Live measurement, before: 5.1 s warm, confirmed from **inside the container** (5197, 5108,
  4898 ms) so it is the app and not the proxy.
- Live measurement, after: 0.10, 0.097, 0.12 s warm; the refresh pass 6.8 s.
- A cached and a `?fresh=1` payload compared field by field over all 340 tiles: **zero rows
  differ**. A cache that is fast and wrong is worse than the 5.1 s it replaced.
- Gate: `e2e/provider-cache-test.ts` — counts provider calls rather than timing anything, and
  pins that the fresh pass picks up a change made behind the app's back.
- A theory that was tested and **disproved**: a 5.2 MB un-checkpointed SQLite WAL. Checkpointing
  it changed nothing (5.0 s → 5.0 s), so it is not the cause and nothing was built for it.
