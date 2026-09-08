# Completion behaviour is one picker, not two checkboxes

**Status:** Accepted
**Date:** 2026-09-08
**Type:** UI / product rule / data model
**Supersedes:** the two-checkbox presentation in
  [2026-08-08-set-modal-queue-flags](2026-08-08-set-modal-queue-flags.md) (the `keep_completed`
  and `reel` rows only; the other flags in that record are untouched). Answers the open
  decision left in
  [2026-08-07-non-consuming-keep-completed-queue-flag](2026-08-07-non-consuming-keep-completed-queue-flag.md).
**Superseded by:** —

## Decision

The Set editor asks **one** question about completion, with four answers. It replaces the
`Playlist mode` and `Demo reel` checkboxes.

| Mode | Marks an entry done | Plays the whole lineup each scan | When everything is done |
| --- | --- | --- | --- |
| **Consume** — the default | Yes | No | The queue runs dry |
| **Start over when exhausted** — new | Yes | No | Clears, and a new round starts |
| **Playlist mode** — `keep_completed` today | No | No | Never happens |
| **Demo reel** — `reel` today | No | Yes | Never happens |

- **The four rows are mutually exclusive and cover the space, so the picker loses nothing.**
  The one combination it forbids — mark done *and* play the whole lineup — is a reel that
  shrinks every scan, and `reel ⇒ keep_completed` already forbade it.
- **`Start over when exhausted` is a THIRD axis, not a rename.** `keep_completed` and `reel`
  both work by never marking anything done. This marks done, so nothing repeats while
  anything is unwatched, and clears when the last one finishes. Neither existing flag can
  express it.
- **It is a Charcuterie `Picker`.** A control that HOLDS a value is a `Listbox`/`Picker`,
  never a native `Select` and never two booleans where one force-disables the other.
- **It is NOT the seasonal reset**, and the editor must not read as though it were. Exhaustion
  is a count; a season is a date. A queue can use both, one, or neither. See
  [the reset date](2026-09-08-a-queue-can-clear-its-own-watched-state-on-a-date-each-year.md).

**Storage stays as it is: `keep_completed` and `reel` remain the keys on disk**, and the new
mode adds one more boolean beside them. The picker is a presentation over a settled data
model, so there is no migration, hand-edited `sets.yaml` keeps working, and a mode nobody
promoted is not silently dropped. An illegal combination written by hand is resolved by the
existing precedence rule (`reel` wins), the way it already is — it is not refused.

## Context

The owner, shown "start over when exhausted" as a separate option:

> "For Option 5, don't we have that already? We have 'demo' style where watched data isn't
> noted. That's similar but not the same right? I think these can all be different modes of
> the same option."

He is right on both counts. The 2026-08-07 record split consumption (`keep_completed`) from
play-all (`reel`) as orthogonal axes and left an open question:

> "Whether the demo reel should keep playing the **whole lineup every scan** (current `reel`)
> or **advance one item per scan** as a loop is the owner's call and is **out of scope**
> here."

That question is answered by the table above: advance-one-at-a-time-and-never-consume is
**Playlist mode**, which already exists. Nothing new is needed for it.

## Why

- **Two booleans where one force-disables the other is a picker wearing a disguise.** The
  editor already renders `Playlist mode` as checked-and-disabled whenever `Demo reel` is on,
  which is a four-state control drawn as two two-state ones.
- **The new behaviour has nowhere else to go.** Adding a third checkbox would make eight
  combinations of which four are meaningless.
- **Three checkboxes in a row about completion read alike.** Playlist mode, Start over, Demo
  reel are not distinguishable at a glance; four named rows in a list are.

## Evidence

Owner, 2026-09-08, quoted above. The axis table was derived from
`server/src/finished.ts applyQueueWriteSide()` (a `reel` returns before writing anything; a
`keep_completed` set still revives and sweeps but never marks).
