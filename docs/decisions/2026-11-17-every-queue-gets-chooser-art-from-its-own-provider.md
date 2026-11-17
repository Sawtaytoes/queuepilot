# Every queue gets chooser art from its own provider, and one bad item never leaves it artless

- **Status:** Accepted
- **Date:** 2026-11-17
- **Type:** API / reliability
- **Supersedes:** In part, [Chooser posters warm before scans](2026-10-30-chooser-posters-warm-before-scans.md): the manifest and the warmer are no longer Plex-only.
- **Superseded by:** None

## Decision

`GET /api/chooser/posters` lists every available queue whose provider can draw art: Plex,
and each configured provider with covers (Kavita, Board Game Picker, Steam, and MiSTer).
One predicate, `hasChooserPoster()`, decides this for the manifest, the warmer, and
`GET /api/chooser/poster/:id`.

`chooserPoster()` looks for art in this order, through the queue's own provider and profile:

1. The lineup head.
2. The rest of the lineup, in order.
3. The rest of the queue: every stored entry with an id, in file order, finished entries
   included, because a finished item still has a picture.

A curated pull queue (one with stored entries) takes art only from its own entries. When
every entry is finished, its lineup is not built, because the provider would answer from
the whole library shelf (Kavita does), and a shelf item outside the queue is never used. A
pull queue with no stored entries is rule-based, and its shelf is its queue.

A filtered reading queue narrows its parent's entries the way its page does: by the
library each item's tile reports, through `passesFilter()`. A filtered Plex queue is not
narrowed anywhere in the engine, so its lineup, its items, and its art are its parent's.

A Plex episode shows its show's poster. A Kavita item shows its series cover; a game shows
its own cover. A candidate that fails, has no art, or is larger than
`CHOOSER_POSTER_MAX_BYTES` (512,000) is skipped. A candidate is never asked twice, and
episodes of one show ask for their show's poster once.

Every search starts at the lineup head and walks to the end of the queue, one request at a
time, up to 2,000 distinct candidates (the engine's own whole-queue cap). A search
therefore finds art anywhere in the queue, and a restored head wins on the next search.
The work is proportional to the artless prefix, which is one request for nearly every
queue.

Plex posters are requested as `format=jpeg` from the home server's transcoder and from a
shared server's transcoder, with the raw thumb as the fallback. Other callers of
`plex.thumb()` and `plexServerThumb()` are unchanged.

`GET /api/native/queues` carries the same `artworkPath` for each queue, so the TV and the
display chooser show one picture for one queue.

A Plex poster is refreshed on every warm-up, as before. A pull provider's lineup reads each
curated item (Kavita probes every series), so its found cover is kept for 30 minutes and
the warmer does not force it. The warmer waits for every refresh it starts, stale ones
included, so it keeps its bound of two queues at a time.

When no candidate has art, the image route answers 404 and the manifest path ends in
`-none`. A client then draws its own fallback tile. There is no server-side placeholder
image.

The sample stays read-only: no materialize, no handoff, no playback, and no write. A pull
lineup is built with `isReadOnly`, so a Board Game Picker queue never gets a `queued_at`
stamp from a preview.

## Context

On 2026-11-17 the live chooser listed 22 queues. 21 posters answered 200 and one answered
404. That queue's lineup head was a priority episode whose show poster transcoded to
519,897 bytes, which is over the cache cap. The cache dropped it, and nothing tried another
item. The same poster is 91,024 bytes when Plex is asked for `format=jpeg`.

The two reading queues were not in the manifest at all, because the manifest, the warmer,
and the image route accepted Plex queues only.

## Why

- One item's art is not a queue's art. A missing thumb, a slow server, or one oversized
  image should cost one candidate, not the whole tile.
- The size cap keeps the cache bounded (128 entries). Requesting a JPEG keeps nearly every
  poster under it, and skipping an oversized one keeps the cap meaningful.
- Each provider already re-serves its covers without exposing its credentials, so the
  chooser uses that path instead of a second one.
- The chooser and the TV read one path, so a fix in one place reaches both.

## Evidence

- `server/src/chooserPoster.test.ts`: the lineup fallback, the size cap, a failed
  metadata read, the queue-entry fallback, a failed lineup, no art anywhere, no repeated
  item, art 52 candidates deep in one search, one show's episodes as one request, a
  filtered Plex queue, a shared server without a grant, Kavita covers (head, next series, a
  queue whose entries are all finished, no shelf series outside a curated queue, a filtered
  queue narrowed by library), and a provider without covers.
- `server/src/chooserPosterCache.test.ts`: the manifest across provider kinds, an
  unconfigured provider, an oversized image, the 30-minute pull cover, and stale refreshes
  held to two at a time.
- `server/src/routes/chooserPosterRoutes.test.ts`: both routes over HTTP.
- `server/src/plexSources.test.ts`: the shared-server transcode, and its fallback when the
  transcode fails or its body fails.
- `server/src/nativeTv.test.ts`: the TV catalog carries the chooser's poster path.
- The live measurements above were taken inside the deployed container on 2026-11-17.
