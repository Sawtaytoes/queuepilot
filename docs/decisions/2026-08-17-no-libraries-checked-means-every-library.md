# No libraries checked means EVERY library, on every provider

- **Status:** Accepted
- **Date:** 2026-08-17
- **Type:** ux / invariant / bug
- **Supersedes:** the "at least one library section required" gate (never its own record —
  it predates `docs/decisions/`, and lived as three server throws plus three client checks)
- **Superseded by:** —
- **Related:**
  [Kavita reading list stops at a library](2026-08-16-kavita-reading-list-stops-at-a-library.md),
  [`board-game-picker` is a third provider kind](2026-08-16-board-games-is-a-third-provider-kind.md),
  [A queue draws from exactly one provider](2026-08-13-a-queue-draws-from-exactly-one-provider.md),
  [An editor may only send a key it renders a control for](2026-08-17-an-editor-may-only-send-a-key-it-renders-a-control-for.md)

## Decision

**A library scope is OPTIONAL everywhere, and an empty checkbox group means ALL — never
none.** On every provider (Plex, Kavita, Board Game Picker), on every shape (ordered queue,
filtered pool, curated pool), and on both sides of the wire:

- The server no longer refuses a set that names no library. All three
  `at least one library section required` throws in `sets.ts` are gone, and so are the
  three client-side "Pick at least one library" gates that mirrored them.
- Every place that CONSUMES a scope widens an empty one to the full list: the Plex search
  route and `/api/ratings` to every video library, `unwatchedBuckets` to every video
  library (split by Plex's own types — `show` → `episodic_sections`, `movie` →
  `item_sections`), Kavita's `pool()` and rule-based `buckets()` to every Kavita library,
  and the picker to the whole shelf.
- **The Board Game Picker's synthetic "Collection" checkbox is deleted.** Checking nothing
  is now the way to say "the whole shelf", so a box that also meant that was a second,
  contradictory answer — and it was the actual bug (below). A `collection` id already on
  disk still means everything: it WIDENS the scope rather than being dropped.
- The editor says so, in the state it is in: *"Every Plex library — check a box to narrow
  it."* / *"Uncheck every box to search all of them."*

**Ratings are NOT libraries.** An empty allowed-ratings list stays a save error: it is a cap
of nothing, not "any rating". Only the library groups get this reading.

## Context

Reported with a screenshot of the "Ready-to-Play Games" pool, both of its boxes ticked:

> "Adding Board Game Picker to QueuePilot was nice but I wanted to make a pool of games we
> know how to play without reading instructions, and I can't seem to look them up in
> search. […] If you look at the 'libraries' I can select, I'd rather select none and let it
> search all available games, but it's forcing me to select them. Honestly, those should
> always be optional no matter Kavita/Plex/Board Games. It should allow you to select 'All'
> by checking no boxes."

> "Also, I dunno how it syncs board games, but search needs to work."

Two defects, one cause.

**1. The picker search.** Live `sets.yaml` had:

```yaml
- id: ready_to_play_games
  providers:
  - provider: board-game-picker
    libraries:
    - collection
    - Roll 'n Write
```

`collection` was a synthetic "everything" library and `search()` **dropped** it, leaving
`categories=["Roll 'n Write"]`. So ticking every box narrowed the search to one owner
category. `cubitos` has `ownerCategories: []` — verified against the live picker — as does
most of the shelf, so it was unfindable. Ticking BOTH boxes was strictly worse than ticking
one, which no UI can be expected to convey.

**2. The gate.** There was no way to express "all of it": unticking the last box failed the
save with `at least one library section required`. That validator had already been patched
once (2026-08-13) to stop rejecting Kavita-only queues over Plex's `sections` field; the
rule underneath it was the real defect.

**There is no board-game sync.** Nothing is imported or cached — QueuePilot asks the picker
over HTTP per search (`GET /api/games?q=…`), and progress is the picker's play log read on
demand. The search box was never stale; it was scoped.

## Why

- **"None" is not an answer anyone means by leaving a group empty.** Every filter in this
  app already reads absence as "no opinion" — a null rating cap, an absent `length`, an
  unset `batch`. The library group was the one place absence meant "nothing matches", and
  it read as a broken search rather than an empty filter.
- **The gate forced a lie into stored config.** With no way to say "all", the owner ticked
  every box — which on this provider is a NARROWER scope than ticking none, and on Plex
  freezes today's library list into a set that would silently ignore a library added later.
- **One rule beats a per-provider rule.** "Optional, and empty means all" is now true of
  Plex, Kavita and the picker, so nothing has to remember which backend is the exception.
- **Widening at the CONSUMER, not at save time, keeps stored config honest.** An empty
  scope is stored empty; nothing expands it into a frozen list of today's libraries. Add a
  library to Plex tomorrow and every unscoped set picks it up.

## Consequences

- A pool with nothing ticked is a real "everything" pool. On Plex that is a bigger sweep
  than any existing channel does — `unwatchedBuckets` walks every show library. Existing
  channels all name libraries, so none of them changes.
- A curated queue NEVER widens: `entries` beat `libraries` (the 93-entry reading-list bug),
  so the Kavita widening applies to the rule-based branch only, and a curated queue does
  not spend a request asking for a library list nothing reads.
- The picker's library group now holds just the owner categories — one box today
  (`Roll 'n Write`). A queue still carrying `collection` keeps working and drops the id the
  next time it is saved from the editor.
- `docs/decisions` is now the only thing standing between someone and re-adding the gate.
  It reads like a missing validation. It is not.

## Evidence

- Owner quotes above, 2026-08-17, with both screenshots (`No matches for "cubitos"`, and
  the "Libraries this queue can search & hold" group with Collection + Roll 'n Write
  ticked).
- Live picker, 2026-08-17: `GET /api/games?q=cubitos` returns Cubitos with
  `"ownerCategories":[]`; `GET /api/categories` returns `["Roll 'n Write"]`.
- Reproduced and fixed against a COPY of the live `sets.yaml` and the real picker, with the
  stored scope untouched: baseline `GET /api/search?set=ready_to_play_games&q=cubitos` →
  `{"results":[]}`, after → the Cubitos hit. Screenshots on the PR.
- Live Plex, same pair: creating a rotation channel with `sections: []` returned
  `{"error":"at least one library section required"}` on the baseline and, after, a pool of
  every show library.
- Gates: `e2e/board-game-picker-provider-test.ts` (unscoped search reaches uncategorised
  games; a stored `collection` widens; `libraries()` offers no synthetic Collection),
  `e2e/kavita-provider-test.ts` (unscoped rule-based buckets read every library; a curated
  queue never enumerates one), `e2e/kavita-only-set-test.ts` and `e2e/api-v2-test.ts` (a set
  naming no library SAVES, on create and on update).
