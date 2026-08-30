# A Picks entry can shuffle its playable items

- **Status:** Accepted
- **Date:** 2026-08-30
- **Type:** Playback semantics / data model / UI
- **Supersedes:** —
- **Superseded by:** —
- **Builds on:**
  - [A queue is one object with orthogonal mode knobs](2026-08-12-queues-have-orthogonal-mode-knobs-not-named-types.md)
  - [A Picks queue has Priority and Random lanes](2026-08-23-kind-is-picks-or-rules.md)

## Decision

A Plex show or Collection entry in a Picks queue can carry:

```yaml
item_order: shuffle
```

Absence means the existing **In order** behavior. The entry editor calls the two choices
**In order — next unwatched** and **Shuffle — any item**. A non-default entry wears a
**Shuffle** tag.

The setting is inside the entry. It is independent of the Picks queue's Priority queue and
Random pool lanes: a lane selects which ENTRY contributes next; `item_order` selects which
ITEMS that show or Collection contributes.

`shuffle` has this contract:

1. Build the entry's complete playable item list. A show contributes its episodes. A
   Collection contributes the playable leaves of all members, including movie members.
2. Include watched and unwatched items. "Any episode" is a replay behavior, not a random
   choice from the shrinking next-unwatched tail.
3. Keep the existing eligibility rules: trailers and extras stay out; regular specials stay
   out unless selected; Skipped items stay out; a manual start remains a lower bound.
4. Resume one in-progress item first. Shuffle the rest without replacement for this lineup.
5. Apply the existing per-entry item count after the shuffle. `batch_stops_at` does not trim
   a shuffled batch because a random order has no meaningful season or member boundary to
   preserve.
6. A shuffled entry never completes merely because every item has been watched. An older
   engine-written `done` marker revives on the next scan because the entry resolves to
   playable items again. A hand-written `done: true` remains an explicit skip.

The first implementation is Plex-only. Other providers do not expose the same episode and
Collection item model, and their entries do not show this control.

## Context

The Picks Random pool already shuffles entries, not items inside one entry. Selecting *The
Simpsons* therefore still resolved its next unwatched episode in normal season order. Rules
queues also shuffle or rotate show buckets while preserving the episode order inside each
bucket. Neither behavior answered "play a random Simpsons episode from any season."

The word **Shuffle** now names the inner operation only. The outer Picks lane keeps its
existing product name, **Random pool**, so the two independent axes do not share one label.

## Why

- The field belongs to the entry because two shows in one Picks queue can need different
  playback semantics.
- Including watched items makes the mode useful for episodic reruns. Unwatched-only shuffle
  eventually becomes an empty entry and is not "any episode."
- Shuffle without replacement avoids duplicate items inside one generated lineup.
- A manual start remains useful as a durable "do not select before here" floor. Changing the
  item order must not erase a separate setting.
- Boundary stops describe an ordered walk. Applying one after a shuffle would bias the result
  toward whichever random item happened to lead and could reduce a requested multi-item batch
  to one for no useful reason.

## Evidence

Owner, T3 Code chat, 2026-08-30:

> "I mean a show-specific setting that lets you shuffle the items in that show or Collection."

> "If you add say 'Simpsons', is there a way to randomly play any episode from any season?"

Owner, same chat, after confirmation that the feature did not exist: **"Build it."**
