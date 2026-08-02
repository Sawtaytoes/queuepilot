# Younger Kids gets Shows and Shorts as two cards; Older Kids keeps them combined

- **Status:** Accepted (implemented + deployed)
- **Date:** 2026-07-27
- **Type:** channel model / card model
- **Supersedes:** — (narrows the card half of
  [2026-07-23-live-tier-migration-to-function-channels](2026-07-23-live-tier-migration-to-function-channels.md);
  `shows_shorts` itself is untouched)
- **Superseded by:** —

## Decision

`shows_shorts` splits into two additional function channels, and **only the Younger Kids
cards change**:

| Channel | `sections` | `item_sections` | Bindings |
| --- | --- | --- | --- |
| `shows_shorts` (unchanged) | `[5]` | `[15]` | Younger Kids, Older Kids |
| `shows` (new) | `[5]` | `[]` | Younger Kids, Older Kids |
| `shorts` (new) | `[]` | `[15]` | Younger Kids, Older Kids |

Cards:

- `Plex: Younger Kids Shows/Shorts` (`04-13-1F-2A-22-02-89`) → renamed **`Plex: Younger Kids
  Shows`**, re-pointed to `set: shows`. The physical card is unchanged; tag_ids are immutable.
- A blank captured 2026-07-27 (`04-03-99-29-22-02-89`) → **`Plex: Younger Kids Shorts`**,
  `set: shorts`.
- `Plex: Older Kids Shows/Shorts` (`04-B3-A4-2A-22-02-89`) → **untouched**, still
  `set: shows_shorts`.

**Both new channels bind BOTH tiers even though only Younger Kids has split cards.** Older
Kids' card stays combined, but shorts-only / shows-only is playable for either kid from the
web UI and from HA's "Play on ▾" — and splitting Older Kids' card later becomes a card
rewire, not a schema change.

### Ordering matters: `shows`/`shorts` go AFTER `shows_shorts` in `sets.yaml`

`config.channel_for()` takes the **first file-order match** for a `set: "auto"` scan. Both
new channels are `behavior: progress` and bind both tiers, so all three now match
`(cartoons, <either tier>)`. Placing them after `shows_shorts` keeps the UC3 Cartoons button
(`button_command_map` — still `set: auto`) landing exactly where it does today. Verified:
`route cartoons "Younger Kids"` and `"Older Kids"` both still resolve to `shows_shorts`.

### A rotation channel may have NO show library

`shorts` carries `sections: []`. Before this, that was rejected in four places
(`server/src/sets.js` create + patch, `web/app.js` two client guards), so a Shorts-only
channel could be hand-written into `sets.yaml` but never saved from the web UI — Bob would
have hit "Pick at least one show library" on any edit, including a rename. The rule is now
the **effective union**: a rotation channel needs at least one library across
`sections` + `item_sections`. Curated queues still require a real `sections` (that is what
title search scopes).

## Context

Bob scanned a blank card and asked to split the combined channel: *"I wanna change the Plex
Channel that includes shows and shorts and only make it shorts OR shows for Younger Kids. For
Older Kids, shows and shorts is fine as one card."* A combined tap is a coin-flip between a
2-minute short and a 25-minute episode, which matters far more for the younger kid.

On bindings he initially chose Younger-only, then corrected mid-implementation: *"Actually, I
changed my mind. Yes, you can make it so, in the UI, I can make Older Kids also do shorts
only. That's useful."*

## Why

- **The split is a card question, not a tier question.** The channels are named by function
  per [2026-07-21-channels-function-first-generalized-members](2026-07-21-channels-function-first-generalized-members.md);
  which cards exist is independent of which profiles a channel can serve. Binding both tiers
  keeps that separation instead of baking "Younger only" into the data model.
- **`shows_shorts` is left alone deliberately.** Older Kids' card, the `auto` button path, and
  the existing watched-state all keep working with zero migration.

## Evidence

Read-only dry-runs against live Plex, in-container, before wiring the cards:

| Channel × binding | Result |
| --- | --- |
| `shows` × Younger Kids | 12 items — Pokémon S1E2, Richard Scarry S3E23, Curious George S2E35 … |
| `shows` × Older Kids | 12 items — Batman Beyond S1E1, Darkwing Duck S1E3 … |
| `shorts` × Younger Kids | 12 items — Yankee Doodle Bugs, Casanova Cat … |
| `shorts` × Older Kids | 6 items — Sintel, The Tell-Tale Heart … |

`route cartoons "<tier>"` → `shows_shorts` for both tiers (auto path unchanged). Web API
after redeploy confirms all three channels with the right sections/bindings. `e2e/run.sh`
green (7 suites); `e2e/api-v2-test.mjs` gained 7 assertions pinning the shorts-only rule,
including that emptying *both* library lists is still rejected and that curated queues still
require `sections`.

## Known, pre-existing, NOT fixed here

The rotation path does not apply `plex._keep_episode`, so **Season 0 specials still lead
shows** — `shows_shorts × Older Kids` opens on `The Transformers S0E3`, and `shows × Older
Kids` on `Tron: Uprising S0E1`. This contradicts
[2026-07-17-anime-series-never-open-on-specials-exclude-season-0](2026-07-17-anime-series-never-open-on-specials-exclude-season-0.md).
It predates this change and affects the combined card identically; recorded here so it is not
mistaken for a regression of the split.
