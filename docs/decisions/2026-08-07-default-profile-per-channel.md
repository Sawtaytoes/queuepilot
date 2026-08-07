# A channel can name a default profile the Play/Channels dropdowns start on

- **Status:** Accepted (implemented; not yet deployed)
- **Date:** 2026-08-07
- **Type:** UI / data model
- **Supersedes:** —
- **Superseded by:** —

## Decision

A rotation channel may carry a top-level **`default_profile`** in `sets.yaml` — a
string equal to one of its bindings' `plex_user`. It decides which tier the
**Play** landing rows and the **Channels** view seed to, so a channel plays the
right profile from the web UI without the user re-picking the dropdown each visit.

- **Set it** from the ⚙ Configure editor (DynModal): a "Default profile" select,
  shown only when the channel binds ≥2 named profiles (with one binding there is
  nothing to choose). Leave it unset to fall back to the first binding.
- **It is a UI-seed hint only.** The Python engine ignores the key entirely and
  still plays whichever profile the play menu passes at play time. The Node reader
  round-trips it (`normalize` exposes it; `updateSet`/`createSet` write it; a blank
  value deletes the key).
- **Stale-safe.** If the named profile is later renamed or removed, both dropdowns
  and the save path fall back to `profiles[0]` — a stale default is never an error.
- **Precedence in the Channels view:** a carried-over in-session pick that still
  matches a binding wins (so browsing keeps your choice), then `default_profile`,
  then the first binding. Each Play row seeds independently from its own default.

## Context

The Play landing (`PlayView`) and the Channels view (`ChannelsView`) each render a
per-channel profile dropdown that hard-seeded to `options[0]` — the first binding in
the channel's `profiles[]`, purely file order. So "Shows & Shorts" opened on "Older
Kids" and the rest on "Younger Kids" only because that is how the bindings were
listed; picking another tier was forgotten on reload. The owner wanted to pin the
right one so Play reaches for it by default.

## Why

- The default is **book-of-record in the config**, so every device/browser honors it
  (the alternative, per-browser localStorage, is invisible in the config and does not
  travel — the owner uses several devices and agents against these repos).
- It is a **pure seed hint**, deliberately not read by the playback engine, so it can
  never change what actually plays — only which option is preselected.
- Gating the editor control on ≥2 bindings keeps a meaningless "default" off
  single-profile channels.

## Evidence

- Owner: *"plex-channels can I select one of these profiles as the default? That way,
  it can play the right one from the web UI without having to remember."* — then chose
  **"Config default (Option A)"** over per-browser remember-last-pick.
- Implementation: `server/src/sets.js` (`normalize` `default_profile`; `updateSet`
  allow-list + clear-on-blank; `rotationCreateObj` write), `web/src/lib/types.ts`
  (`RegistrySet.default_profile`), `web/src/views/PlayView.tsx` (row seed),
  `web/src/views/ChannelsView.tsx` (`resolveInitialProfile`),
  `web/src/components/DynModal.tsx` (Default profile select). Coverage:
  `e2e/api-v2-test.mjs` — create persists / patch re-points / blank clears to null.
