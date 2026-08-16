# "Plays before the next game" is the batch knob, counted from `queued_at`

- **Status:** Accepted
- **Date:** 2026-08-16
- **Type:** provider seam / queue semantics
- **Supersedes:** —
- **Superseded by:** —
- **Related:**
  [`board-games` is a third provider kind](2026-08-16-board-games-is-a-third-provider-kind.md),
  [An entry's count follows the set default](2026-08-16-entry-count-follows-the-set-default.md)

## Decision

**"Three plays before the next game" is the knob that already exists.** No new field, no new
mode:

- an **entry's** `episodes` is how many plays that game owes — `episodes: 3` means three game
  nights, then the next game becomes the head;
- the **queue's** own batch is how many of them one Open consumes. The default is **1**: a
  game night is one game.

Setting the queue batch to 3 is a valid "learn this tonight" — one Open spends three of the
head's play-units. It is not the default, and **it never spills into the next game**: a night
that ran out of the head's plays stops there rather than starting something else.

**Progress is counted from `queued_at`, never from the backend's lifetime total.** The entry
carries `queued_at` (epoch seconds, `EntryExtras`), and remaining is

```
remaining = owed − count(plays where gameId = X and playedAt >= queued_at)
```

**The launcher stamps `queued_at` only for a provider that asks for it** — `Provider.stampsQueuedAt`,
a capability rather than a kind check. A hand-written entry with no stamp gets one on first
read rather than being read as "since the beginning of time".

**A finished entry is `buckets()`'s answer, not a second writer's.** `logProgress()` records a
play on the provider's side and stops there; whether the entry is done is recomputed from
plays-owed versus plays-since-queued on the next launch or tile refresh.

## Context

Board Game Picker's play log is the household's book of record and goes back years. Wingspan
has twenty plays behind it.

Queue an entry with `episodes: 3` and count lifetime plays, and it is finished the instant it
is added — the queue would show a game as played out before anyone had played it *for the
queue*. The same trap waits for any future backend whose progress predates the queue.

## Why

- **Reusing the knob is what makes this a provider rather than a feature.** A "plays before
  the next game" field would have been a fourth name for a number the editor, the YAML and
  the engine already agree on.
- **`queued_at` is the only honest denominator.** "Plays" is not a property of the game; it
  is a property of *this entry's stay in this queue*.
- **Stamping on capability, not on kind.** Stamping every entry would grow a key in every
  Plex and Kavita queue's YAML that nothing will ever read; branching on
  `kind === 'board-games'` in the launcher would put a provider's name above the seam.

## Evidence

Pinned in `e2e/board-games-provider-test.ts`: a game with twenty plays years ago plus one
since it was queued, owing three, has **two** left and its next-up is play 2 of 3. The same
entry with no stamp is exhausted — which is exactly the bug, kept in the suite as the reason
the stamp exists.
