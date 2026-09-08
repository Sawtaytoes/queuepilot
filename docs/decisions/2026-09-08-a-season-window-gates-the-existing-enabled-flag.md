# A season window gates the existing `enabled` flag, and says nothing about watched state

**Status:** Accepted
**Date:** 2026-09-08
**Type:** feature / product rule / UI
**Supersedes:** —
**Superseded by:** —

## Decision

A queue may carry a **season window** — a start date and an end date, repeating every year.
Out of season the queue is unavailable. It is **display and availability only**: a season
boundary clears nothing and marks nothing.

- **It is a SECOND gate over the stored `enabled` flag, never a writer of it.** A queue is
  available when `enabled !== false` **and** today falls inside the window. If the window
  wrote to `enabled`, the manual toggle and the schedule would fight over one value, and
  whichever ran last would win silently.
- **`enabled: false` already does the hiding, and it is already wired.** A disabled set is
  skipped by What to Watch/Play (`tonight/pick.ts:166`), by session start (`session.ts:251`),
  by the launcher (`providers/launcher.ts:41`), by topup (`topup.ts:273`), by Pending
  (`pending.ts:262`) and by reconcile (`finished.ts:149`). The season window reuses every one
  of those call sites rather than adding a parallel notion of hidden.
- **The Queues shelf still shows it, and it stays editable.** No view reads `enabled` today,
  and that stays true. An out-of-season queue is marked on its shelf card with the date it
  returns. A queue that vanishes is a support question; a queue that says "Out of season ·
  returns 1 Oct" is an answer.
- **Evaluated on a READ, like the reset date.** No timer. Availability is computed when the
  shelf or the Tonight candidate list is built.

## Context

The owner's own framing, on being shown a combined season-plus-reset option:

> "I think hiding queues in Option 3 is interesting […] What we'd do to hide it is keep it
> off 'What to Watch/Play'. But you still need a way to reset it at the end of the season,
> and that'd be Option 1; a separate option. Option 3 is more of a display one, not a
> 'reset the queue' one. So I'd see those two as different options."

The first mockup folded the reset into the season boundary — a new season starts unwatched.
That is rejected. The two are independent: a queue can be seasonal and never reset, or reset
annually and be available all year.

## Why

- **Availability and data are different questions.** One is about what the household is
  offered tonight; the other is about what QueuePilot has recorded. A single setting that
  answers both cannot be turned half off.
- **The gate already exists.** Six call sites already honour `enabled`. Adding a second,
  parallel hiding mechanism would leave five of them out of step the first time somebody
  forgot one.
- **A separate gate keeps the manual switch meaningful.** The owner can still disable a queue
  that is in season, and re-enable one that is out of it, without editing a date.

## Evidence

Owner, 2026-09-08, quoted above. The six `enabled` call sites were read in
`origin/main@81ed09b` before the decision was taken.
