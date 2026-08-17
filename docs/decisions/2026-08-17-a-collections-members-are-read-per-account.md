# 2026-08-17 — A collection's members are read (and cached) per account

Status: Accepted
Date: 2026-08-17
Type: server (plex reads + cache schema + start-editor routes) + web
Supersedes: —
Superseded by: —
Extends: [2026-08-16 — A curated queue plays as the profile it is gated to](2026-08-16-a-curated-queue-plays-as-the-profile-it-is-gated-to.md)

## Decision

`plex.collectionChildren()` takes an `AccountScope` and is cached **per account**:

- the `/library/collections/<rk>/children` read carries that account's token, so a movie
  member's `watched` / `viewOffset` are that account's;
- `episodeCounts()` is called with the same scope, so a show member's `viewedLeafCount` — the
  "N/M watched" chip — is that account's;
- the `collection_children` cache table gains an `account` column to its primary key, exactly
  like `leaves` and `section_listing` already had. `SCHEMA_VERSION` 2 → 3, which drops and
  recreates (it is a cache; a stale schema is never migrated).

**The start editor's two picker routes resolve the profile server-side**, through one shared
`pickerScope()`:

- `?uuid=` still wins — a rotation channel's member grid knows its active binding and passes it;
- otherwise `?set=` names the set and the profile comes from its `requires_profile`;
- absent/owner/mint-failure ⇒ empty scope ⇒ the admin view, unchanged.

`/api/collection/:rk/children` accepts both parameters for the first time; `/api/show/:rk/episodes`
already took them but only ever used an explicit `uuid`. The web start modal now sends `set=` on
the collection call too.

Deriving from the set rather than teaching the queue grid to carry a uuid keeps **one** definition
of who a queue plays as — the one the 2026-08-16 decision established.

## Context

Reported the same evening the curated-queue profile fix was deployed. The tile now correctly read
**"Dragon Ball (1986) · E36 · Major Metallitron"**, but opening *Start from…* on it showed:

> 1. Dragon Ball — **154/155 watched** · 2. Dragon Ball Z — **176/291 watched**

Owner: *"While it shows the correct show now, the 'Watched' is still wrong for the given account."*

Those are Bob's numbers. Older Kids is **45/155** and **0/291**. The modal contradicted the tile
it was opened from — and the episode picker beneath it went further, marking **all 153** episodes
watched and tagging E36 itself "Watched", the very episode the tile said plays next.

This is the follow-up the previous decision named and deliberately deferred: `collectionChildren()`
was cached under `rk` alone and read with the admin token, so three per-account fields on every
member row were the owner's. Show members' *next-up* was already per-account (`nextEpisode(opts)`),
which is why only the counts were wrong on the tile path.

## Why

- A count that disagrees with the next-up printed two lines above it is worse than no count: the
  picker exists to answer "where am I in this?", and it was answering for someone else.
- The `leaves` table has carried an `account` column since 2026-08-07 for exactly this reason, and
  `section_listing` says in its own comment that "the account column is load-bearing". The
  collection table was the one that got missed.
- The movie-member leak decides what **plays**, not just what is printed: `collectionNext()` skips
  a member whose `watched` is true, so a collection whose next member was a film someone else had
  seen would skip it for everyone. The old code conceded this in a comment ("a rare movie child's
  `watched` short-circuit still reads the admin view") rather than fixing it.
- Server-side derivation over a client-supplied uuid: the queue grid has no binding to read one
  from, and giving it one would mean a second place that decides a queue's identity.

## Evidence

- Live, before (deployed prod): `GET /api/collection/325732/children?set=carol_1` →
  `Dragon Ball 154/155`, `Dragon Ball Z 176/291`. `GET /api/show/325563/episodes?set=carol_1` →
  **153 of 153** watched, E36 `watched: true`.
- Live, after (patched server, real Plex, live config copy): same two calls →
  `Dragon Ball 45/155`, `Dragon Ball Z 0/291`; **45 of 153** watched, E36 `watched: false` —
  consistent with the tile's E36 next-up.
- The unscoped call (no `set=`, no `uuid=`) still returns `154/155` — the admin view is unchanged
  for every screen that has no profile to name.
- Screenshots: `__screenshots__/collection-counts-before.png`, `…-after.png` (same viewport, same
  expanded series picker).
- Gate: `e2e/collection-children-per-account-test.ts`, wired into CI's browserless block. It spawns
  a fake Plex whose watched state varies by token and pins all three leaked fields, that each
  account fetches and caches its **own** row (neither clobbers the other, neither refetches when
  warm), and the consequence that decides playback — `collectionNext()` lands on the show's E3 for
  the admin and E1 for the kid. **6 of its checks fail on the pre-fix code.**

## Follow-up

None outstanding for this path. The per-account dimension now covers `leaves`, `section_listing`
and `collection_children` — the three cache tables that hold progress rather than structure.
