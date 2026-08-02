# A card names a Plex profile, and the scan waits for the Shield to really be on it

- **Status:** Accepted
- **Date:** 2026-07-26
- **Type:** Architecture
- **Supersedes:** —
- **Superseded by:** —

## Decision

A card's `profile` in `tag_command_map` does two jobs: it picks the channel binding to play
under, **and** it demands that the Shield actually be signed into that Plex Home profile
before anything plays. The scan blocks on the PMS log until that is true.

**The payload never satisfies its own demand.** `detected_profile` is set only from the PMS
log (`profiles.wait_for_profile`). A card saying `"profile": "Younger Kids"` is a request, not
evidence. A card that contradicts its set's `requires_profile` is a named error, not a guess.

To close the loop rather than only waiting for a human, the service drives the Shield's Plex
profile picker over ADB (`queue_builder/adb.py`), **concurrently** with the log wait. An ADB
press is never treated as proof of sign-in — it only ever turns a bare timeout into an
actionable message.

Rotation sets stay ungated in `sets.yaml`. The demand rides on the scan, not the set.

## Context

The four per-tier kid cards (`Plex: {Younger,Older} Kids {Shows/Shorts,Movies}`) replaced the
two generic `set: auto` cards. `auto` was safe by construction — whoever was signed in decided
the tier, so attribution could never disagree with the profile. Naming a tier on the card
breaks that guarantee: scanning the Younger Kids card while the Shield sits on Older Kids
would play the right content billed to the wrong account, poisoning that profile's
watched-state, which per-profile rotation and rewatch weighting both read.

`requires_profile` could not express this. It is a property of a *set*, and `shows_shorts` /
`movies` deliberately carry both tiers as `profiles[]` bindings — gating them would break the
UC3 buttons and the `auto` path. The demand is per-*scan*, so it had to live on the payload.

## Why

- Wrong-account attribution is silent and cumulative. Nothing on screen says "this went on the
  wrong profile"; it just quietly degrades both kids' watched-state.
- Keeping the log as the only thing that clears the gate means the failure mode is a visible
  wait, never a wrong-account play. A caller cannot assert its way past it.
- ADB makes the wait usually invisible without becoming load-bearing: if the switch fails, the
  gate still behaves exactly as it did before ADB existed.

## Evidence

Bob, on scope: *"That plus ADB auto-switch."* — and, when the switcher could only drive a
picker that was already on screen: *"Have you tried not just switching the account from the
profile screen, but also finding the profile screen again once a profile is selected to change
to another?"* That steer produced the in-app Switch-user route, which reaches the picker
without force-stopping Plex and killing playback.

Verified end-to-end 2026-07-26: a `shows_shorts` + `Older Kids` scan published over MQTT while
the Shield was signed in as **Younger Kids with no picker on screen**. The switcher walked
sidebar → user → "Switch user" → picker, moved one tile, committed; the log held out through
nine `Younger Kids` lines and cleared only on `Older Kids`; 12 Beast Wars episodes queued and
played under the right account.

`e2e/profile-gate-test.py` pins the decision table — notably that the wrong profile signing in
does **not** clear the gate.

## See also

- [`../adb-profile-switching-handoff.md`](../adb-profile-switching-handoff.md) — mechanism, traps, and the corrections to them
- [`2026-07-25-sets-can-require-a-plex-profile.md`](./2026-07-25-sets-can-require-a-plex-profile.md) — the per-SET gate this extends
- [`2026-07-23-sets-yaml-profiles-array-schema.md`](./2026-07-23-sets-yaml-profiles-array-schema.md) — the `profiles[]` bindings a card's profile selects
