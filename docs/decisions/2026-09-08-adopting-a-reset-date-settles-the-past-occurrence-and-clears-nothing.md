# Adopting a reset date settles the past occurrence and clears nothing

**Status:** Accepted
**Date:** 2026-09-08
**Type:** product rule / correction / durable data
**Supersedes:** —
**Superseded by:** —

Complements [A queue can clear its own watched state on a date each year](2026-09-08-a-queue-can-clear-its-own-watched-state-on-a-date-each-year.md),
which states the feature. This record states what happens on the **first** read after
somebody sets the date, and it does not change any rule in that one.

## Decision

**The first read after a reset date is set SETTLES the passed occurrence and clears
nothing.** The first real reset is the *next* occurrence of the date.

`queue_watched_reset.settled_at` therefore means **no occurrence at or before this moment
owes this queue a reset**. It does **not** mean "when this queue last reset". The two
readings agree after a real reset and disagree on the very first write, which is the whole
point of this record.

Two smaller judgements follow the same reasoning and are recorded here rather than in three
files.

- **The date is validated on WRITE, and an invalid value throws.** `promote_window` is
  stored verbatim and falls back at the consumer; this one does not.
- **The editor offers named months, not numbers.**

## Context

`isResetDue` compares the settlement stamp against the most recent occurrence of the date.
A queue that has just been given a reset date has no settlement row, so the stamp is null.
The most recent occurrence of *any* date is in the past — that is what "most recent" means —
so the literal reading of the rule fires **immediately**, on the next play, for every queue
the moment its date is configured.

The concrete failure is the queue the feature was built for. The owner opens the running
Halloween queue in the middle of October, sets `reset_watched_on: 11-01`, and saves. The
kids play the queue that evening. The most recent 1 November is ten and a half months ago,
the stamp is null, so the reset fires and throws away the season in progress. There is no
confirm, because a read-time reset has nothing to confirm against, and nothing on screen to
explain it: the queue simply comes back with every entry unwatched. The owner set next
year's date and lost this year's evening.

The two smaller judgements have their own context.

- A reset date is written once and next read a **year** later. There is nobody at the
  keyboard when it is read, and no screen showing what it resolved to.
- The editor could have been one text field taking `MM-DD`.

## Why

- **A settlement row is the only thing that can tell the two states apart.** "This queue has
  never reset" and "this queue reset on schedule" are the same absence of information until
  something is written down. Adoption writes it down, at the moment the setting is made,
  when the user is present and the queue's state is the state they meant to keep.
- **The safe default is to do nothing.** A reset is destructive and irreversible. Firing it
  once too few costs the owner a manual click; firing it once too many costs a season of
  watch state nobody can reconstruct.
- **The column name invites the wrong reading, so the meaning is named everywhere it is
  written.** `settled_at`, not `last_reset_at`, and the module header, the schema comment and
  this record all say what it means. An adoption write records a moment when the queue did
  **not** reset — a column called `last_reset_at` would have been a lie in the exact row it
  was invented for, and the next reader would have "fixed" it back.
- **Somebody who wants a reset right now already has one, and it is the better door.** The
  Actions menu clears the queue on demand, behind a confirm that
  [names the count first](2026-09-08-a-destructive-queue-action-lives-in-an-actions-menu-behind-a-confirm.md) —
  "Clear 12 completions in Halloween?". That is a deliberate act with the number on screen
  before it happens. A silent read-time clear is not a substitute for it, and adoption is
  what keeps the two from being confused.
- **A value nobody reads again for a year cannot be left to fall back silently at the
  consumer.** `promote_window` is read on every play, and a queue behaving oddly tonight is
  noticed tonight. A reset date is read next November. If `11-O1` (letter O) were stored
  verbatim and ignored at the consumer, the failure would surface as "the queue did not
  reset" eleven months after the typo, with the wrong value still sitting in the editor
  looking correct. So `sets.ts` parses it on the way in and **throws**: the save fails, the
  editor stays open, and the mistake is a sentence on the screen of the person who made it.
- **`01-11` is a valid date under either reading, so a text field could not refuse a
  transposed 11 January.** Day-month and month-day are both live conventions, and a field
  taking free text has no way to know which one was meant — it can only reject `13-40`, which
  is the mistake nobody makes. Two pickers, with the month spelled out, remove the ambiguity
  at the point of entry rather than trying to catch it afterwards. The day list is built from
  the chosen month, so 31 February cannot be expressed either.

## Evidence

The rule as built, `server/src/watchedReset.ts`:

```ts
const settledAt = queueWatchedReset.settlementFor(setId)?.settledAt ?? null;
if (settledAt == null) {
  // Adoption: the queue has just been GIVEN a date. Settle the occurrence that has
  // already passed and clear nothing.
  queueWatchedReset.settle(setId, nowSec, 'adopted');
  return null;
}
```

`e2e/seasonal-reset-test.ts` §2 pins it end to end, through the real
`session.startSession()`: a queue is given today's date with no settlement row, played, and
asserted to keep every `done` flag, every `queue_entry_history` row and every
`lead_cooldown` row — and to gain a settlement row whose reason is `adopted`. §4 then proves
the reset that follows fires once and not twice.

Write-time validation, `server/src/sets.ts`: `normalizeResetWatchedOnForWrite` throws on any
value `parseResetDate` refuses, and `e2e/fixtures/passthrough.sets.yaml` carries a
`seasonal_junk` set holding `"13-40"` so the loader's tolerant read is pinned separately from
the writer's strict one — a file hand-edited over SMB must still load.
