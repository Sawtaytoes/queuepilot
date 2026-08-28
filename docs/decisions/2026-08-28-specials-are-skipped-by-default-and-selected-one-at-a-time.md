# Specials are skipped by default and selected one at a time

- **Status:** Accepted
- **Date:** 2026-08-28
- **Type:** product / playback / data model
- **Supersedes:** the exclude-all-specials rule in
  [2026-07-17](2026-07-17-anime-series-never-open-on-specials-exclude-season-0.md)
- **Superseded by:** —

## Decision

A normal show lists its regular Season-0 specials in **What plays**, after the normal seasons.
They are unticked by default. The queue stores each tick as the leaf id in the set-wide
`included_specials:` list. This is an inclusion list, not an inversion of `skipped:`: normal
episodes still play unless skipped, while a regular special does not play unless included.

The legacy `include_specials: true` switch remains readable for a hand-written set, but the UI
does not write it. A specials-only title still plays its Season-0 leaves without an inclusion,
because those leaves are the title's complete run rather than optional material. The established
index classification remains unchanged: Season-0 200–399, Plex clips and `extraType` rows are
trailers / OP-ED / extras and can never be selected.

Plex's episode rows carry no explicit “play after SxEy” field. QueuePilot uses
`originallyAvailableAt` when Plex supplies it: a selected special lands after the last normal
episode on or before that date. A selected special with no usable date follows the complete
normal run. Plex's normal episode order stays unchanged. A manual start floor applies after this
viewing order is assembled, so an earlier selected special does not jump in front of the stated
start.

The dynamic Rules pool keeps its existing episode membership. Selective inclusion applies to a
curated or explicit show member, where the app has a stable entry and a **What plays** editor.

## Context

The July rule solved a real failure by deleting the choice: Plex returns Season 0 before Season 1,
so allowing all regular specials made a normal series open on a pre-air special. It left
`include_specials` as an all-or-nothing escape hatch. Neither outcome answers “watch this OAD, but
not every trailer and not before episode 1.” The member-list editor added in August already asks
the correct per-leaf question for normal episodes but omitted the Season-0 rows.

The live library survey found 843 Season-0 rows. Plex supplied `originallyAvailableAt` on 410 of
them and supplied no separate placement field. Date placement is therefore useful when present,
and the end-of-run fallback is explicit rather than pretending the missing order is known.

## Why

- The default remains safe: adding a show cannot make it open on a special.
- The user can recover one real special without enabling every Season-0 leaf.
- A separate inclusion list preserves the sparse meaning of `skipped:` and cannot make an unseen
  special playable by omission.
- Air date uses metadata QueuePilot already receives. The fallback never front-loads an item whose
  placement is unknown.
- The Start editor keeps listing only episodes it can start from. Only **What plays** asks Plex for
  the extra selection rows.

## Evidence

Owner, chat 2026-08-28:

> “I think in QueuePilot, we removed all specials from showing up in episodes. Is it possible we
> could just have those skipped by default but able to be selectively added later? It's better
> than outright removing the option to watch specials altogether.”

> “Sometimes, there's a play order somewhere so specials play at the right time. Something to keep
> in mind because QueuePilot loses that.”

Gates: `e2e/specials-count-test.ts` covers the default exclusion, selective inclusion, extras that
remain impossible to select, date placement, undated fallback, the post-order start floor, the
Start-list / What-plays-list split and next-up. `web/src/lib/skipList.test.ts` covers preservation
of another show's included specials during a save.
