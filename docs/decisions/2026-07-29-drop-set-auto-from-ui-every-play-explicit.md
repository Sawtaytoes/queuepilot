# Drop `set:"auto"` ("Shield pick") from the UI — every play is explicit

- **Status:** Accepted (implemented + deployed)
- **Date:** 2026-07-29
- **Type:** UI / interaction
- **Supersedes:** the UI surface of the `set:"auto"` path from
  [2026-07-16-plex-kids-profile-driven-cards](2026-07-16-plex-kids-profile-driven-cards.md)
  (the backend auto path is unchanged)
- **Superseded by:** —

## Decision

The web UI no longer offers **"Profile: Shield pick"** (`set:"auto"`). Every play from the
landing "Play on ▾" menu carries an **explicit** channel id + tier (`{set, profile}`). The
per-row tier picker lists only the channel's real bindings (Younger Kids / Older Kids) — the
auto option is gone from the landing and the channels view.

**Scope is the UI only.** The backend `config.channel_for()` / `set:"auto"` routing stays in
place (it costs nothing dormant and the unbuilt UC3 screen buttons still reference it in
`button_command_map`). All physical NFC cards already send an explicit `{set, profile}`, so
nothing about card behavior changes.

## Context

Explaining the landing tier picker surfaced that Bob didn't know what `set:"auto"` was:
*"I dunno what 'set auto' is, but I really wanna tie these to things that are created in the
app rather than generated on the fly from a 1-off API call. I can see the reasoning behind it
for others, but not for my personal use case."* Asked to disambiguate (drop the auto tier
selection vs. convert channels from live-rotation to curated), he chose only **"Drop 'Shield
pick' (auto) — every play is explicit."** — keeping the live-rotation content model.

`set:"auto"` resolves the tier at scan time by detecting which Plex Home profile is signed
into the Shield (reading the PMS log). It was designed for a shared/general product where a
card names only the function and the signed-in kid decides the tier. Bob is the sole
operator and every card he uses already names its tier, so the auto path added a "magic"
option he'll never pick and that only invites confusion.

## Why

- **No card uses auto.** The four/five per-tier kid cards each name an explicit tier; auto
  lived only in the landing menu and the not-yet-built on-screen buttons. Removing the menu
  option removes the confusion without touching anything load-bearing.
- **Explicit is legible.** A play that names its tier can never disagree with where the watch
  records — the same reason the per-tier cards were made explicit
  ([2026-07-26-cards-name-a-profile-and-the-scan-waits-for-it](2026-07-26-cards-name-a-profile-and-the-scan-waits-for-it.md)).
- **Reversible.** The backend auto path is left intact, so re-adding the option later (e.g.
  when the UC3 buttons ship) is a UI-only change.

## Evidence

- Bob, 2026-07-29: the quote above; AskUserQuestion answer = "Drop 'Shield pick' (auto)".
- Preview verification: every landing tier dropdown = `["Younger Kids","Older Kids"]` — no
  "Profile: Shield pick" anywhere. Gating e2e green.

## See also

- [2026-07-29-dynamic-channels-first-class-and-deletable.md](2026-07-29-dynamic-channels-first-class-and-deletable.md)
