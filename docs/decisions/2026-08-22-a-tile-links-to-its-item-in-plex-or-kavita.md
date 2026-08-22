# A tile links to its item in Plex or Kavita, and the TITLE is the link

- **Status:** Accepted
- **Date:** 2026-08-22
- **Type:** UI / wire shape
- **Supersedes:** —
- **Superseded by:** —

## Decision

Every resolved tile carries a **`webUrl`**, and the tile's **title** is an anchor to it.

Three parts, each of them a choice the owner made from a rendered comparison:

1. **The title is the link.** Not a chip in the badge row, not a corner button over the
   artwork, not a right-click-only menu item. The tile already carries a ✓, a ✕, a ▶, a
   Collection chip, an edition chip and an Edit chip; a seventh control has nowhere to go.
   The title is text that is already there.
2. **The link addresses the SHOW or the FILM**, never the next episode. A collection links
   to the collection.
3. **The URL is built on the server**, per tile, and the frontend renders whatever it is
   given. Plex builds an `app.plex.tv` details URL. A **pull provider does not**: its tile
   carries a same-origin path, `/api/providers/<id>/open/<itemId>`, and that route resolves
   the address and answers **302** at click time. A provider that cannot address the item
   sends `null` and the title stays plain text.

   The redirect is not ceremony. Kavita's base URL is credential-adjacent — its image
   endpoint takes the API key as a query parameter, which is why covers are proxied at all —
   and `e2e/kavita-covers-test.ts` asserts that no Kavita URL reaches the browser in a
   response body. It caught the first draft of this change, which put the series URL straight
   on the tile. One 302 at the moment of navigation is the same trade `/go/<set>` already
   makes for the reader link.

`app.plex.tv` rather than `PLEX_URL/web`: the server URL answers on the LAN and through the
reverse proxy, and this gets opened from phones and tablets on networks where neither is
reachable. `app.plex.tv` resolves the server by `machineIdentifier`, so one URL works from
anywhere the account is signed in. That URL is a `#!` hash address — **Plex's shape, not
ours**. The "owned web apps route with paths, never `#/`" rule
(`agentic:docs/decisions/2026-08-16-owned-web-apps-use-react-router-with-path-urls.md`) binds
the apps we write; quoting an external client's address is not routing.

## Context

The owner, looking at a queue grid:

> *"In QueuePilot, some other things I'd like to see from this page are the ability to go
> to the Plex page with that item… Kavita should link too!"*

Asked where the link should sit, he asked to see it rather than to decide from a
description — four layouts were rendered with the real stylesheet and real library data
(the `docs/previews/` HTML), and he answered **1D** (the title) and **2A** (the show, not
the episode).

## Why

**The title, and not a chip.** The badge row is where every per-entry fact already lives,
and on a collection tile it holds two chips before this change. The owner's objection to
adding controls to a tile was about space, and the title is the one element that is on
every tile, is already the item's name, and needs no new pixels.

**The show, and not the episode.** The next-up line names the episode, and that line is
already a control: tapping it opens the start-episode picker
(`2026-07-31-start-episode-is-picked-in-a-modal`). A second meaning on the same words is a
second thing to explain, and a link on a control is a click that does two different things
depending on where it lands.

**Server-built, and not derived in the browser.** Two providers, two URL shapes, and Kavita's
needs a `libraryId` the frontend never sees — and must not see, per the leak gate above.
Deriving it in the browser would put a provider's URL grammar in the view layer and would need a second mechanism the day a third provider
gains a web UI. One nullable string per tile is the cheaper contract, and `null` — no link at
all — is the honest answer when the machine id has not been read or a series has no library.

## Evidence

- Owner, on the queue grid (2026-08-21 chat): the request above.
- Owner, choosing from the rendered options (2026-08-22): *"1D, 2A"*.
- `nextEp.duration` was already on the wire, which is what made the sibling runtime change
  (`2026-08-22-a-tile-names-the-runtime-on-its-own-line`) a display-only change; this one
  needed a new field because no URL was ever computed.
