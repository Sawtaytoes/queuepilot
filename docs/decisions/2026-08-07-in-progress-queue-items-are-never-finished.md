# An in-progress queued item is never "finished" — and a stale `done` is revived

Status: Accepted
Date: 2026-08-07
Type: bugfix / behavior
Supersedes: —
Superseded by: —

## Decision

A curated-queue entry (`source: queue`) whose current/next item is **in-progress** —
Plex `viewOffset > 0` AND unwatched (`viewCount` 0 **or absent**) — must NEVER be treated
as finished, marked `done`, or skipped. Specifically:

1. **Missing `viewCount` = unwatched, everywhere.** Plex OMITS `viewCount` when it is 0, so
   a missing/None count is coerced to 0 (`plex._int0`) — a partial view is never mistaken
   for watched. `resume_offset` is now purely live-state driven (`viewOffset > 0 AND
   viewCount < 1`) and no longer defers to the set's watch *history*: a history row must
   never override a live in-progress state.
2. **A specials-only show stays playable.** `_keep_episode` drops Season-0 specials to avoid
   front-loading a series — but a show whose ONLY leaves are Season 0 (a pure OAD /
   film-scanned-as-single-episode series) has no real seasons, so on the queue path
   (`resume=True`) its sole Season-0 leaf is kept (`_has_real_seasons` → `specials_ok`).
   Dropping it was what made such a show read "finished."
3. **An in-progress leaf survives a watched-history hit.** On the queue path, an episode/movie
   that is in-progress is kept even if the set's history counts it watched.
4. **Stale `done: true` is revived, not obeyed.** `next_queue` re-checks done-flagged entries;
   if one is actually in-progress it is played/resumed and its `done`/`done_at` cleared
   (`queues.clear_done`) BEFORE the TTL sweep, so it is neither skipped nor auto-removed while
   the owner is mid-episode. A genuinely-finished entry (no in-progress item) stays done.
5. **Shuffled anime channels lead with the in-progress item** so it actually resumes, rather
   than landing mid-shuffle where only the head resumes.
6. **Web badge.** The queue tile shows an **"In Progress"** badge (label chosen to sit beside
   "Completed"/"Series"/"Movie") whenever the next-up leaf (or a movie) is at a `viewOffset`
   and unwatched — surfacing the same predicate. It wins over "Completed."

## Context

Live evidence (bob_anime, 2026-08): the entry "Prison School: Mad Wax (2016)" — a 1-leaf,
Season-0 OAD (show `363480` → leaf `363482`) — showed **Completed** and was skipped while the
owner was mid-episode (`viewOffset 1060898` ≈ 17:40 of 25:33, `viewCount` ABSENT, and **no**
history row). Cause: `_keep_episode` dropped its only leaf as a "special," so `resolve_member`
saw no playable episodes → "finished" → `mark_done` persisted `done: true`, which then stuck.
The resume feature (PR #11) couldn't reach it because done entries were skipped up front.

## Why

The whole point of resume-in-queue is that a started-but-unfinished item picks up where it
left off. "Finished" must therefore mean *watched*, judged by live view-state — not by a
`done` flag a past scan wrote from a since-fixed mis-read, and not by a Season-0 heuristic
meant for multi-season shows. Revival honors live Plex over persisted state without churning
the file (one write on the transition back to active).

## Evidence

- Live Plex (admin/owner token = the bob_anime binding): `363482` → `viewCount: None`,
  `viewOffset: 1060898`, `leafCount: 1`, `viewedLeafCount: 0`; history rows for `363482`: 0.
- `queues.yaml` bob_anime had `{ratingKey: "363480", title: "Prison School: Mad Wax
  (2016)", done: true}`.
- Coordinator brief (2026-08-07): "An item with `viewCount in (0, None/absent)` AND
  `viewOffset > 0` is RESUMABLE, not watched… treat a MISSING/None `viewCount` as 0
  everywhere… un-stick already-corrupted entries… this applies to single-episode OAD/special
  'series' (`parentIndex == 0`) too."

## Tests

`e2e/resume-in-progress-done-test.py` (offline, real `resolve_member`/`next_queue`): the OAD is
kept + revived + resumed at its offset with its stale flag cleared; a genuinely-watched special
stays done; a series leads with its in-progress episode; a shuffled anime channel leads with
the in-progress OAD. `resume_offset`'s history-override case is asserted in
`e2e/resume-in-queue-test.py`.
