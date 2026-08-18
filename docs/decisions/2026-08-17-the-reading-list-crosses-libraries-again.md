# The reading list crosses libraries again — the owner backs out of the reader instead

- **Status:** Accepted
- **Date:** 2026-08-17
- **Type:** bug / reversal
- **Supersedes:** [2026-08-16-kavita-reading-list-stops-at-a-library](2026-08-16-kavita-reading-list-stops-at-a-library.md)
- **Superseded by:** —

## Decision

**QueuePilot writes the WHOLE lineup onto the Kavita reading list, libraries
and all.** `sameLibraryPrefix` is deleted, not disabled.

Kavita's reader-profile bug ([Kareadita/Kavita#4859](https://github.com/Kareadita/Kavita/issues/4859))
is unchanged and still real: a manga that auto-advances after a webtoon keeps
the webtoon's scroll + custom width. The owner handles it himself when it
happens, by leaving the reader and opening the chapter again — which is a real
navigation, so the right profile applies.

## Context

The owner, 2026-08-17, on the live Manga & Webtoons list:

> "Something in QueuePilot made it so Kavita reading list is only 1-2 items
> even though the default is still 12."

and, on the workaround that caused it:

> "I can manually fix that by existing and coming back in if the pagination is
> wrong."

The 2026-08-16 record chose the truncation as "the smallest honest workaround"
and priced it as *"a mixed-library visit needs a second tap on Open after the
first library's batch."* That price was wrong by an order of magnitude, and the
reason is in a different file: `buckets()` **interleaves** series round-robin,
and a `kind: anime` pool is `isRandomOrder`, so the two libraries alternate from
the very first item. The cut therefore lands after the FIRST series or two, not
after "the first library's batch".

Measured on the live list (`/lists/153`, read 2026-08-17): **4 items** — two
series x `episodes: 2`, all library 2 — out of a 12-item lineup. Earlier
launches with a different shuffle gave 1 and 2. The tiles said 12 the whole
time, because only the artifact was truncated.

## Why

- **The workaround cost two thirds of the list to avoid one tap.** Backing out
  of the reader and reopening is the same "fresh navigation" the truncation was
  buying, except it costs a tap *only when the profile is actually wrong*,
  instead of shortening every list unconditionally.
- **Grouping by library instead was considered and rejected** — it keeps the
  list full and the boundary intact, but it also silently un-does the
  interleave, which is what makes the queue roll between series rather than
  become a single-series binge. The owner picked the tap.
- **This does not reopen the 2026-08-15 record.** The list is still REBUILT per
  launch, never appended to; it is the *length* of that rebuild that changes.

## Consequences

- A mixed-library list will occasionally open a manga in the webtoon reader.
  That is now a known, accepted, owner-fixed annoyance rather than a bug to
  work around in the app.
- If Kavita ever reloads the reading profile on series change, nothing here
  needs to change — this decision stops depending on that fix ever landing.
- `sameLibraryPrefix` and its two unit gates are gone. The replacement gate
  asserts the inverse: a mixed lineup is written whole, in order.

## Evidence

- Owner quotes above, 2026-08-17.
- Live `GET /api/ReadingList/items?readingListId=153`: 4 rows, all
  `libraryId: 2`, against a 12-item lineup.
- Gate: `materialize` of `[lib 5, lib 5, lib 6, lib 5]` adds all four chapters
  and reports `count: 4` (`e2e/kavita-provider-test.ts`).
