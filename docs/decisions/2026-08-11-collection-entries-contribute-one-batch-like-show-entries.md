# A `Collection:` entry contributes ONE batch, exactly like a show entry

- **Status:** Accepted
- **Date:** 2026-08-11
- **Type:** fix
- **Supersedes:** —
- **Superseded by:** —
- **Clarifies:** [plex-collections-as-ordered-queue-entries](2026-07-21-plex-collections-as-ordered-queue-entries.md)

## Decision

A `Collection: <name>` entry is **one member** and contributes **one batch** per scan — the
entry's `episodes:` override, else the caller's default (`QUEUE_SERIES_DEFAULT`, hard-capped at
`QUEUE_SERIES_LENGTH`) — taken from its unwatched children in collection order.

This is the identical rule the show branch already applied. It holds **everywhere**: episode
collections and movie collections alike, no per-type special case.

The rotation / member-bucket callers pass **no** default batch and stay **uncapped**, unchanged:
their round-robin needs the full ordered list so a member can advance across rounds, exactly like
the dynamic rule pool.

## Context

`resolve_member` / `resolveMember` sliced the show branch to `episodes || default_batch` but
returned `collection_items()` **raw**. A collection therefore emptied its children's entire
unwatched run into a single scan while a plain show entry next to it yielded one episode.

Live, the anime channel built a 12-item "rotation" out of three shows:

```
 1-9.  Chaika: The Coffin Princess — Avenging Battle  S1E2 … S1E10
10.    Gleipnir S1E2                     <- a plain show entry: correctly capped to 1
11-12. Martian Successor Nadesico S1E21, S1E22
```

Bob finished an episode of Chaika and it started the next episode of Chaika. Of ~26 curated
members, three filled every slot — because Chaika and Nadesico are `Collection:` entries and
Gleipnir is not.

After the fix the same 12 slots hold **12 distinct shows**, one episode each, with Chaika still
resuming at its next unwatched episode.

## Why

- **It is what the original decision already said.** 2026-07-21 chose collections so a shorts
  Collection would sit on *"the same footing as show entries"* — Bob: *"select Collections of
  shorts in there (like show series)"*. Uncapped expansion was never that footing; this is a
  clarification, not a reversal.
- **A channel's job is to rotate.** One member monopolising a scan defeats the point, and the
  behaviour looked random because it depended on which members happened to be collections.
- **One rule, no special cases.** Capping episode collections but not movie collections would
  leave two behaviours for one entry type — the asymmetry that caused this bug in the first
  place. A movie collection now queues one film per scan and continues next scan, which is how
  a movie entry already behaves.
- **The batch knob still expresses "play more".** An entry that genuinely wants a run says
  `episodes: N`, the same override a show entry uses.

## Evidence

Bob, 2026-08-11: *"after scanning the card for anime, it's stuck to one show. I finished an
episode of Chaika, and it started the next episode"*, and on scope: **"Cap everywhere —
collections behave exactly like show entries"**, choosing it over capping only TV collections or
hand-editing the queue.

Regression gate: `e2e/collection-batch-cap-test.mjs` (hermetic fake client) pins the queue-path
cap, the `episodes:` override, the uncapped rotation path, and unresolved-vs-finished. It fails
3 ways on the pre-fix code. A Node↔Python parity gate could **not** catch this class — the fix
lands in both engines identically, and the synthetic corpus's only collection has a single
unwatched child, so capped and uncapped agree there.
