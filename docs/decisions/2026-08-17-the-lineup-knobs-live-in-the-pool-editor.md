# The lineup knobs live in the pool editor, and a value equal to the default is stored by absence

- **Status:** Accepted
- **Date:** 2026-08-17
- **Type:** ui / storage
- **Supersedes:** —
- **Superseded by:** —
- **Extends:** [a lineup refills instead of ending](2026-08-17-a-lineup-refills-instead-of-ending.md), [an entry count picker follows the set default](2026-08-16-entry-count-follows-the-set-default.md)

## Decision

`length`, `refill` and `on_complete` get a **Lineup** box in the pool
editor (⚙ Configure on a filtered pool), the surface that already owns
every other rule-based knob. Not the inline Pool-filters panel: that
panel is the per-profile binding's data, and these three are the
channel's.

Three rules fall out of putting them there:

1. **Equal to the default is stored by ABSENCE.** The editor posts every
   knob it renders on every Save, so a `length` that just repeats env
   `ROTATION_LENGTH`, a `refill: false` and an `on_complete: drop` are
   dropped from the file. Same sparse rule the entry counts already use.
   Enforced server-side (`toLineupLength` / `toOnComplete` in `sets.ts`)
   rather than in the editor, so a hand-`PATCH` and a Save agree.

2. **The defaults ride along with the registry.** `GET /api/sets` now
   sends `lineup: { length, max, topup_at }` from env. The picker's
   **Default** chip, its ceiling and the hint's "tops up at 3" all read
   that, never a constant in the bundle.

3. **A rewatch pool does not get the box.** `behavior: rewatch` returns
   exactly one film per scan and honours neither `length` nor `refill`,
   so every control would be a knob that does nothing. Hidden, with a
   note in its place — the same call `batch_stops_at` gets on a queue
   with no Plex source, and for the same reason.

`CountPicker` grew a `presets` prop. The lineup counts whole items in one
sitting, where the entry picker's 1 / 2 are not answers anyone would
pick; a lineup offers **12 / 24 / 60 / Custom…**, with whatever
`ROTATION_LENGTH` actually is folded in so it can wear the chip.

## Context

Shipped 2026-08-17 in [#118](https://github.com/Sawtaytoes/queuepilot/pull/118)
with "**No UI control**" listed under *Still open* in
`docs/todos/lineup-length-and-top-up.md`. The owner, the same day:

> "Ok, add the UI controls too then."

Until this, the live Younger Kids — Shorts card was `length: 12, refill:
true, on_complete: restart` and the pool editor showed none of it. The
answer to "why did the kids' card stop mid-evening" lived in a file the
owner never opens.

## Why

- **A knob nobody can see is a knob nobody owns.** Two of the three
  changed the live behaviour of a card on the wall, and the only way to
  read the current setting was to open `sets.yaml` over SMB.
- **Sparse storage is what makes the editor safe to open.** Without rule
  1, renaming a pool would stamp three keys that say nothing onto it —
  and pin its length at 12 rather than leaving it following the env.
- **Hardcoding 12 / 200 / 3 in the bundle splits the brain.** A
  deployment that moves `ROTATION_LENGTH` would get an editor chipping
  the wrong option Default and accepting a number the writer clamps
  behind the user's back.
- **A rewatch pool would be lied to.** The rewatch branch is still
  untouched (it is the remaining *Still open* item); showing it a
  refill checkbox that does nothing is worse than showing it nothing.

## Consequences

- `createSet` handles all three for the first time. It did not before,
  so a pool created from the editor with top-up on came back with it
  off — silently, with the file as the only clue.
- `on_complete` is **rejected** on a typo by both the create and the
  patch path, and **tolerated** on read: the writer must not let
  "restart-at-1" quietly mean drop, and the reader must not let a
  hand-edited typo take a card off the wall.
- Gate: `e2e/lineup-knobs-test.ts` (offline) pins the sparse rules, the
  clamp, the create path and the reject/tolerate split. In CI.

## Evidence

- Owner quote above, 2026-08-17.
- Before/after on the PR: the same pool, `refill: true` and `length: 60`
  on disk, with and without anything on screen that says so.
- Driven end to end against the running app: Save writes
  `length: 24 / refill: true / on_complete: restart`, a re-open prefills
  all three, and switching them back to the defaults removes the keys
  while leaving the sibling pool untouched.
