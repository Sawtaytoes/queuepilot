# A Priority entry's lead window belongs to a PROMOTE, not to an ordered queue

- **Status:** Accepted
- **Date:** 2026-08-26
- **Type:** playback semantics / defaults
- **Supersedes:** —
- **Superseded by:** —
- **Builds on:** [kind-is-picks-or-rules](2026-08-23-kind-is-picks-or-rules.md) — this
  implements its §2–§4 and settles one default that record left as a table row

## Decision

`lead` defaults by **how the entry got into the Priority lane**:

| The entry is in the Priority lane because… | Default `lead` |
| --- | --- |
| the SET is `add_as: priority` and the entry says nothing (an Ordered Queue) | `always` |
| the ENTRY says `placement: priority` (it was promoted) | `once` |

An explicit `lead:` on the entry outranks both. `kind.normalizeLead()` is the one place
this is decided, and it takes `isPromoted` rather than reading the set.

## Context

The 2026-08-23 ADR's entry table says `lead` is "sparse → once". Implemented literally,
that breaks every Ordered Queue in the house.

An Ordered Queue is stored as `add_as: priority`. Every one of its entries is therefore in
the Priority lane **by inheritance** — not because anybody promoted anything. Give each of
them a 24h window and the queue stops being ordered:

1. Sitting one plays entry 1. Its window starts.
2. Sitting two, inside 24 hours, finds entry 1 suppressed and leads with entry 2.

For a movie queue that is invisible, because the film is finished and leaves anyway. For a
**show** entry contributing one episode per sitting it is a behaviour change with no user
behind it: "play this list in order" becomes "play a different entry each night".

## Why

- **The window is the promise a PROMOTE makes**, in the owner's own words: "guaranteed
  first tonight, then not again until tomorrow". Nothing about an ordered queue asks for a
  cooldown; its order IS the promise.
- **The two lanes must be indistinguishable from today when nobody has promoted anything.**
  That is the property the whole implementation is built to hold — a queue with no
  `placement:` anywhere resolves through the same lane split and comes out in the same
  order. A default of `once` would have broken it in the one place a test of "same order"
  would not look: the SECOND sitting.
- It reads naturally at the call site. An entry that names its own lane is a decision
  somebody made; an entry that inherits one is not.

## Evidence

- `e2e/priority-lane-test.ts`, cases 1, 5 and 7 — an ordered queue plays file order, and
  keeps playing file order when the lead gate says every entry has already led.
- The ADR's own §4.2 describes the mechanism as a promote's cooldown throughout
  ("after a successful `once` contribution"), and §2 defines Promote as the thing that
  moves an entry into the lane.
