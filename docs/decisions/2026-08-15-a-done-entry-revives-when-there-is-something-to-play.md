# A `done` entry revives whenever there is something to play — and a finished collection says "All watched"

Status: Accepted
Date: 2026-08-15
Type: bugfix / behavior
Supersedes: —
Superseded by: —

## Decision

1. **Revival is the inverse of marking done.** An entry is marked `done` when its live
   resolution comes back **empty**, so a done entry that now resolves to **anything playable**
   is stale by construction: `nextQueue` revives it, plays it, and `clearDone`s the flag. The
   2026-08-07 rule — revive only when the head is mid-playback (`viewOffset > 0`) — becomes a
   special case of this, not the whole rule.
2. **A hand-marked `done: true` is exempt from the new half.** An entry the owner tagged by
   hand carries **no `done_at`** (only `markDone` writes one), and that absence is what marks
   it a deliberate skip. New unwatched content does not resurrect it; being *mid-episode* in
   it still does, exactly as before. Same `done_at`-presence test `sweepCompleted` already
   uses to decide what it may auto-remove.
3. **A finished collection reads like a finished show.** Its tile says **"All watched"**
   (`"All read"` on a reading queue), not `"N in order"`. The size label is now reserved for
   the cases where watch state is genuinely unknown — an unresolved entry, or a next-up lookup
   that **errored** rather than came back empty. Those two were previously the same `null`;
   `resolveTile` now reports `isNextEpFailed` so they can be told apart. This also stops a
   *show* whose lookup failed from claiming "All watched".

## Context

Live evidence (bob_anime, 2026-08-15). The owner reported a greyed tile reading
**"2 in order"**:

```yaml
- title: "Collection: Trapped in a Dating Sim: The World of Otome Games Is Tough for Mobs"
  start: {series: "460132", season: 2, episode: 1}
  done: true
  done_at: 1786668576     # Thu 2026-08-13 19:49
```

He had watched through S2E6, the next scan found nothing playable, and the entry was marked
done — correctly. His question was what happens when **S2E7 airs**, and the answer was: nothing.
`nextQueue` re-resolved the entry every scan, saw the fresh episode, and still skipped it,
because a brand-new episode has `viewOffset === 0` and only an in-progress head could revive.
Nor would it ever age out: `bob_anime` names no `remove_completed_after`, and the global
default is `never`. A returning show would sit greyed and unplayable forever, with its yellow
line cheerfully advertising the episode it refused to play (the tile's next-up is resolved live,
independent of the flag) — and the only escape in the UI is "Remove all completed", which also
throws away the entry's start override.

Anime "has no Season 2" is the premise the keep-don't-prune decision was built on
(2026-07-21) — but it is a premise about *most* entries, and the exceptions are exactly the
entries this stranded.

## Why

`done` is a **cache of a resolution result**, not a user intent, so the only honest thing to do
when it disagrees with live Plex is to believe Plex. The narrow `viewOffset > 0` test was
written for one concrete bug (the Prison School OAD) and encoded that bug's shape rather than
the invariant behind it; widening it to "anything playable" makes the flag self-healing for
every way content can come back — a new season, a new episode, a new member in a collection,
a re-import, an un-watch in Plex.

The `done_at` exemption is not defensive: `bob_anime` really does carry a hand-marked
`Collection: Frieren - Beyond Journey's End` with `done: true` and no timestamp, and without
the guard this change would have dropped it back into the channel on the next scan.

On the label: "2 in order" and "All watched" describe the same state, and the size label is
also what an *unresolved* tile shows — so the one tile that had genuinely finished looked
identical to a tile that had failed to resolve. That is what made it read as a regression to
the owner rather than as information.

## Evidence

- Owner, 2026-08-15: *"This is showing grayed out as if I watched it all (which I haven't) and
  '2 in order' which is this weird display we had in the early days of plex-channels"* … *"when
  Season 2 Episode 7 comes out, then I'll have that unwatched right?"* — the answer was no,
  which is the bug.
- Live `/api/queues` for the entry: `resolved: true, nextEp: null, childCount: 2, done: true`
  — i.e. resolved fine, genuinely finished, and labelled by size anyway.
- `queues.yaml` bob_anime carries both shapes: the Dating Sim entry with `done_at`, and a
  `Frieren` entry with `done: true` and none.

## Tests

`e2e/resume-in-progress-done-test.mjs` (offline, real `resolveMember`/`nextQueue`) gains a
"Returning Show" fixture — E1/E2 watched outright, E3 fresh with no resume point — and asserts
the new-content revival, its cleared flag, its `offset === 0`, and that the same fixture behind
a hand-marked `done` (no `done_at`) is **not** revived. The pre-existing in-progress case is
re-pointed at a hand-marked entry so it still proves revival works without a timestamp.
`web/src/lib/tileFace.test.ts` covers finished / finished-reading / lookup-failed / unresolved
for a collection, and lookup-failed for a show. Before/after tiles:
`e2e/shot-finished-collection.mjs`.
