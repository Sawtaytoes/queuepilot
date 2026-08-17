# A channel sets its own lineup length

- **Status:** Accepted
- **Date:** 2026-08-17
- **Type:** feature
- **Supersedes:** —
- **Superseded by:** —
- **Extends:** [a queue sets its own batch](2026-08-15-a-queue-sets-its-own-batch-and-the-search-box-accepts-a-year.md)

## Decision

A rotation channel carries **`length:`** — how many items its LINEUP holds.
Absent = env `ROTATION_LENGTH` (12), so a set that says nothing is
unchanged.

This is the **SIZE** to `episodes`'s **per-entry share**. The channel
still hands each show `episodes` items at a time; `length` only says when
to stop filling. The two are independent knobs and neither implies the
other.

Resolution is **set > env**, and it is **tolerant**: blank, `0`, negative
or non-numeric falls back to the default rather than throwing. A channel
that refuses to build is a dead card on the wall, and the input being
guarded is a typo in a hand-edited YAML.

**`0` does not mean infinite**, and no number does. When an infinite form
lands it gets a NAMED sentinel (`all`) per
[todos/batch-all-or-infinite.md](../todos/batch-all-or-infinite.md) —
never `0`, never `999`, because a falsy batch already reads as *uncapped*
in `resolve.ts`'s `applyBatch` and a typo would become a binge.

Clamped to `ROTATION_LENGTH_MAX` (200) in **both** the `sets.ts` writer
and `rotationLength()` in the engine. Not belt-and-braces: `sets.yaml` is
hand-edited over SMB at least as often as it is saved through the UI, so
the engine cannot assume the writer's ceiling ever ran.

**Rotation channels only, today.** A curated queue's length is however
many entries it has. Kavita's `limit ?? max_items ?? ROTATION_LENGTH`
(`providers/kavita.ts`) is deliberately left alone here.

## Context

The owner, 2026-08-17, after the kids used the Younger Kids Shorts card:

> "The kids were watching 'Younger Kids - Shorts', and it stopped too
> early they said. So they'd have to scan the card again."

`ROTATION_LENGTH` was one global number shared by every rotation channel.
The Shorts card was split out of the combined Shows & Shorts card on
2026-07-27 precisely so "a shorts tap can't turn into a 25-minute
episode" — but the count came along unchanged, and a count tuned for
22-minute episodes is a different amount of *evening* when the items run
three minutes:

| Card | Items | Runtime each | Lineup |
| --- | --- | --- | --- |
| Shows | 12 | ~22 min | ~4 hours |
| Shorts | 12 | ~3 min | ~35 min |

The number was never wrong. Sharing ONE number across cards of different
runtime was.

## Why

- **Runtime is a property of the card, not of the app.** Any global
  number is right for at most one kind of card. Per-set is the smallest
  unit that can actually be correct.
- **It matches the batch precedent exactly.** `episodes:` went per-queue
  on 2026-08-15 for the same reason in the other axis ("for Plex, 1
  episode is no big deal, but for Webtoons and Manga I'd prefer to
  default to 3 chapters"). Length is that argument applied to the lineup
  instead of the entry.
- **A default that moves nothing is the safe default.** Absent reads as
  the env value, so no existing card changes behaviour on deploy. Only a
  set that opts in moves.
- **Tolerance over validation, here specifically.** Everywhere else a bad
  value should be rejected loudly, but this one is read at scan time on
  a card someone just tapped. Failing the scan turns a config typo into
  a dead card; falling back turns it into a default-length lineup, which
  is visible and self-corrects on the next edit.

## Evidence

Owner, 2026-08-17, on the fix and where it goes next:

> "That should be configurable. Play X or play infinite. So #3 needs to
> be there too. Ideally, this would extend to Kavita."

`length:` is the "play X" half. **"Play infinite" is NOT in this
change** — it is meaningless without the top-up loop, because a Plex
playQueue is a fixed list once created. Both are tracked in
[todos/lineup-length-and-top-up.md](../todos/lineup-length-and-top-up.md).

## Follow-up

Phase 2 (`on_complete:` — a finished series restarts at ep1 or is
dropped, and the queue is done only when every show is) and phase 3
(top-up over MQTT, both providers, with Kavita's reading list kept to a
sliding window) are specified in that todo. Neither is built.
