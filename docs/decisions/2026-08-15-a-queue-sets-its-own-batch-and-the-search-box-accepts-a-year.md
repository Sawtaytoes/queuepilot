# A queue sets its own batch; and the search box accepts a year

- **Status:** Accepted
- **Date:** 2026-08-15
- **Type:** feature / bug
- **Supersedes:** —
- **Superseded by:** —

Two independent reports from the same live-testing pass, recorded together because both are
about a control meeting the user where he already is.

---

## 1. The batch is per QUEUE, and the global default stays 1

### Decision

A set carries `episodes:` — **how many items one entry contributes per visit** — as the COUNT
to `batch_stops_at`'s WHERE. Precedence is the same three levels:

> **entry `episodes:` > set `episodes:` > env `QUEUE_SERIES_DEFAULT`**

`QUEUE_SERIES_DEFAULT` **stays 1**. This is explicitly not a new global, and not a per-medium
default either.

Stored sparsely: `<= 1` drops the key, so a queue that never touched the control is
byte-identical on disk. Clamped to `QUEUE_SERIES_LENGTH`, the same hard cap a per-entry
override already gets.

### Context

> "There's no way to globally set how many chapters to read before going to the next one. I
> wanna set it to 3 chapters by default. For Plex, 1 episode is no big, but for Webtoons and
> Manga, I'd prefer to default to 3 chapters (by choice for this queue, not by default) and
> change it per-item if I have to."

And, when the work was in flight, unprompted:

> "Just making sure you know, this is only for that one queue. I might want a different queue
> with a different number of chapters. 3 chapters should _not_ be the default, 1 chapter
> should be. I wanna be able to configure this per-queue."

### Why

- **The env knob could not express it.** `QUEUE_SERIES_DEFAULT` is one number for a TV queue
  and a reading queue alike; the whole point is that the right number differs per queue, and
  may differ between two reading queues.
- **The shape already existed.** `resolveMember()` has taken a `defaultBatch` parameter since
  the port; `nextQueue` simply passed the env constant. This is one line there, plus the same
  read/write plumbing `batch_stops_at` already has — not a new mechanism.
- **An unusable value falls through to the env default, never to "uncapped".** `applyBatch`
  treats a falsy batch as UNCAPPED, so reading a typo as 0 would dump a whole series into one
  scan. Same defensive rule `batchStop` uses for an unrecognised boundary.
- **The control is worded from the provider's vocabulary**, so a reading queue is asked about
  chapters and series, never episodes and shows.

---

## 2. A year in the search box narrows the search, it does not kill it

### Decision

A trailing `(YYYY)` is **split off before matching and used to RANK the results — never to
filter them.** No hit is ever dropped.

Parsed with `parseTitleString()`, the app's existing `queues.yaml` entry parser, rather than a
second regex.

### Context

> "Search with the year doesn't find results. It'd be nice if it did because that show exists
> with that year, but the search doesn't find it."

`Tekkaman Blade (1992)` returned **zero** results; `Tekkaman Blade` returned two.

### Why

- **`Title (Year)` is this app's OWN format.** `parseTitleString()` parses exactly that shape
  off `queues.yaml`, and the tile under the search box prints `Tekkaman Blade (1992)`. He was
  typing back the string the app had just shown him, into a box that passed it verbatim to
  Plex's `?title=` substring match, where no title contains a parenthesised year. Reusing the
  same parser is what stops the box and the storage format from ever disagreeing — and a
  pasted `[anidb-16172]` suffix is handled for free.
- **The year is the disambiguator, so it must not be discarded.** Measured live: a bare
  `Tekkaman Blade` ranks `Tekkaman Blade II` FIRST. Dropping the year would leave the right
  answer in second place on the very query that named it. After the fix the 1992 title leads.
- **Ranking, not filtering, because an empty list is the failure being fixed.** A year that
  matches nothing — a typo, or a provider carrying no year at all, which is Kavita — degrades
  to the bare-title result. An empty list reads as "you don't own this".

## Evidence

- Owner quotes above, 2026-08-15.
- The search fault and its fix reproduced against the live Plex library: 0 results before,
  2 after with the 1992 title leading.
- The batch verified end to end against live Kavita: a queue at `episodes: 3` served 3 items
  per series before switching, with a per-entry override widening only its own slice.
- All five golden parity gates pass, so the `nextQueue` change moves no Plex lineup.
