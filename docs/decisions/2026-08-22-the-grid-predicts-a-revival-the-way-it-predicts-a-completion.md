# The grid PREDICTS a revival, the same way it already predicts a completion

Status: Accepted
Date: 2026-08-22
Type: bugfix / behavior
Supersedes: —
Superseded by: —

## Decision

1. **`/api/queues` answers `isRevived`.** It is the mirror image of `isFinished`: the same
   live rule the next scan will apply, reported now, pointing the other way. `isFinished`
   says "the next scan will mark this done"; `isRevived` says "the next scan will clear that
   flag, because there is something to play again".
2. **The Completed badge keys off all three fields.** `isCompleted(item)` becomes
   `!isRevived && (done || isFinished)`. A tile that is about to play something never says
   Completed and is never greyed.
3. **Shows and collections only, and never a hand-marked `done`.** "Something to play" is the
   tile's own `nextEp`, already resolved per entry by this endpoint. An entry with no
   `done_at` is a deliberate skip and keeps its badge, exactly as the resolver keeps skipping
   it. A MOVIE is deliberately out — see Why.
4. **Nothing writes.** This is a prediction about the file, not a scan of it. `queues.yaml`
   stays the record of truth for everything that writes (the TTL sweep, "Remove all
   completed"), and the next scan is still what clears the flag.

## Context

Reported live 2026-08-22, on the **same entry** the 2026-08-15 revival decision was written
about. Its Season 2 Episode 7 aired. The tile read:

```
Trapped in a Dating Sim … 2 (2026)
E7 · Episode 7                      <- resolved live, so the tile already knew
24 min
[Collection · Trapped in a …]
[Completed]  [2x as often]  [Start S2E1]
```

Live `/api/queues` for it, and every field in the contradiction is in one payload:

```json
{ "type": "collection", "done": true, "isFinished": false,
  "nextEp": { "member": "… 2", "season": 2, "episode": 7, "title": "Episode 7" } }
```

`queues.yaml` carried `done: true` with a `done_at` of 2026-08-14 — written by `markDone`
when the entry really had nothing left.

The ENGINE was already right. 2026-08-15 widened revival to "a done entry that resolves to
anything playable", so `nextQueue` would have revived this entry, played it and cleared the
flag on the next scan. What no part of the app did was **say so first**. `done` is only ever
written by a scan; a scan runs on a session start or when playback ends; **an episode airing
is neither**. So the flag outlived the truth, and the grid — which reads the flag — greyed the
tile out and hung a Completed badge directly above the line naming the episode it was about
to play.

The owner's reading of the badge was that the entry was stuck, and he suspected the `2x as
often` weight of causing it. It does not: `weight` is read only by `weightedShuffle`, which
decides how near the front of a shuffled channel a member lands. Nothing in the done/revive
path reads it. It was the stale flag alone.

## Why

This is the same class of bug as 2026-08-16 (a film finished at 22:34 whose tile said nothing
until the next card tap), and it already has an answer in this codebase: **when the flag and
live Plex disagree, believe Plex, and say so on the tile**. `isFinished` was that answer for
one direction. The other direction was simply never written, and it is the direction that
matters more — a stale "Completed" tells the owner an entry is finished and greys it out,
whereas a stale blank tile only fails to tell him something.

**A movie is out on purpose, and the reason is the failure mode rather than the feature.** A
show's next-up is resolved per entry, and a lookup that fails reports no `nextEp` — so a Plex
hiccup leaves every badge exactly where it was. A movie's head is the watched HISTORY, and
`finished.watchedFor` returns an **empty set** when that read fails, which is
indistinguishable from "nothing is watched". Predicting a revival off it would drop the
Completed badge from every finished film in the app on one bad read. A movie also gains no new
content: the only revival it has is an in-progress head, and an in-progress tile already reads
"In Progress" over "Completed".

The `done_at` exemption is carried over unchanged from 2026-08-15 and is not defensive — the
live file really does hold hand-marked entries, and un-badging one would advertise as playable
something the resolver will go on skipping.

## Evidence

- Owner, 2026-08-22: *"This show has a brand new ep7 I need to watch, but it's saying
  completed? It was completed, but now a new episode dropped. The issue might be because of
  the 2x thing, but I thought that was best-effort."*
- Live `/api/queues`, `kevin_anime`: the payload quoted above — `done: true` and
  `nextEp.episode: 7` on the same tile.
- `queues.yaml`, same entry: `done: true`, `done_at: 1786668576`, `weight: 2`.
- `server/src/engine/resolve.ts nextQueue()`: `isRevived = head != null && (desc.doneAt !=
  null || …)` — the engine's own verdict on this entry is already "revive".

## Tests

`e2e/returning-show-badge-test.ts` (offline, own server against a stub Plex): a returning show
reports `isRevived`, a hand-marked one with the identical library state does not, a genuinely
finished one does not, and the file is never written. `web/src/lib/tileFace.test.ts` covers
`isCompleted` over the new field. Before/after tiles: `e2e/shot-revived-badge.ts`.
