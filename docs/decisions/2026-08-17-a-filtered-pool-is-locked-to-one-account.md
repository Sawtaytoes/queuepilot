# A filtered pool is locked to ONE account, so its row has no profile picker

- **Status:** Accepted
- **Date:** 2026-08-17
- **Type:** ui / data model
- **Supersedes:** —
- **Superseded by:** —
- **Extends:** [2026-08-16-filtered-pools-curated-pools-ordered-queues](2026-08-16-filtered-pools-curated-pools-ordered-queues.md),
  [2026-08-07-default-profile-per-channel](2026-08-07-default-profile-per-channel.md)

## Decision

**A filtered pool plays as exactly one account, and the Play landing does not ask which.**
The per-row tier picker (`.rowtier`) is gone from a single-binding pool; the account it is
locked to prints in the row's meta line as text, first:

```
Shows & Shorts
Older Kids · rotation · ratings-filtered      [ ▶ Play on ▾ ]
```

That is the same row shape a Curated Pool and an Ordered Queue already have — name, meta,
one start button — which is the whole point: three groups, one grammar.

**The picker is made conditional, not deleted.** A pool that still carries two or more
bindings (a hand-edit, an older `sets.yaml`, a config restored from a `.bak-*`) keeps
choosing at play time. Silently playing as `profiles[0]` would be the 2026-08-16
curated-queue bug again — playing under an account nobody named.

Two related defects fall out and are fixed in the same change:

- The row's selected tier was `useState` seeded ONCE while the options are re-derived from
  the registry every render. Another tab deleting a binding left this row holding a value
  that no longer existed, so it would have **played as an account the pool no longer has**.
  The value is now validated against the current options and falls back to the saved
  default.
- Whose pool a row is was previously readable ONLY off that dropdown. "Shows" and
  "Shows & Shorts" are the same words until you know one is Younger Kids and the other
  Older Kids, so removing the control without printing the account would have lost
  information, not just a widget.

## Context

The owner, 2026-08-17, with a screenshot of the four Filtered Pool rows each wearing a
profile dropdown:

> "I want Filtered Pools to be similar to Curated Pools and Ordered Queues where only 1
> account is configured each instead of multiple. If you wanna make one per account, you
> can, but those were originally created *before* we figured out how to change accounts on
> the Shield, so it messed them up. Now that we can lock them to a single account, we
> should. I made mine all single-account now, so we just need to update the UI."

Verified against the live `App-Configs/queuepilot/sets.yaml` before writing any code: every
rotation set in it — `shows_shorts`, `shows`, `shorts`, `movies` — carries exactly one entry
in `profiles[]`. The retired `younger` / `older` sets are `superseded_by: shows_shorts,movies`
and no longer render. So the UI was offering a choice the data had already stopped having.

## Why

- **A control with one option is not a choice.** It is a label wearing a chevron, and it
  costs a row of horizontal space and a tap target on every pool.
- **The multi-binding shape was a workaround for a capability we now have.** A pool had to
  carry every tier because the app could not switch the Shield's Plex profile; it can
  (`adb.ts`, and `requires_profile` waits for the right one). The dropdown outlived its
  reason.
- **The account is information, the picker was a control.** Moving it into the meta line
  keeps the fact and drops the affordance — and puts it in the same place the other two
  groups can eventually print theirs.
- **Not a schema change.** `profiles[]` stays a list; the pool editor still edits it. This
  is a rendering rule about the landing, so there is nothing to migrate and nothing to undo
  if the owner's profile/grouping design (see
  [`docs/queuepilot-profiles-groups-and-navigation-design.md`](../queuepilot-profiles-groups-and-navigation-design.md))
  lands somewhere else.

## Evidence

- Owner quote + screenshot, 2026-08-17.
- `App-Configs/queuepilot/sets.yaml` @ 2026-08-17 01:06 — four rotation sets, one binding each.
- Before/after: `__screenshots__/play-landing-before.png`, `play-landing-after.png`.
