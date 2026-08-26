# A lead window is stamped when playback STARTS, not when the lineup is built

- **Status:** Accepted
- **Date:** 2026-08-26
- **Type:** playback semantics / data
- **Supersedes:** —
- **Superseded by:** —
- **Builds on:** [kind-is-picks-or-rules](2026-08-23-kind-is-picks-or-rules.md) §4.2

## Decision

`engine/resolve.nextQueue()` **reports** which `lead: once` entries led, as
`QueueResult.led`. It writes nothing. `session.startSession()` calls `promote.recordLead()`
for those keys **after the handoff succeeds** — below every early return, and below the
profile gate.

## Context

§4.2 of the lanes ADR says "after a successful `once` contribution, record the lead
timestamp". The resolver is the obvious place to put that line and the wrong one.

A lineup gets built by more callers than the one that plays it: the preview endpoint, a
scan whose profile gate never opens, a scan the owner cancels, a scan that dies on a Plex
error before `playMedia`. Stamping at resolve time spends a 24-hour promise on a sitting
nobody watched — and the failure is silent and slow, because the entry simply is not first
tomorrow either.

## Why

- **A window is a fact about what PLAYED**, so it is written where playing is known to have
  happened. `[finished]` bookkeeping already sits on that side of the seam for the same
  reason.
- **The engine holds no database handle**, and this keeps it that way. The lead GATE is
  injected as `resolve.LeadGate` (a closure `providers/plex.ts` binds to
  `promote.canLeadOnce`), so the parity corpus still replays the engine with no SQLite
  anywhere near it. A null gate means "nothing has ever led", which is what a fresh store
  says anyway.
- It also makes the ledger testable without a database: `led` is an assertion on a returned
  object.

## Evidence

- `e2e/priority-lane-test.ts` case 8 — resolving a lineup twice leaves
  `promote.canLeadOnce()` true.
- `server/src/session.ts` — the `recordLead` loop sits after `SESSION.playQueueID` is
  assigned, which is after `handoff` returned without `cancelled` or `error`.
