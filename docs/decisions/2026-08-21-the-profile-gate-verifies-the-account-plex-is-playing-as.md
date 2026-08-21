# The profile gate verifies the ACCOUNT Plex is playing as, not the keypress it sent

- **Status:** Accepted
- **Date:** 2026-08-21
- **Type:** Bug fix / playback correctness
- **Supersedes:** —
- **Superseded by:** —
- **Extends:** the workspace-root record *ADB is enabled on the Shield, for closed-loop Plex profile
  switching* (2026-07-26),
  [2026-08-16-a-curated-queue-plays-as-the-profile-it-is-gated-to](2026-08-16-a-curated-queue-plays-as-the-profile-it-is-gated-to.md),
  [2026-08-17-a-filtered-pool-is-locked-to-one-account](2026-08-17-a-filtered-pool-is-locked-to-one-account.md)

## Decision

**A play is not "gated to a profile" until QueuePilot has read back the account Plex is
actually playing as.** Three changes, in ascending order of how much they matter:

1. **`adb.switchTo()` confirms the commit landed.** It used to `return [true, …]` on the
   `KEYCODE_DPAD_CENTER` keypress. It now waits for the picker activity to go away, and
   reports failure if it does not.
2. **`profiles.LAST_SEEN` carries provenance, and only an OBSERVATION may clear a gate.**
   `waitForProfile()` sets `isObserved: true` (it matched a real PMS log line);
   `driveProfile()` writes the title alone, as a claim. `driver.onRequired()` — the "already
   signed in; no picker walk" fast path — now requires `isObserved`.
3. **`driveToPlaying()` audits the account after play, and stops a mismatch.** A new
   `playback.verifyAccount()` reads `/status/sessions`, matches our client, and compares the
   session's `User.id` to the binding's `account_id`. A positive mismatch calls
   `playback.stopPlayback()` and returns a spoken error naming the set, the wanted profile
   and the one it actually played as. **Abstention is not failure:** no session yet, or Plex
   unreachable, passes the play through untouched.

**Only a positive mismatch is terminal.** Killing a play that is probably fine is a worse
failure than an audit that occasionally has no opinion — a transcode can take longer to
register a session than a card scan should block for.

## Context

The owner, 2026-08-21, with a screenshot of his own Plex Shorts library:

> "I ran into an issue where a bunch of shorts for 'Younger Kids' account were watched on my
> account. Can we fix that? I haven't viewed anything in the last week, but my kids have. Why
> are these showing up in my account? Was it something weird where the Shield wasn't able to
> get in the right account, and it just used mine? **It should error instead**, but it
> shouldn't need to error in the first place."

He was right on both counts. The failure is reconstructible minute by minute:

| Time (2026-08-18) | What | Source |
| --- | --- | --- |
| 15:58 | Shield signed in as **Older Kids**, 6.4 min into *Rabbit's Feat* | Plex, Older Kids token |
| 15:58:45 | QueuePilot `waiting`, set `shorts`, `awaiting: profile:Younger Kids` | HA `sensor.queuepilot_status` |
| 15:59:01 | QueuePilot `playing`, `profile: Younger Kids`, `played: true`, playQueue 15023 | HA, same sensor |
| 16:04 / 16:16 / 16:24 | *Africa Before Dark*, *Mulberry Street*, *April Maze* → **accountID 1** | Plex history |

Sixteen seconds to walk the picker, declare victory, and play as the wrong person. The set was
never misconfigured: live `sets.yaml` has `shorts` with exactly one binding
(`plex_user: Younger Kids`, `account_id: <younger-kids-id>`), as
[2026-08-17](2026-08-17-a-filtered-pool-is-locked-to-one-account.md) intended. The **data** was
right and the **gate** was decorative.

### Why nothing caught it

Every check in the chain verified an intention, never an outcome:

- `adb.switchTo` verified that the right tile was lit when CENTER was pressed. A profile PIN, a
  pick that does not take, or a picker that re-renders all leave the right tile lit and the
  sign-in unchanged — and every one of them returned success. Its own comment argued
  re-verifying would cost 1.9s "to learn what we just learned"; it would not have, because the
  dump answers *which tile is lit* and the question after CENTER is *did Plex act on it*.
- `driveProfile` verified that `switchTo` said ok, then **wrote that claim into `LAST_SEEN`**.
- `onRequired` read `LAST_SEEN` back to skip the picker walk — a cache confirming its own last
  guess. Once wrong it stayed wrong on every later play, silently. `profiles.ts` had said so in
  a comment since the port: LAST_SEEN is a hint, "**never as anything that clears a profile
  gate**." The FSM did exactly that.
- `drivePlay` verified that Companion answered 200, which says nothing about the account.

The one independent verifier could not fire. `waitForProfile()` matches
`[<SHIELD_IP>:<port>] … Signed-in Token (X)` in the PMS log, and **the Shield's requests do not
appear in that log under 192.0.2.30** — across ~60 MB of current logs, every profile-stamped
line comes from the reverse proxy's address (`192.0.2.1` here) rather than the Shield's. With `PLAYBACK_FSM=true` and
`ADB_ENABLED=true` (both live), `driveProfile` never calls `waitForProfile` at all, so the
detector's silence was itself silent.

### The PMS-log detector is not repaired here, and re-pointing it would be worse

The obvious fix — point the regex at the proxy's address — is actively harmful. That log line carries
no device identity, so the proxy's address is shared by **QueuePilot's own API calls**. A
detector keyed on it would match the app's own Younger Kids-token requests and cheerfully
"confirm" whatever the gate had just asked for: a verifier that always agrees. It stays keyed on
`SHIELD_IP`, where it is merely inert.

`/status/sessions` replaces its safety role entirely and is strictly better — it is Plex's own
answer to "who is watching", not an inference from a debug line, and it needs no DEBUG logging,
no log mount and no IP assumption. What it cannot do is answer *before* playback starts, which
is why `waitForProfile` survives for the `set: "auto"` path (an NFC card, where whoever is
signed in **is** the answer). **That path is still blind on this deployment** and is the open
follow-up below.

## Why

- **The gate exists so "a card can never play under the wrong account"** (the `sets.yaml`
  header). It was enforcing the half it could see. A gate that reports success on a keypress is
  a gate in name.
- **Attribution follows the Shield's sign-in, not the token that built the playQueue.** This is
  visible in the wreckage: Younger Kids held near-complete `viewOffset` on *April Maze* and
  *Mulberry Street* with **no `viewCount`**, while the owner held the completions. The progress
  went to the token; the scrobble went to the signed-in profile. Any fix that only got the token
  right — which `playToken()` already did — could not have prevented this.
- **Post-play beats pre-play because it is the only one that can be true.** Nothing on the
  device can prove which profile Plex signed into: non-root ADB cannot read Plex's app data, and
  `uiautomator` only sees the picker. A session can prove it, and a session requires playback.
  Stopping two seconds of a cartoon is a real cost and a much smaller one than a month of
  silently mis-filed watch history.
- **Provenance rather than deleting the fast path.** The skip is genuinely valuable — it avoids
  summoning the picker over something already playing correctly. What made it unsound was the
  source of its knowledge, not the optimisation. Tagging the source keeps the optimisation and
  makes it self-healing the day the PMS detector works again.

## Evidence

- Owner report + Plex screenshot, 2026-08-21.
- HA `sensor.queuepilot_status` history, 2026-08-18 15:58:45 → 15:59:01 (the `waiting` →
  `playing` transition above), and 2026-08-15 09:24:30 → 09:24:38, whose first short also
  landed on accountID 1 before a human switched the Shield by hand at ~09:35.
- Plex `/status/sessions/history/all?librarySectionID=15`: **8** QueuePilot-era shorts recorded
  under accountID 1 — *April Maze*, *And to Think That I Saw It on Mulberry Street*, *Africa
  Before Dark* (08-18), *8 Ball Bunny* (08-15), *A Corny Concerto* (08-08), *Mickey's Polo
  Team*, *One Droopy Knight*, *Rhapsody in Rivets* (07-23). All eight were unscrobbled from the
  owner, their history rows deleted, and scrobbled under Younger Kids on 2026-08-21.
- `App-Configs/queuepilot/profile-order.json`, mtime `Aug 18 15:58` — the picker order was
  re-fetched from plex.tv during that exact session, and what it cached is the **plex.tv Home
  order** (`Bob Smith, Demo, Alice, Carol, Dave, Older Kids, Younger Kids`), which is
  not verified to be the on-screen picker order the D-pad offsets are computed against.
- PMS logs, all six rotations: zero requests from the Shield's address; every
  `Signed-in Token (…)` line from the reverse proxy's.
- Gate: `e2e/account-audit-test.ts` (22 checks, wired into CI's offline engine block) — a
  mismatch stops playback and returns a spoken sentence naming all three parties; a match passes
  through; an abstention passes through; no bound account skips the audit; a failed play keeps
  its own error. `e2e/fsm-wake-and-skip-test.ts` gains `(bug2b2)` and `(bug2c2)`, pinning that an
  unobserved title does not clear the gate and that a second gated scan re-walks the picker.

## Follow-up (not in this change)

- **The `set: "auto"` path is still blind.** An NFC card sends `set: "auto"`, and
  `startSession` resolves it with `waitForProfile({match: null})` — the detector that cannot
  match. On this deployment that path must currently time out with "no profile is signed in on
  the Shield." No auto-path start appears in a week of HA history, so it is untested rather than
  known-broken; it needs a real card tap to characterise, and then a device-identity signal that
  survives the proxy.
- **The picker order is assumed, not read.** `offset()` computes D-pad steps from the plex.tv
  Home-user order. The read-back loop corrects a wrong step count, but it is a bounded walk
  (`ADB_MAX_PRESSES`) recovering from a model that may simply be wrong. Reading the order off
  one `uiautomator` dump would replace the assumption with a fact.
- **Nothing reconciles history after the fact.** This change stops a wrong-account play within
  seconds; it does not notice one that already happened. A periodic check that a gated set's
  recent history carries only its bound account would have caught this on 2026-07-23 instead of
  a month later.
