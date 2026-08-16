# `board-games` is a third provider kind, configured by URL

- **Status:** Accepted
- **Date:** 2026-08-16
- **Type:** provider seam
- **Supersedes:** —
- **Superseded by:** —
- **Related:**
  [Plays before the next game is the batch knob](2026-08-16-plays-before-the-next-game-is-the-batch-knob.md),
  [A queue wears its provider's colour](2026-08-15-a-queue-wears-its-providers-colour.md),
  [A queue draws from exactly one provider](2026-08-13-a-queue-draws-from-exactly-one-provider.md)

## Decision

**Board Game Picker is a provider kind, `board-games`.** It queues games the way this app
queues shows and chapters, through the same seam and with no new concepts:

| Seam | Plex | Kavita | Board Game Picker |
| --- | --- | --- | --- |
| member | show | series | **game** |
| unit | episode | chapter | **play** |
| progress | watch history | pages read | **the play log** |
| `materialize` | playQueue | Reading List | **a descriptor** — there is no list to build |
| `handoff` | push to a device | 302 into the reader | **302 into `/play/:gameId`** |
| delivery | push | pull | pull |

**It is configured by BASE URL, not by a token.** `KINDS_CONFIGURED_BY_URL` in
`providers/config.ts` is a NAMED exception with one member. The picker is a household LAN app
with no Authelia in front of it and it issues no credential; it demands
`Authorization: Bearer` only when its own `BOARD_GAME_PICKER_API_TOKEN` is set, and that token
is honoured here when present. **Plex and Kavita still fail loudly and by name on a missing
token** — that behaviour was bought with two production outages and is not softened.

**`materialize()` returns a descriptor and builds nothing.** Plex owns a playQueue and Kavita
owns a Reading List, so both have something to rebuild per launch. The picker owns no lineup
object, and inventing a "tonight's list" inside it would grow a second queue in the app whose
entire purpose is to not be one.

**The provider reads games and play timestamps, and nothing else.** It never calls the
picker's `/api/collection`, which carries players, groups and who was at the table. This repo
is public. The offline suite records every request the provider makes and asserts that URL is
not among them; the picker enforces the same rule from its side
([its decision](https://forgejo.example.com/sawtaytoes/board-games)).

## Context

The picker is already the Kavita of this collection: it owns the games, the play log and the
table-side card. What it had no answer for was *"we already decided what we are playing over
the next few weeks"* — the same question a reading queue answers for manga.

The seam was built for this. Adding the kind took a client, a provider, and one map entry
each in `KINDS` / `DELIVERY` / `VOCABULARY` / `implicitDefinitions()`.

## Why

- **The seam is the product.** A third backend that is not a media server at all is the
  strongest evidence the abstraction is real rather than "Plex plus a special case".
- **Least privilege on someone else's data.** The narrow read surface is enforced on both
  sides and pinned by a test, rather than trusted to whoever edits this next.
- **A URL is what "configured" means here.** Requiring a credential the backend does not
  issue would report a working provider as NOT CONFIGURED, which is the same class of lie as
  a placeholder token — just pointing the other way.

## What it exposed

Three leaks above the seam, all of which would have shipped silently:

1. `sets.ts` held its own `PULL_KINDS = new Set(['kavita'])`, a second answer to a question
   the provider registry already answers. A board-game queue came out a PUSH target: a
   "Play on <device>" button for a backend with no devices, and no provider tiles at all.
2. `EntrySettings.tsx` abbreviated the unit with `unit === "episode" ? "eps" : "ch"` — a
   binary over a map that already had three entries, which tagged a game "3 ch". The
   abbreviation is now the provider's own word (`ProviderVocabulary.unitShort`).
3. `tileFace.ts` had no branch for a unit that counts towards a known total, so a game's
   next-up line borrowed a chapter's wording.

`tiles()` also gained an optional second argument: the entry refs. A Kavita tile is a
property of the SERIES ("what is unread"), so ids were enough; a board game's tile is a
property of the ENTRY, and without its batch a three-play game drew as "Play 1 of 1".
