# The screen outranks the observation, and a session proves the play

- **Status:** Accepted
- **Date:** 2026-09-23
- **Type:** Bug fix / playback correctness
- **Supersedes:** the PMS-log-only observation source and unconditional second-walk clauses of
  [2026-08-21](2026-08-21-the-profile-gate-verifies-the-account-plex-is-playing-as.md)
  *(jointly with [2026-09-07](2026-09-07-a-plex-session-observation-skips-the-profile-picker.md),
  whose remembered-observation fast path this narrows)*
- **Superseded by:** —
- **Extends:**
  [2026-09-07](2026-09-07-a-plex-session-observation-skips-the-profile-picker.md)

> ⚠️ **This record was written on 2026-10-12, not on the day it describes.** The change
> shipped as `81244a6` (#339) citing this filename, and the file was never created — the
> commit message names that as a KNOWN GAP. What follows is reconstructed from that commit
> message and from the code it landed, both of which are specific; nothing here is inferred
> beyond them. The DATE is the decision's, by the convention at the top of the index.

## Decision

**Two things outrank a remembered profile observation, and one thing proves a play.**

1. **THE SCREEN OUTRANKS THE MEMORY.** `adb.isPickerForeground()` — later folded into the
   single `adb.profileScreen()` snapshot — reads the foreground activity in about 50 ms before
   the skip decision. When the profile picker is on screen the driver walks it, whatever
   `profiles.LAST_SEEN` says. An observation states who the Shield was signed in as; it cannot
   state that Plex's cold launch has just put the picker up and is waiting for a pick.
2. **A PLAY IS PROVEN BY A SESSION, NOT BY COMPANION'S 200.** `playback.verifyAccount()`
   reports `hasSession` separately from the account comparison, and waits
   `PLAYBACK_SESSION_WAIT_SECONDS` — **25 s**, up from 12 — because the Shield posts its first
   `playing` timeline about 15 s after a good push. A push with no session behind it is
   re-opened and pushed again, up to `PLAYBACK_SESSION_RETRIES` times.
3. **The session wait runs even when no account is bound.** The session is the proof either
   way; only the comparison needs a binding.

Client mode only, for both retry clauses: cast mode has no Companion and no ADB to re-open
with.

## Context

Two failures from one cold-start scan on 2026-09-23, with one cause each.

The first: the remembered observation was **three hours old and correct**, and the picker was
on screen anyway. The skip fired, the play landed on top of the picker, and the Shield tore the
player down five seconds later. Both facts were true at once, and the gate could only see one
of them.

The second: the client accepted the Companion command, opened the player over the picker,
posted one `buffering` timeline, and went back to Home. The post-play audit's "no opinion" was
logged and dropped, so nothing noticed that nothing was playing.

The 2026-08-21 correction had deliberately made an ADB success untrustworthy, and
[2026-09-07](2026-09-07-a-plex-session-observation-skips-the-profile-picker.md) gave the gate a
trustworthy substitute. Neither anticipated the picker being up *while* the observation was
right.

## Why

- **The 12 s wait abstained on nearly every play**, including the one where nothing was
  playing. A verifier that almost always shrugs is not a verifier; the number was chosen
  before anybody had measured how long the Shield takes to register a session.
- **`hasSession` and the account comparison are different questions** and were conflated. "Is
  anything playing" is answerable without a binding; "is it playing as the right person" is
  not. Folding them left the first one unanswered whenever the second did not apply.
- **A 50 ms dumpsys read is cheaper than the failure it prevents.** The latency work that
  motivated the skip ([2026-09-07](2026-09-07-a-plex-session-observation-skips-the-profile-picker.md))
  is not undone by one activity read; it is undone by a torn-down player.
- **Re-pushing is safe where re-switching is not.** A second `playMedia` over a client that
  dropped the first one costs a few seconds. That is why the retry lives on the play and not
  on the profile walk.

## Evidence

- Commit `81244a6` — *Walk the picker when it is on screen, and prove a play with a session*
  (#339), merged 2026-09-25, recovered from a worktree where it had sat since 2026-09-23.
  Gates recorded on that tree: `typecheck` clean, 813 tests passing, `lint` clean of errors.
- `e2e/fsm-wake-and-skip-test.ts` `(bug2e)` — picker on screen plus an observed match walks
  the picker anyway, and the walk still uses the remembered title as its navigation hint;
  `(bug2e2)` — with Plex on Home the same observation still skips.
- `e2e/account-audit-test.ts` — the no-session path re-pushes and then reports the last push
  as-is; the session wait runs with no bound account.
- `server/src/env.ts` — `PLAYBACK_SESSION_WAIT_SECONDS` 25, `PLAYBACK_SESSION_RETRIES` 1,
  both with the measurement in the comment.

## Follow-up (not in this change)

- **A remembered observation still never expires.** This record bounds it by what is on
  SCREEN, not by age, and the 2026-09-23 incident itself involved a three-hour-old one. Closed
  on 2026-10-12 by
  [a profile observation expires](2026-10-12-a-profile-observation-expires-and-a-gated-push-is-audited.md).
- **Nothing reconciles history after the fact**, the open item the 2026-08-21 record also
  left. Closed by the same later record.
