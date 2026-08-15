# 2026-08-15 — A badge intent means exactly one thing, and TYPE is not a badge

Status: Accepted
Date: 2026-08-15
Type: frontend (badges / visual language)
Supersedes: the type-badge colours from
  [2026-07-31-collection-tiles-are-member-first](2026-07-31-collection-tiles-are-member-first.md)
  (that decision's point stands — a collection tile shows the member that plays next and
  names its collection; what changes is that a plain show/movie no longer gets a chip at all)
Superseded by: —

## Decision

**1. A plain show or movie renders NO type chip.** The poster already says what it is.

**2. Each intent means exactly one thing**, and only the WATCH/PLAYBACK state axis carries
one:

| Intent | Means | Where |
| --- | --- | --- |
| `success` (green) | **Completed** — you finished it | `.donebadge` |
| `accent` (amber) | **In Progress** — started, not finished | `.progressbadge` |
| `info` (blue) | **Now playing / Paused** — happening right now | `.playingbadge` (solid) |
| `danger` (red) | **Not in library** — it will not play at all | `.badge.warn` |
| `neutral` (grey) | everything that is a COUNT or a NAME | `N watches`, `N unwatched`, the Collection chip |

**3. Two chips survive the type cull**, because neither is type-as-taxonomy:
- **Not in library** — availability, not type.
- **The two-part Collection chip** — it carries the collection's NAME, which the tile has
  nowhere else, and it is what tells you playback rolls on into the next series in that
  collection. Behaviour, not taxonomy. Neutral, like the name beside it.

## Context

The owner, reading the grid:

> "The Badge colors are weird. Why is Collection a 'success'? … Completed should be Info
> right? Blue? Or am I wrong? Shouldn't that be green like you finished it? SUCCESS? I'm just
> looking at all the variants we have and not understanding at all why we chose the ones we
> did."

He was right, and the reason was worse than either option he guessed. **Four unrelated axes
were all painted from one intent palette**, so a colour meant two different things depending
on which chip it landed on:

| Colour | Meant | …and also meant |
| --- | --- | --- |
| green | Collection *(a type)* | Now playing *(a live state)* |
| amber | Series *(a type)* | In Progress, N unwatched |
| blue | Movie *(a type)* | Next-pick sample |
| grey | Completed *(a state)* | N watches |

Nothing about a collection is a "success". It got green because three types needed three
distinguishable colours and `success`/`accent`/`info` happened to be free.

## Why

**The type axis had to go, not just be recoloured.** It is what was consuming the palette the
state axis needs. And it was the least informative thing on screen: "Series" appeared on
every tile of an anime channel, next to a poster that had already said so.

**Green for Completed** is the conventional reading of "done" and it is the state you scan a
long queue for. That frees blue for **Now playing**, which loses nothing — it is the app's
only `solid` badge, so it already stands out on shape alone and does not need the strongest
colour too.

**Counts are neutral.** `N watches` already was; `N unwatched` in the eligible pool was
`accent`, which is now spoken for by In Progress, so it joins it. A count is not a state.

## Procedure

Four candidates were BUILT and photographed against the real app with real Plex posters, not
described: today, A (type quiet, green = done), B (type quiet, blue = done), C (type chip
dropped entirely), D (type quiet, state chips solid). Served over `devshare`; the owner
chose **A's colours with C's removal**.

## ⚠️ Two traps, both of which bit

**The collection chip's colour is written in TWO places** — `.badge.collection:has(.badgename)`
*and* `.badge .badgekind` (the "Collection" half of the two-part chip). The first pass at the
candidates changed only the first and left a green chip sitting in an otherwise neutral row.
The screenshot caught it; the code review had not. Any future scheme change must touch both.

**Part of this shipped early, by accident.** The candidate-generator script edited
`web/src/styles/app.css` in place, and the flush-left-poster commit
([PR 87](https://github.com/Sawtaytoes/queuepilot/pull/87)) staged that whole file — so the
two collection-chip neutralisations merged and deployed under a commit message that only
mentioned the grid columns. The change was later chosen anyway, so nothing was reverted, but
the commit is not honest about its own diff. Stage by hunk, or revert the file, when a
scratch script has been writing to the same tree.

## Evidence

Owner:

> "I like A's colors and C's dropping the type chip entirely."

Shots: `docs/images/2026-08-15-badges-{before,after}.png` (anime channel) and
`docs/images/2026-08-15-badges-after-movies.png` (a movie queue, where dropping the type chip
is most visible — every tile loses a "Movie" chip and keeps only `Edit`).
