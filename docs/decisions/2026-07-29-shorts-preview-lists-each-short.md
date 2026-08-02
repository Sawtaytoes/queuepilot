# The eligible pool lists every short by name — a library bucket is not a show

- **Status:** Accepted (implemented)
- **Date:** 2026-07-29
- **Type:** UI / preview payload
- **Supersedes:** —
- **Superseded by:** —

## Decision

A rotation preview's **library bucket** (`ratingKey: "section-<id>"`, e.g. Shorts) now carries
its `items` — every eligible item as `{ratingKey, title}`, sorted alphabetically — and the web
Channels view renders **one tile per short**, each with its own poster and its own **Exclude**
(the blocklist is by ratingKey, so it filters standalone items exactly as it filters shows).

A **show** bucket is unchanged: one tile, summarized by its next unwatched episode. The pool
heading still counts the whole pile (`5 shows + 24 shorts`).

The `items` field is additive — a web build talking to a service that predates it falls back
to the old single collapsed tile.

Ordering is alphabetical, not the bucket's own order: the bucket is shuffled per session, so
its order is a sample, not a lineup. (Consistent with the channel-member ordering backlog
item — random playback means order is for lookup only.)

## Context

Bob, looking at the Shorts channel's pool (*"Eligible pool — 0 shows + 462 shorts"*, one
"Shorts" tile): *"It'd be nice to see these shorts extrapolated in plex-channels, so I know
what kinds of shorts will play. It's different from listing episodes since they're essentially
movies."*

The collapse existed because `unwatched_buckets` models an item section as ONE shuffled bucket
(so the rotation sprinkles shorts between shows) — the preview simply mirrored that shape.

## Why

- **A short is a film, not an episode.** "Next: S1 · E3" is a meaningful summary of a series;
  "462 unwatched" tells you nothing about what will play.
- **It makes the blocklist usable for shorts.** Excluding one bad short previously meant
  finding its ratingKey by hand; every short now has a button.
- **It costs nothing.** The titles are already in the bucket the preview computes; no extra
  Plex calls. Posters are `loading="lazy"`, so a 462-item pool only fetches what is scrolled.

## Evidence

- `e2e/verify-shorts-pool.mjs` (new): 5 shows + 5 shorts render as 10 tiles with real titles
  and no collapsed "Shorts" tile; the header still reads `5 shows + 24 shorts`; a per-short
  Exclude writes that ratingKey into the channel's blocklist.
- `suites failed: 0`; `verify-preview-dedupe` re-baselined (10 tiles, still renders once).
- Screenshot reviewed (`__screenshots__/harness-channels-shows.png`).

## See also

- [2026-07-29-rewatch-pool-follows-the-channels-own-libraries.md](2026-07-29-rewatch-pool-follows-the-channels-own-libraries.md)
