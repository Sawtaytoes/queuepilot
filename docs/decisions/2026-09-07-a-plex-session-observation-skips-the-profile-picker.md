# A Plex session observation skips the profile picker

- **Status:** Accepted
- **Date:** 2026-09-07
- **Type:** Bug fix / playback latency / diagnostics
- **Supersedes:** the PMS-log-only observation source and unconditional second-walk clauses of
  [2026-08-21](2026-08-21-the-profile-gate-verifies-the-account-plex-is-playing-as.md)
- **Superseded by:** —

## Decision

**An account named by the target player's Plex session is a trusted profile observation.**
QueuePilot reads `/status/sessions` once before it opens the profile picker. It matches the row
to the target player by machine identifier, with the configured player name as a fallback, and
reads that row's `User.id` / `User.title` with the admin token. It never falls back to the first
session in the response: another room's session is no evidence about this player.

The profile transition has four outcomes:

1. An active target session names the required `account_id`: record its title in
   `profiles.LAST_SEEN` as OBSERVED and skip the picker.
2. An active target session names another account: record that account's title as OBSERVED and
   walk the picker from it. If Plex omits the title, invalidate the older observation before the
   walk. The numeric account mismatch outranks the alias table, so even a bad alias cannot turn
   this positive mismatch back into a skip.
3. No active target session, but `LAST_SEEN` holds a Plex-observed title that aliases to the
   required profile: skip the picker. This is the idle continuation after a prior verified play.
4. Neither source proves the account: keep the existing picker walk. A successful ADB selection
   remains a CLAIM and remains insufficient to clear the next gate.

The post-play account audit already receives the independent proof this rule needs. A matching
`verifyAccount()` result now promotes its `User.title` (or the required profile when Plex omits
the title but the account id matches) to an OBSERVATION. A positive mismatch records the actual
title before it stops playback. An abstention changes no observation.

The one-shot preflight has a one-second request ceiling. Every branch writes its reason to the
runtime log: matching active session, different active session, no usable active session,
matching remembered observation, picker required, matching post-play audit, or audit
abstention. The log must therefore distinguish "Plex proved this account" from "QueuePilot had
no proof and opened the picker."

## Context

The 2026-08-21 correction deliberately made an ADB success untrustworthy. `switchTo()` can see
the requested tile and can see the picker disappear, but neither fact says Plex accepted the
profile. A real run reported a successful Younger Kids switch while Plex scrobbled the following
items to the owner. Trusting the resulting `LAST_SEEN` claim made every later start skip the gate
and repeated the wrong-account write. The correction marked the ADB-written title
`isObserved: false` and pinned a second direct `driveProfile()` call to walk again.

That correction also left a usable proof on the floor. `driveToPlaying()` reads the target
session after every successful handoff and compares its `User.id` with the binding's
`account_id`, but it logged a match and discarded it. On this deployment the older PMS-log
observer cannot replace it: the reverse proxy's address appears on profile-stamped requests, not
the Shield's address. Repointing the regular expression at the proxy would let QueuePilot's own
managed-token requests masquerade as the Shield and would recreate the self-confirming gate.

The owner reported the visible cost in T3 Code chat `t3code-0cc33175`:

> "Even if I'm on mine, if I start a new queue, it always backs out and changes profiles again,
> and that's pretty slow. If it was instant, no big, but it's super slow."

He then required the reason and the fallback to remain diagnosable:

> "Yes, fix. Document this in case it doesn't work right. There must be some reason it was
> marked untrustworthy. The logs should show though."

## Why

- `/status/sessions` names the account Plex will scrobble to. It is the safety authority the
  2026-08-21 change already chose for the post-play audit.
- A queue-to-queue start normally occurs while the old queue still has an active or paused
  session. One local PMS read can answer before any destructive navigation.
- The post-play audit turns a switch claim into an independent observation. Remembering that
  observation restores the intended idle fast path without trusting the keypress that failed.
- An idle Plex app exposes no current user through Companion, non-root ADB cannot read Plex's
  private state, and `uiautomator` sees only the picker selection. The safe unknown case must
  still walk the picker.
- Strict target matching prevents another room's active session from authorizing a skip on this
  player.

## Evidence

- `e2e/account-audit-test.ts`: a matching active session skips the picker; a different active
  session walks it from the observed title; a successful post-play audit marks the profile
  observed; the next queue skips; mismatch and abstention retain their safety behavior.
- `e2e/profile-session-observation-test.ts`: a real HTTP fixture proves the admin-token request,
  strict target-player match, another-session refusal, missing-`User.id` refusal and player-name
  fallback.
- `e2e/fsm-wake-and-skip-test.ts`: an ADB claim alone still cannot clear a second direct profile
  gate.
