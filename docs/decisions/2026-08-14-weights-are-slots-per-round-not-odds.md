# 2026-08-14 — A weight is SLOTS PER ROUND, not odds

Status: Accepted
Date: 2026-08-14
Type: feature / playback semantics (engine + API + web)
Supersedes: —
Superseded by: —

## Decision

Any entry a randomized set draws from can carry a **`weight`** — an integer 1–20,
default 1 — meaning **how many slots it takes per round**, not how likely it is to be
picked.

Three places carry one, each written the way its neighbour already is:

| Where | Shape | Written by |
| --- | --- | --- |
| A curated queue entry | `weight: 3` on the `queues.yaml` entry mapping | `queues.setWeight` (`PATCH /api/queues/:set/items/:key/weight`) |
| An explicit channel member | `weight: 3` on the `members[]` mapping in `sets.yaml` | whole-array `members` PATCH, like a member's `start` |
| A rule-pool show | `weights: { "<ratingKey>": 3 }` on the channel | whole-map `weights` PATCH, like `starts` |

A weight of 1 is never stored — setting one back to 1 DELETES the key, so an
untouched channel's YAML is byte-identical to what it was before this existed.

## Context

The ask: *"Add Weights to shows/series/collections/movies in QueuePilot, so they show
up more often when randomizing for your nightly queue."*

Two readings of "more often" were put to the owner with worked examples, and he chose
slots-per-round over probability:

> weight 3 Bluey, weight 1 Arthur, weight 1 Pokémon → Bluey, Arthur, Bluey, Pokémon,
> Bluey, Arthur, …

## Why

- **A rotation exists so consecutive items are different shows.** That is the whole
  premise of the "Saturday Morning Cartoons" channel — round-robin across shows, never
  two of the same back to back. A probabilistic pick weighted 3/1/1 will happily deal
  Bluey three times running, which is the behaviour the round-robin was built to
  prevent. Weighting the SCHEDULE keeps the property; weighting a die throws it away.
- **It is checkable.** "Three of every five slots" can be asserted in a test and seen
  in the preview. "60% likely" can only be sampled.
- **It degrades to today exactly.** `weightedInterleave` with every weight 1 IS the
  old round-robin — same walk of the shuffled order, same output — so an unweighted
  channel cannot change behaviour. `e2e/weights-test.mjs` asserts that against the old
  loop kept in the test as an oracle, over even, ragged and single-bucket pools.

The algorithm is **smooth weighted round-robin** (nginx's): credit each bucket its
weight, take the highest, charge it the total. 3/1/1 deals `A B A C A` — three A's in
five slots, none adjacent. A naive "take 3 from A, then 1 each" would deal `A A A B C`
and lose the point.

## Two places where a weight is NOT slots

- **A curated CHANNEL** (`kind: anime`) plays each member once per scan and cuts the
  lineup at `ROTATION_LENGTH`, so there is no round to take slots in. There, weight is
  a **weighted shuffle** (Efraimidis–Spirakis, key = `random^(1/w)`): a 3x member lands
  near the front more often, which for a list that gets cut IS "comes up more often".
- **The rewatch movie card** plays exactly one film, so weight MULTIPLIES the existing
  `1/n²` least-watched bias rather than replacing it. A 3x film is three times likelier
  than it would otherwise have been; a film seen once still beats the same film seen
  three times.

Both fall back to the untouched code path when nothing is weighted (the plain
Fisher–Yates shuffle, with the same rng and the same sequence), so seeded tests and
existing behaviour are unaffected.

## Evidence

- Owner, 2026-08-13, choosing between three worked examples: **"Slots per round"**,
  and scope **"Curated + members + rule pool"**.
- `e2e/weights-test.mjs` — 20 assertions: the 3/1/1 interleave, proportionality over
  15 slots (9/3/3), exhaustion mid-round, the unweighted≡old-round-robin equivalence,
  and the weighted shuffle's bias without becoming a sort.
- Found while wiring this and fixed here: `nextQueue` only shuffles when handed an
  `rng`, and the provider rewrap never handed it one — so every curated CHANNEL had
  been playing its members in `queues.yaml` file order since the Python retirement
  (Python defaulted `rng` to the `random` module).
