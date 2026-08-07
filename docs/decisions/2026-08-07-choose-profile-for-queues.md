# 2026-08-07 — Curated queues can choose their `requires_profile` in the web editor

Status: Accepted
Date: 2026-08-07
Type: frontend + server (web editor / sets API)
Supersedes: —
Superseded by: —

## Decision

The Set editor modal (`SetModal`) gains a **"Plays under profile"** select for curated
queues. It writes the set's `requires_profile` — the play-gate that makes a scan wait (and
ADB-switch the Shield) until that Plex Home profile is signed in before playing. Options:

- **Any — no profile lock** (blank → the key is dropped: ungated).
- Every Plex Home profile from `/api/profiles`. The written value is the string the PMS log
  stamps, which the gate matches on: a **managed user** stamps its title (`Demo`,
  `Younger Kids`, `Older Kids`), the **owner** stamps the plex.tv **username**
  (`sawtaytoes`), *not* the Home title. So the option value is `username` for the admin and
  `name` for everyone else.
- A current hand-set value that is no longer a live profile is preserved as its own
  `"<value> (current)"` option, so opening an existing gated queue never silently drops it.

Server: `requires_profile` is added to `updateSet`'s allowlist and to `createSet`'s curated
object, and `normalize()` now emits it so the UI can prefill. `homeUsers()` additionally
returns `username` (the owner's gate string). Rotation channels **reject** a non-empty
`requires_profile` — they are profile-DRIVEN (`set:"auto"` lets the signed-in profile pick
the tier), so a fixed gate there would break routing; the picker is therefore only shown in
`SetModal` (curated queues), never `DynModal`.

## Context

`requires_profile` shipped 2026-07-25 for the demo reel (its Demos/Movie-Clips libraries are
invisible to the kid profiles, so it can only play under `Demo`). Until now it was
**hand-YAML only** — `docs/demo-reel-channel.md` flagged the gap: "The web UI does not show
or edit this field yet; hand-edit it here." The same need recurred for the `ivtc_test`
diagnostic reel (`.hack//SIGN` NTSC-DVD judder A/B), which also lives in Demos-only and must
play under `Demo`. The owner asked to make the profile choosable from the UI.

## Why

- Any queue whose libraries are shared with a single profile must gate to it or it stalls
  silently (the playQueue builds under the owner token and Companion returns 200 regardless).
  Hand-editing YAML for that is exactly the friction the web editor exists to remove.
- Sourcing options from `/api/profiles` (already used by the rotation binding form) keeps the
  list correct as Home profiles change, and the `username`-for-owner mapping avoids the
  footgun of writing the Home title (`Bob Smith`), which would never clear the gate.

## Evidence

- Owner: *"we need to update plex-channels to allow choosing the profile for queues."*
- Verified against live Plex via a sandboxed dev server (config copied to `/tmp`): `/api/sets`
  returns `requires_profile: "Demo"` for `ivtc_test`; `/api/profiles` returns the owner with
  `username: "sawtaytoes"` and `Demo` as a managed user. Typecheck clean, 37/37 web tests
  pass, modal screenshotted (`__screenshots__/setmodal-profile-picker.png`) — "Plays under
  profile → Demo" prefilled, hint on its own line.
