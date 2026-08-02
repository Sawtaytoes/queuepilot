# A set can require a Plex Home profile; the scan waits for the switch

- **Status:** Accepted (implemented + deployed 2026-07-25)
- **Date:** 2026-07-25
- **Type:** data model / playback gating
- **Supersedes:** —
- **Superseded by:** —

## Decision

A set in `sets.yaml` may declare **`requires_profile: <exact profile title>`**. When it
does, `do_start` blocks until the Shield is signed into that profile before building or
playing anything:

```yaml
- id: demo
  label: Theater Demo Reel
  requires_profile: Demo
```

The wait reuses the existing PMS-log detector, with a new `match` argument:
`profiles.wait_for_profile(match="Demo")` **skips** any other signed-in profile it sees
instead of returning it, so a single call spans the on-screen profile switch. The card
and the profile pick can happen in either order. On timeout
(`PROFILE_WAIT_SECONDS`, 120s) the state carries a named error rather than a silent
no-op.

The gate consults **only** the log-detected profile, never the start command's `profile`
field. That field names a `profiles[]` binding to play under and is caller-supplied, so
letting it satisfy the gate would let the web UI assert a sign-in state it cannot know.

### The value is the log's string, and the owner is not his profile title

`requires_profile` is matched against the PMS log's `Signed-in Token (...)` stamp. Managed
users appear as their Plex Home **title**; the owner appears as his plex.tv **username**.
Distinct values observed across all rotated logs:

```
sawtaytoes · Younger Kids · Older Kids · Demo · Carol Smith · Dave Brown · guest1
```

So Bob's sets take **`sawtaytoes`**, NOT the Plex Home title "Bob Smith" — that
would never match and every Bob card would hang until the 120s timeout. Verify a new
value against the log before adding it.

### Applied to (2026-07-25)

Every `source: queue` set, since each is a specific person's curated queue:

| Sets | `requires_profile` |
| --- | --- |
| `bob`, `family`, `bob_alice`, `bob_dave_movies`, `bob_anime`, `bob_alice_anime`, `family_anime` | `sawtaytoes` |
| `demo` | `Demo` |

The `source: rotation` sets (`shows_shorts`, `movies`, and the superseded `younger`/`older`)
are deliberately **left ungated**: they are the `set: "auto"` targets, where the signed-in
profile *selects* the binding. Gating them would contradict their whole purpose.

For the Bob sets the failure being prevented is subtler than the demo reel's. Their
libraries (1, 5, 11, 14, 15) ARE visible to the kid profiles, so a scan on the wrong
profile would happily play - and record the watch against a kid's account. The gate makes
that mis-attribution impossible rather than merely unlikely.

Session state now also publishes `profile` on `plex-channels/state`, which nothing
exposed before. It is **last-seen-at-scan, not live** — it is only sampled while a scan
is tailing the log, so it goes stale between scans and must never be polled.

## Context

The theater demo reel was wired to a card on 2026-07-25 and appeared not to play. The
clips live in **Demos (2)** and **Movie Clips (7)**, which are shared with the `Demo`
profile only. Checked against live Plex by minting each managed user's server-scoped
token and listing `/library/sections`:

| Profile | Sections visible |
| --- | --- |
| owner (`sawtaytoes`) | 1, 2, 3, 5, 6, 7, 8, 9, 11, 14, 15, 16, 17 |
| **Older Kids** | 1, 5, 11, 14, 15 |
| **Younger Kids** | 1, 3, 5, 11, 14, 15 |

Neither kid profile can see 2 or 7. Scanning the demo card while the Shield sits on a
kid profile therefore cannot ever play: the playQueue builds fine under the owner token
and Companion answers the `playMedia` with HTTP 200, so nothing upstream looks wrong.

This is invisible in the logs. `played: true` in the state payload means only "Companion
returned 200" — `playback.py` already notes that Companion answers 200 with a body of
`"Failure: 200 OK"` even when playback does not start.

## Why

- **The failure mode is silent and profile-dependent**, so it is not reproducible on
  demand and reads as flaky. A named gate turns it into an explicit, visible wait.
- **The `auto` cards already prove the pattern.** They block on the same detector; this
  generalizes "wait for a profile" from "whoever is signed in" to "this specific one".
- **Only the log knows.** There is no API for "which profile is the Android TV app
  signed into" (see the `profiles.py` docstring), so this cannot be gated in Home
  Assistant, and the current profile cannot be polled before deciding — it can only be
  waited for. That constraint is what makes a blocking wait the right shape.

## Alternatives rejected

- **Share Demos + Movie Clips with the kid profiles.** One settings change and the card
  would work from any profile, but it exposes the demo/calibration libraries to the kids'
  browsing for the sake of a card that is only ever used to show the room off.
- **Gate it in Home Assistant.** Impossible: HA has no way to read the signed-in profile
  (that is the whole finding), and the Plex integration's client entity only reveals a
  username once a session is already playing.
- **Fall back to the owner token in client mode.** Playback records under whoever the app
  is signed in as regardless; the token in `playMedia` does not override the client's own
  sign-in.
- **Go back to Plex Cast**, which plays under a chosen account's token no matter what the
  Shield is signed into, and would sidestep this entirely. Retired permanently in the
  agentic repo's
  `docs/decisions/2026-07-16-plex-kids-client-mode-not-cast.md` because the Cast receiver
  gives no audio/subtitle control mid-playback. That loss lands hardest on exactly this
  set: the demo reel exists to show off Atmos and Dolby Vision, so surrendering audio-track
  control to play it is the wrong trade.

## Evidence

Bob, on why the demo card did nothing:

> it was on the Older Kids account in Plex, so it couldn't play back demo clips anyway

and, proposing the fix in the same session:

> when you scan a card, wait till a profile change occurs, and then start when the
> correct profile is active

Verified against a synthetic PMS log before deploying: the `auto` path still returns the
first signed-in profile; the gate holds out through `Older Kids` and `Younger Kids` and
returns on `Demo`; a profile that never appears times out cleanly at the deadline; an
already-correct profile returns without waiting; a newer scan still cancels a pending
wait (the no-session-lock rule).
