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
   included, because a finished item still has a picture. A filtered queue skips this
   step, because it reads its parent's entries and cannot tell here which of them its
   filter keeps.

A Plex episode shows its show's poster. A Kavita item shows its series cover; a game shows
its own cover. A candidate that fails, has no art, or is larger than
`CHOOSER_POSTER_MAX_BYTES` (512,000) is skipped. A candidate is never asked twice, and
episodes of one show are one poster, so they cost one attempt.

One search requests at most eight images and looks at most at 32 candidates. Every search
asks the first four candidates first, then continues the rest of the queue from where the
previous search stopped. Art found past those four parks the search there, so a refresh
finds it again. A queue searched to its end without art wraps back to its head. A long
artless prefix therefore costs a few warm-ups, not unbounded work in one.

Plex posters are requested as `format=jpeg` from the home server's transcoder and from a
shared server's transcoder, with the raw thumb as the fallback. Other callers of
`plex.thumb()` and `plexServerThumb()` are unchanged.

`GET /api/native/queues` carries the same `artworkPath` for each queue, so the TV and the
display chooser show one picture for one queue.

A Plex poster is refreshed on every warm-up, as before. A pull provider's lineup reads each
curated item (Kavita probes every series), so its found cover is kept for 30 minutes and
the warmer does not force it.

When a search finds no art, the image route answers 404 and the manifest path ends in
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
  metadata read, the queue-entry fallback, a failed lineup, no art anywhere, the attempt
  bound, a search continued across refreshes, the wrap to the head, one show's episodes as
  one attempt, a filtered queue, a shared server without a grant, Kavita covers (head, next
  series, a queue whose entries are all finished), and a provider without covers.
- `server/src/chooserPosterCache.test.ts`: the manifest across provider kinds, an
  unconfigured provider, an oversized image, and the 30-minute pull cover.
- `server/src/routes/chooserPosterRoutes.test.ts`: both routes over HTTP.
- `server/src/plexSources.test.ts`: the shared-server transcode, and its fallback when the
  transcode fails or its body fails.
- `server/src/nativeTv.test.ts`: the TV catalog carries the chooser's poster path.
- The live measurements above were taken inside the deployed container on 2026-11-17.
