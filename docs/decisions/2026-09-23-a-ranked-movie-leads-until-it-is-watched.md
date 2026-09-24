# A ranked movie leads until it is watched, and never asks the lead gate

- **Status:** Accepted
- **Date:** 2026-09-23
- **Type:** correctness / playback semantics / product rule
- **Supersedes:** the PROMOTED default in
  [the-lead-window-belongs-to-a-promote-not-to-an-ordered-queue](2026-08-26-the-lead-window-belongs-to-a-promote-not-to-an-ordered-queue.md),
  for a movie only. That record's rule — inherited Priority is `always`, promoted Priority is
  `once`, an explicit `lead:` outranks both — is otherwise unchanged, and the explicit `lead:`
  still outranks this too. It completes
  [a-half-watched-priority-entry-keeps-its-rank](2026-09-11-a-half-watched-priority-entry-keeps-its-rank.md),
  which protected a Priority entry Plex knew was half-watched and left the entry Plex knew
  nothing about yet unprotected.
- **Superseded by:** —

## Decision

`normalizeLead()` returns `always` for a batch whose resolved type is `movie`, whatever put it
in the Priority lane. A ranked film is asked no lead gate, is never reported in `suppressed`,
is never reported in `led`, and stamps no cooldown. It leaves the lane by being WATCHED.

A show and a collection keep `once` when they were promoted by hand. An explicit `lead:` on the
entry outranks all of it, for a film as for anything else.

The rule underneath, in the owner's words: *a Priority entry plays the required number of
episodes and is then done for that day; Rank 2 comes next, or the queue falls through to the
pool.* A window is spent when an entry has DELIVERED what it owes. A movie owes exactly one
thing — itself — so it can never deliver part and still owe the rest.

## Context

A ranked Rank 1 film was dispatched at 20:25. The Plex client stopped working. The owner
restarted Plex and scanned the card again at 20:32, and the queue played a half-watched pool
title at 2h25m instead. The film sat at Rank 1 on screen the whole time.

Nothing in the chain was faulty on its own terms:

1. `session.startSession()` stamped the 16h window 12 seconds after the handoff returned, which
   is where the 2026-08-26 record deliberately put it.
2. `resolve.leadsInProgress()` would have kept the film's rank — but it reads Plex's
   `viewOffset`, and Plex writes that lazily. The broken client never pushed one. Plex recorded
   the film's 4m10s at 20:38, **six minutes after the decisive scan**.
3. So both rescans in that gap saw a spent window and no progress, demoted the film to the
   pool, and gave the head to the one pool member that did have a resume marker.

The queue held no `queue_entry_history` rows, so QueuePilot's own position ledger did not cover
the gap either.

## Why

- **A gate on a film can only ever take a rank away from a film nobody watched.** A watched
  film resolves EMPTY (`resolveEntry` returns `items: []`) and leaves the lane by being
  finished. So the gate never fires on a film that delivered — only on one that did not.
- **The rank is the owner's instruction, and a film has no second sitting to be held out of.**
  The 16h window exists so that a second sitting the same day falls through to Rank 2 rather
  than serving the same thing again. That is a real question for a show with an episode count
  and a meaningless one for a film: the film either played, and is gone, or did not, and is
  still owed.
- **It fixes a whole CLASS of lag, not one broken client.** Any delay between playback starting
  and Plex writing `viewOffset` opens the same hole — a paused start, a client that crashes, a
  network drop, a scan that lands in the gap. Removing the gate for films closes all of them at
  once, where a wider `leadsInProgress` would only have narrowed the window.
- **It is the narrowest change that does it.** A tempting wider rule — "zero progress keeps its
  rank" — breaks collections: a collection's next member always has zero progress, so a ranked
  collection would lead twice in one evening, which is the exact thing the window is for.
- **The explicit control still means what it says.** This moves what a SPARSE `lead:` defaults
  to. Somebody who sets `lead: once` on a film in the entry panel gets `once`.

## Evidence

- Owner, 2026-09-23: "In the case of movies, it's always gonna start the first one again. It's
  priority, it's rank 1. It's going first." And, on the unified rule: "only play the required
  number of episodes and then that show is done for that day. Rank 2 comes next or if no more,
  fall through to the pool." Chat `t3code-a90c694f`.
- Container log, the same evening: `[play] ... offset=0s` at 20:25:25, then
  `'<key>' led — its window restarts now` at 20:25:37, then `held back by their lead window:
  <key>` on the 20:30:49 and 20:32:06 rescans, whose head came back `lane=resuming` at
  `offset=8716s`.
- Plex metadata read afterwards: the film's `viewOffset` was `249809` with `lastViewedAt`
  20:38:30 — after both rescans had already demoted it.
- The stored entry carried `placement: priority` and no `lead:` key, so it took the promoted
  default. **27 explicitly promoted entries across 8 queues, and not one carries an explicit
  `lead:`** — so every one of them ran this way.
- `e2e/priority-lane-test.ts` case 4b pins the rule from four sides: a spent gate does not
  demote a ranked film, the film is in neither `suppressed` nor `led`, the gate is **not called
  at all** for it, and an explicit `lead: once` on a film is still honoured. Case 6c pins the
  dinner case on films with no progress recorded anywhere.
- The suite's window cases moved onto SHOWS in the same commit, because a promoted film no
  longer reaches the gate they exist to test.
