# The two kid Shows cards play curated queues, not rotation channels

- **Status:** Accepted (live — HA `tag_command_map` re-pointed, verified against the running
  automation)
- **Date:** 2026-08-17
- **Type:** card model / channel model
- **Supersedes:** the **card half** of
  [2026-07-27-younger-kids-shows-and-shorts-are-two-cards](2026-07-27-younger-kids-shows-and-shorts-are-two-cards.md)
  — that record's channel split stands, and `shorts` is untouched; only which set cards 1 and
  10 name changes here.
- **Superseded by:** —

## Decision

The two **Shows** cards move off their `source: rotation` function channels and onto
`source: queue` curated queues the owner hand-picked:

| Card | tag_id | Was | Now |
| --- | --- | --- | --- |
| 1 · `Plex: Older Kids Shows/Shorts` | `04-B3-A4-2A-22-02-89` | `shows_shorts` (rotation) | **`older_kids_shorts_shows`** (queue, `requires_profile: Older Kids`) |
| 10 · `Plex: Younger Kids Shows` | `04-13-1F-2A-22-02-89` | `shows` (rotation) | **`younger_kids_shows`** (queue, `requires_profile: Younger Kids`) |

The change is **one map value per card** in HA's `automation.plex_nfc_scanner`
`tag_command_map`. Nothing in this repo changed: both queues were created and populated
through the web UI, and the scan path already supports a profile-gated curated queue.

**Cards 2, 11 and 12 were deliberately not touched** — `Plex: Older Kids Movies` and
`Plex: Younger Kids Movies` still name `movies`, and `Plex: Younger Kids Shorts` still names
`shorts`. Only the two Shows cards were named.

### Each card keeps `kind: cartoons`

`kind` is *not* re-pointed to match the new sets (`kind: anime`, which is what the pool editor
writes for any curated queue that is not `movies` — see `sets.ts`'s
`kind === 'anime' ? 'anime' : 'movies'`). Three reasons it does not matter and one why leaving
it alone is better:

- For `cfg.source === 'queue'`, `providers/plex.ts`'s `buckets()` never reads `kind` — the
  entry list decides what plays.
- `kind` steers `routing.channelFor()`, and that runs only on a `set: "auto"` scan. These are
  explicit-set cards.
- HA's `script.control_plex` reads `kind` only for the per-kind AVR volume, and that rule
  applies to Bob's own sets and explicitly leaves the kids' cards alone.

Leaving it at `cartoons` keeps the card's declared kind describing *what the kid is asking
for*, which is what the logbook line and the card name say, rather than an implementation
detail of how the pool editor spells curated queues.

### The profile gate still holds, from the other field

The per-tier cards exist so a card can never play the right show billed to the wrong kid. A
rotation channel enforced that through its `profiles[]` binding; a curated queue has no
binding and enforces it through **`requires_profile`** instead. `session.ts` gates on
`cfg.requires_profile` first and errors on a card/set profile mismatch, and
`2026-08-16-a-curated-queue-plays-as-the-profile-it-is-gated-to` is what makes the *lineup*
(not just the gate) resolve as that profile. So the guarantee is unchanged — it is carried by
a different field.

## Context

The owner curated the two queues in the web UI, then named them:

> "The `shows_shorts` channel for Older Kids Shows & Shorts should now be
> `https://queuepilot.example.com/q/older_kids_shorts_shows` instead. That's the new one."

> "And the new Younger Kids Shows is `https://queuepilot.example.com/q/younger_kids_shows`"

Both queues were already populated when the cards were re-pointed — `older_kids_shorts_shows`
with 13 entries (DuckTales, Darkwing Duck, Beast Wars, the LEGO Movie Shorts and Batman: TAS
collections …), `younger_kids_shows` with Team Umizoomi, Mister Rogers, Daniel Tiger, Richard
Scarry, Curious George and friends.

## Why

- **A curated list is the answer to "what should be on"** for these two cards. The rotation
  channels picked from a whole library by rating, which is the right shape when nobody has
  said what belongs; once the owner has said, the filter is a worse approximation of his
  answer than his answer is.
- **The card is the cheap end to change.** `tag_id`s are immutable and the physical cards are
  already labelled "Shows"/"Shows & Shorts" — both still true of the new sets, so re-pointing
  the map needs no relabelling, no re-capture, and no schema migration.

## Known / not done here

- **`shows_shorts` is left in place and enabled, on purpose.** It is now unreferenced by any
  card, but it is still the **`set: "auto"` target for Older Kids** — `channelFor()` only ever
  considers `source: rotation` sets, so a curated queue can never be an auto target and
  deleting `shows_shorts` would drop the UC3 **Cartoons** button for Older Kids through to
  `PROFILE_SET_MAP`. `shows` is likewise still Younger Kids' auto target. Retiring either one
  is a separate decision that has to answer the auto button first.
- **A live scan has not been done.** The map value is verified by reading the automation back;
  nobody has tapped card 1 or card 10 on the reader since.
