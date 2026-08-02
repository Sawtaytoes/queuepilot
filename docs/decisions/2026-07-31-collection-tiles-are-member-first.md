# A Collection tile shows the MEMBER that plays next — the collection moves to the badge

- **Status:** Accepted
- **Date:** 2026-07-31
- **Type:** UI
- **Supersedes:** the collection-tile half of
  [`2026-07-21-plex-collections-as-ordered-queue-entries`](2026-07-21-plex-collections-as-ordered-queue-entries.md)
  (the entry/data model there is unchanged — only how the tile renders)
- **Superseded by:** —

## Decision

Every tile in the grid reads the same way, whatever kind of entry it is:

| Line | Series entry | Collection entry |
| --- | --- | --- |
| Poster | the series | **the member series/movie that plays next** |
| Title | the series name | **the member's name**, with the collection's name stripped off the front |
| Yellow line | `E5 · <episode title>` | `E1 · <episode title>` (series member) / `3 of 8` (movie member) |
| Badge | `Series` | `[Collection] <collection name>` — a two-part pill |

So the tile always answers, top to bottom: *what plays next*, *which episode*, *where it
comes from*. The collection name is no longer the title — it is the provenance chip, which is
also what tells you playback will roll on into the collection's next entry.

The episode line never repeats the series name (it used to read `E1 · Chaika: The Coffin
Princess - Avenging Battle`), because the title line above it already says which series it is.

The member title drops a shared collection prefix: member *"Chaika: The Coffin Princess -
Avenging Battle"* inside collection *"Chaika: The Coffin Princess"* renders as **"Avenging
Battle"**. Tiles are ~160px wide, so the part that identifies the member is exactly the part
that would otherwise be truncated away. The full name is in the hover tooltip; the collection
name sits in the badge directly below, so nothing is lost.

Also dropped in the same pass: the word **"Play"** in front of the episodes-per-play dropdown
(`Play [1 ep ▾]` → `[1 ep ▾]`). The dropdown speaks for itself; the word was tile noise.

## Context

Bob, 2026-07-31, looking at a Chaika collection tile next to series tiles:

> *"Even for collections, I think the graphic could be of the season, and the 'E1 · Chaika:
> The Coffin Princess - Avenging Battle' text could exclude the show name … better yet, put
> the show name above, and keep the episode numbers consistent across all series/collections.
> … What if the collection name was replaced with the series name? And then the 'Collection'
> text had some sort of highlight or way to see which collection that show is coming from?
> Then it's even more consistent, and it's also clear which show is playing, the episode, and
> the name of that episode. And you can tell 'this will continue to the next season/series in
> the collection'."*

> *"We can also remove the word 'play' where it says '1 ep'. I think it's unnecessary. The
> dropdown can stay visible, but the 'play' text doesn't need to be there."*

## Why

- **Consistency beats labelling.** A grid where every tile's title line means the same thing
  ("what plays next") is scannable; one where a collection means something else is not.
- **The collection is context, not identity.** What actually plays is a series/movie; the
  collection only says what follows it. A provenance chip carries that without stealing the
  title line.
- **It survives truncation.** Prefix-stripping + the badge put the two distinguishing facts
  (which member, which collection) where they still fit at 160px.

## Evidence

- User quotes above, chat 2026-07-31, with annotated screenshots of the anime queue grid.
- Implementation: `plex.collectionNext()` returns the member's `ratingKey`/`year`/`position`
  alongside the episode; `tileFace()` in `web/app.js` builds the face for both grids
  (queue + channel members) so they can't drift apart.
