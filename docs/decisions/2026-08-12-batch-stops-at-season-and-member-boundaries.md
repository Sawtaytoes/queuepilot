# A multi-episode batch may be stopped at a season / member boundary (`batch_stops_at`)

- **Status:** Accepted
- **Date:** 2026-08-12
- **Type:** feature
- **Supersedes:** —
- **Superseded by:** —
- **Clarifies:** [collection-entries-contribute-one-batch-like-show-entries](2026-08-11-collection-entries-contribute-one-batch-like-show-entries.md)

## Decision

The batch cap gains a second, orthogonal dimension. `episodes:` says **how many** items a batch
holds; `batch_stops_at` says **where the batch may end**:

| Value | Meaning |
| --- | --- |
| `none` (default) | The batch fills across anything — today's behavior, unchanged. |
| `member` | A batch never spans two `Collection:` members. |
| `season` | Also never spans a season boundary, **including inside a single show**. |

Set **per set** in `sets.yaml`, overridable **per entry** in `queues.yaml`, with an env-level
global default. Precedence: **entry → set → `BATCH_STOPS_AT`** (default `none`). An
**unrecognised** value at one level is *ignored* rather than read as `none`, so a typo in a
hand-edited entry falls back to the set's intent instead of silently switching the feature off.

Two invariants the implementation must hold:

- **The cut floors at ONE item.** An empty `items` list is the FINISHED signal `next_queue` marks
  an entry `done: true` on. A boundary cut that emptied a live batch would silently retire a show
  mid-run.
- **The boundary applies only when a count cap is in force.** The rotation / member-bucket callers
  pass no batch — their round-robin needs the full ordered list to advance a show across rounds —
  and are untouched. (A dynamic channel has no multi-episode batch to bound anyway: its
  round-robin already alternates shows every item.)

Editable in the web UI: a set-wide select in the Set modal, and a per-entry select on the queue
tile that appears **only** once that entry plays more than one item (a 1-item batch cannot cross
a boundary, so the control would be noise).

## Context

The cap was a plain **count**, applied as one slice. So `episodes: 2` on a show sitting at its
season finale queued **S1E12 + S2E01**; and because a `Collection:` entry's cap is applied to
`collection_items`' *flattened cross-member* list (the 2026-08-11 decision), a collection at the
same point queued **show A's finale + show B's episode 1**.

That flattening is a feature, not a bug — it is exactly what makes a collection's pair-batches
always fill instead of trailing off with a short session. The problem is only that it had no way
to *stop*.

## Why

- **A finale is a boundary a viewer feels.** Owner, 2026-08-12: *"it'd be weird to watch a season
  finale and then watch ep 1 of another show, but I think it's fine too. Just not something you
  always want right after an emotional season finale."* Watchable, so it stays the default; a
  preference, so it becomes configurable rather than hardcoded.
- **Per-set, with a per-entry escape hatch.** Same owner framing: *"This would be per queue/channel,
  not per item. I guess, we could also make it configurable as an override for any collection
  you've added as well"* — because the exceptions are real: *"some shows are OVAs or something, and
  you don't mind going into those."* A channel says `season`; the one OVA collection you're happy
  to roll through says `batch_stops_at: none`.
- **One tri-state, not two booleans.** The cases nest — `season` implies `member` — so a single
  ordered knob has no incoherent combinations to define or defend.
- **It only ever shortens.** Nothing about the existing count/clamp behavior changes, so the
  default path is bit-for-bit what it was.

## Implementation notes

- `_batch_stop` / `_apply_batch` (`queue_builder/plex.py`) and `batchStop` / `applyBatch`
  (`server/src/engine/resolve.js`) replace both raw slice sites — the collection branch and the
  show branch.
- `collection_items` now tags every item with `member_key` = the collection **child** it came from.
  The boundary cannot key on `show`: a movie member's `show` is the collection *name*, so two
  movies in one collection would fuse into a single segment.
- Stored as the **absence** of the key when `none`, so `sets.yaml` / `queues.yaml` stay sparse and
  a typo can never persist.

## Evidence

Gates (assertion, not diff — the feature lands in both engines identically, so a Node↔Python
parity diff stays green whether or not either side implements it, exactly as with the 2026-08-11
cap):

- `e2e/batch-stops-at-test.py` and `e2e/batch-stops-at-test.mjs` — the same table on both sides:
  both boundary kinds, the entry > set > global precedence, the typo fallback, two movie members
  never fusing, the floor of one item, a genuinely finished show still reading finished, and the
  uncapped rotation path staying uncapped.
- `e2e/set-passthrough-parity.mjs` — `batch_stops_at` added to the passthrough oracle, so the Node
  registry cannot silently forget to copy it (the failure mode that left 12 sets ungated,
  2026-08-11).
- `e2e/yaml-roundtrip-test.mjs` — `setBatchStop` and `updateSet` preserve hand-written comments,
  coexist with an existing `episodes:` override, and drop the key on `none`.
