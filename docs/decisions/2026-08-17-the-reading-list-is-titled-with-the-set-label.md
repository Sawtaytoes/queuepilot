# The reading list is titled with the set's LABEL, and renamed in place

- **Status:** Accepted
- **Date:** 2026-08-17
- **Type:** ui / bug-prevention
- **Supersedes:** the "list TITLE is untouched" clause of
  [2026-08-17-queuepilot-gives-its-reading-lists-a-cover](2026-08-17-queuepilot-gives-its-reading-lists-a-cover.md)
  (the rest of that record stands)
- **Superseded by:** —

## Decision

**A set's Reading List is titled `QueuePilot — <label>`** — `QueuePilot — Manga & Webtoons`,
not `QueuePilot — manga_webtoons`. The slug was never for reading; it is an id.

**An existing list is RENAMED IN PLACE, never replaced.** The id is user-visible — it is the
`/lists/153` the owner has open and what every link Kavita's own UI renders points at — so
`materialize()` looks for the label title *and* the old id title, and when it finds the old one
it renames that list rather than minting a new one.

**The rename echoes the list's other fields back.** `POST /api/ReadingList/update` takes the
whole DTO and applies every field it is given; there are no patch semantics.

## Context

The owner, 2026-08-17, having been told the title still carried the slug:

> "Go ahead and redeploy and rename whatever."

The earlier record that day declined the rename because the title is how `materialize()` finds
its list again, and changing it would strand the existing list and mint a fresh id. That is
true of a rename done by *renaming the lookup key*. It is not true of a rename done by
**renaming the list** — Kavita has an update endpoint, the id survives it, and the lookup only
has to tolerate both names for as long as an un-renamed list can exist.

## The trap

⚠️ **Renaming with `coverImageLocked: false` deletes the cover.** Probed live on a throwaway
list: upload artwork (200, `coverImageLocked: true`), then `update` with `false`, and the list
comes back `coverImageLocked: false, coverImage: ''`. Kavita then starts generating art from
the items again — i.e. a careless rename would have silently undone the artwork shipped hours
earlier, on the very launch that renamed the list.

The same applies to every other field on that DTO. The live list was `promoted: true`; a rename
that spelled `promoted: false` would have quietly demoted it.

So `updateList()` takes `title`, `summary`, `promoted` and `coverImageLocked` as **required**
arguments rather than defaulting any of them — a caller cannot forget a field it was never
allowed to omit — and `materialize()` fills them from the list it just read.

## Why the lookup lives in one function

`findSetList()` is shared, because two call sites resolve a set to its list and only one of
them is `materialize()`. `topupList()` had its own
`.find(l => l.title === listTitleFor(setName))`, and left alone it would have answered
"no reading list for this set yet" about a list it was looking straight at — refilling would
have stopped dead, silently, on the one queue shape that depends on it. It now takes the label
too, and both go through the same tolerant finder.

## Consequences

- The live `manga_webtoons` list was renamed by hand the same day, at the same id 153, with
  its cover and its `promoted` flag intact.
- Lists built before this rename themselves on their next launch; no manual step, no orphans.
- The tolerance for the old id-title is **migration debt, not a feature**. It can go once no
  list is still called `QueuePilot — <slug>` — which for a household with one reading queue is
  after one launch of each.
- Two sets sharing a label would now share a title. Not guarded: labels are what the owner
  reads in the app, and two queues with the same name is already ambiguous there.

## Evidence

- Owner quote above, 2026-08-17.
- Live probes on a throwaway list, deleted afterwards: `update` renames in place and preserves
  the id; `coverImageLocked: false` on a list with an uploaded cover clears `coverImage`;
  `coverImageLocked: true` preserves it.
- The live rename of list 153 — same id, cover and `promoted: true` both intact — screenshotted
  after a launch had rebuilt the list's items again.
- New gates in `e2e/kavita-provider-test.ts`, including one that asserts the echo, with the
  stub applying the whole DTO exactly as the live endpoint does so the assertion means
  something.
