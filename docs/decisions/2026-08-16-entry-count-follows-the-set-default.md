# An entry count picker follows the set default, and tags that option Default

- **Status:** Accepted
- **Date:** 2026-08-16
- **Type:** bug / ui
- **Supersedes:** —
- **Superseded by:** —
- **Extends:** [2026-08-15-a-queue-sets-its-own-batch](2026-08-15-a-queue-sets-its-own-batch-and-the-search-box-accepts-a-year.md), [2026-08-16-a-volume-is-not-a-chapter](2026-08-16-a-volume-is-not-a-chapter.md)

## Decision

An entry that does not override the queue's batch **follows that queue's
default**. The picker shows the effective number, not a hardcoded 1.

The option that *is* the current default wears a **Default** chip in the
open listbox, so you can see which pick means "just use the queue's
value" rather than guessing from the selected number.

Sparse storage is **equal to this set's default**, not `<= 1`:

- set default 2, pick 2 → drop the key (follow the set)
- set default 2, pick 1 → store `episodes: 1` (a real override)
- set default 1, pick 1 → drop the key (same as today)

Same rule for `volumes:`. Tile tags (`2 ch`) and the "has overrides"
filter fire only on a stored override, so a queue sitting at 2 does not
stamp every tile.

`SelectListbox` now renders the `badge` / `badgeIntent` StartModal was
already passing (Watched chips). The CSS for `.optionbadge` was waiting
for it.

## Context

The owner, 2026-08-16, on a reading queue whose set editor said
"Chapters per series each visit: 2", with every entry panel still
showing 1:

> "I set the default to 2, but each item shows 1. The dropdown should
> say something like (Default) as a tag on the listbox to show which is
> the current value."

Two independent lies stacked:

1. `queueTile` coerced a missing `episodes:` to `1`, so the panel never
   saw the set default.
2. `setEpisodes` dropped any value `<= 1`, so you could not persist
   "just one, even though the queue is 2."

The Default chip is the list-row hint, not the trigger's text. The
closed control still reads the number that will queue.

## Why

- **The set default is the thing the owner just set.** Showing 1 on
  every entry after that is the control calling him a liar.
- **1 is a meaningful override** the moment the default is not 1.
  Treating `<= 1` as "unset" made that state unrepresentable.
- **Tags stay deviations.** A queue at 2 must not grow a `2 ch` chip on
  every poster — that is the default, not news.

## Consequences

- `GET /api/queues` sends `episodes: null` / `volumes: null` when the
  entry follows the set. The UI computes the effective count from the
  registry.
- Reset-to-defaults clears to *this set's* default, not the engine
  floor of 1.
- If the set default is neither 1 nor 2, that number is added as a
  third preset so it can wear the Default chip instead of hiding behind
  Custom….

## Evidence

- Owner quote above, 2026-08-16, with screenshots of the set editor at 2
  and an entry picker at 1.
- Gate: `setEpisodes(2)` against a set at 2 drops the key;
  `setEpisodes(1)` stores `1`. `effectiveCount(null, 2) === 2`.
  pick-contract asserts the Default chip sits on value 2.
