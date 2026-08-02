# Each binding card renders its OWN ratings, not the active profile's scoped list

- **Status:** Accepted (implemented)
- **Date:** 2026-07-29
- **Type:** Bug fix / UI
- **Supersedes:** —
- **Superseded by:** —

## Decision

In the Configure modal's per-profile bindings sub-editor, a binding card's ratings
checkboxes are seeded from the **union of the scoped `known` list and that binding's own
saved ratings**, and `scopeBindingRatings` renders any currently-checked rating as an option
even when the per-profile fetch omits it. A binding for a non-active profile therefore always
renders — and keeps checked — its own values.

## Context

Bob: opening Configure on the Movies channel (top Profile = Younger Kids) showed the
Younger binding's ratings checked but the **Older Kids binding completely blank**; switching
the top Profile to Older Kids and reopening made *both* correct. *"That's strange."*

The modal computed ONE `known` ratings list via `fetchRatings(editing)`, scoped to the
**active** binding's profile (`activeBinding` → the top Profile dropdown). Younger's Plex view
of the Movies library returns only `[G, TV-Y, …]`, so `known` omitted `PG`/`TV-PG`. Every
binding card's initial `checkboxGroup` used that shared `known` as its option universe, so the
Older card had no `PG`/`TV-PG` option to check against → nothing checked → the follow-up
`scopeBindingRatings` (which preserves only what is *currently checked in the DOM*) had an
empty set to restore, and re-rendered the Older card blank. Switching the top profile just
changed which binding got the losing scope — the symptom moved, it wasn't fixed.

Reproduced deterministically in the harness (`known = [G, TV-Y]`; Older card options
`[G, PG, TV-PG, TV-Y]`, checked `[]`), fixed, and guarded with a regression assertion that
fails on the pre-fix code.

## Why

- **A binding's ratings are its own data**, independent of whichever profile happens to be
  active in the dropdown. Scoping the option universe to one profile silently dropped the
  others' values — data loss on the very next Save (the blank card would persist as empty
  ratings).
- **The two-way union is the minimal correct rule:** seed with the binding's own values so
  the initial render checks them, and keep any checked value as an option through rescoping so
  a narrower per-profile fetch can never make it vanish.

## Evidence

- Bob, 2026-07-29 session: the quotes + two screenshots (Younger-active: Older blank;
  Older-active: both filled).
- Harness repro before/after; `e2e/verify-profile-bindings.mjs` gains a two-binding edit-load
  step asserting each card keeps its own movie ratings (Younger G-not-PG, Older PG+TV-PG); it
  FAILS on the reverted code and PASSES with the fix. Full gating suite `suites failed: 0`.

## See also

- [2026-07-23-sets-yaml-profiles-array-schema.md](2026-07-23-sets-yaml-profiles-array-schema.md)
- [2026-07-21-channels-function-first-generalized-members.md](2026-07-21-channels-function-first-generalized-members.md)
