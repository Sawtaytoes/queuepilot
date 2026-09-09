# A Priority cooldown is spent only when Priority leads

- **Status:** Accepted
- **Date:** 2026-09-08
- **Type:** correctness / playback semantics / durable data
- **Supersedes:** the broad reading of "successful contribution" in
  [A lead window is stamped when playback starts](2026-08-26-the-lead-window-is-stamped-when-playback-starts.md)
  — the stamp still happens after a successful handoff, but eligibility and presence later in
  the lineup are not enough. Priority must supply the lineup head, and the entry must survive
  the playback cap.
- **Superseded by:** —

## Decision

`QueueResult.led` contains a `lead: once` entry only when both statements are true:

1. The Priority lane supplies the lineup head. An in-progress Random-pool entry ahead of
   Priority means Priority did not lead, even when its entries appear later in the lineup.
2. That entry contributes at least one item inside the playback cap. Passing the lead gate is
   eligibility, not a played contribution.

`session.startSession()` still stamps those reported keys only after the handoff succeeds. The
settled precedence is unchanged: an in-progress Random-pool item still outranks a promote.

An entry that leaves a set also loses that set's `lead_cooldown` row. This applies to direct
and bulk removal, manual and timed removal of completed entries, and direct and bulk moves.
A remove followed by an add of the same item therefore starts with an unused lead window.

## Context

A fresh Priority entry passed its gate, but an in-progress Random-pool show became the lineup
head. The Priority entry appeared second. `nextQueue()` nevertheless returned it in `led`, so
the successful handoff stamped its cooldown. Later starts suppressed the entry even though it
had never led.

Removing and adding the entry did not repair the state. The new line had the same stable entry
key, while `removeItem()` deleted only the queue row and left the cooldown row behind.

The same assembly had a quieter version of the first defect. Every eligible Priority entry was
reported in `led` before the playback cap was applied, so a later Priority batch could consume
its window without appearing in the handed-off lineup at all.

## Why

- A lead cooldown records a spent promise. A position behind the actual head did not satisfy
  that promise.
- The in-progress precedence remains useful and unchanged. The fix changes bookkeeping, not
  which item resumes.
- A removed entry makes no promise in that set. Keeping its cooldown creates an orphan that
  becomes active again if the same stable key returns.
- The engine still has no database handle. It reports the exact keys; the session owns the
  post-handoff write, and the queue writers own removal cleanup.

## Evidence

- Owner, 2026-09-08: "It's priority, but not showing up in the queue." Then, after the cause
  and the two-part correction were stated: "Yes fix." Chat `t3code-82e983e6`.
- The production scan reported one resuming pool batch, one eligible Priority batch, the pool
  batch as the head, and then a lead stamp for the Priority entry. The next scans reported the
  same Priority key as suppressed.
- `e2e/priority-lane-test.ts` pins both false-spend cases: a Priority entry behind a resumed
  head, and an eligible Priority entry beyond the playback cap.
- `e2e/entry-id-test.ts` pins cooldown cleanup for one-line and bulk removal without changing
  stable entry identity.
