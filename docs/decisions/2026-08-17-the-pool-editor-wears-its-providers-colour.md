# The pool editor wears its provider's colour like every other view

- **Status:** Accepted
- **Date:** 2026-08-17
- **Type:** bug / ui
- **Supersedes:** —
- **Superseded by:** —
- **Extends:** [2026-08-15-a-queue-wears-its-providers-colour](2026-08-15-a-queue-wears-its-providers-colour.md)

## Decision

**`ChannelsView`'s `<main>` carries `data-provider`, like `QueueView`, `QueuesView` and each
`PlayView` row already do.** A Plex pool's editor is Plex amber; a pull pool's is its own
provider's colour.

## Context

The owner, 2026-08-17, on `/channels/movies`:

> "Looks like we switched to Purple here instead of Plex Yellow when I'm in a Plex pool. If
> I switch to a Kavita one, then change the button to Kavita green if it's possible to swap
> the theme like that. […] oh, it looks like you already do! Then why Purple here for Plex?"

He is reading the screens correctly and in the right order. The colour rule shipped
2026-08-15 and was applied at three call sites — the queue grid, the Queues shelf and the
Play landing's rows. `ChannelsView` was the fourth view and was missed, so it fell through
to the app's own Charcuterie indigo. One page said Plex; the page one click away said
nothing in particular.

## Why

- **Violet is not a neutral here, it is a CLAIM.** The 2026-08-15 decision made the app's
  own accent Charcuterie's indigo precisely so that a provider colour means "this belongs to
  that service". A Plex screen wearing the app accent reads as "belongs to no provider",
  which is false.
- **Keyed on `provider_kind`, not the id** — same rule as everywhere else, so a second
  Kavita added from the connector surface still comes out green.
- **The empty branch stays bare.** `ChannelsView` renders an empty `<main>` when no pool is
  selected; there is no provider to name, so there is no attribute.

## Evidence

- Owner quotes + screenshots (`/channels/movies`, `/q/bob_anime`, `/q/manga_webtoons`), 2026-08-17.
- Before/after: `__screenshots__/pool-editor-before.png`, `pool-editor-after.png`.
