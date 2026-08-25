# The board-game shelf is `/board-game-collection`, not `/collection`

- **Status:** Accepted
- **Date:** 2026-08-25
- **Type:** Routing / naming
- **Supersedes:** — (narrows one detail of
  [A play cannot be logged without answering who played](2026-08-25-a-play-cannot-be-logged-without-answering-who-played.md),
  which shipped the shelf at `/collection` earlier the same day)
- **Superseded by:** —

## Decision

**1. The shelf's address is `/board-game-collection`.**

`/collection` is retired as a canonical path on the day it shipped.

**2. The internal view name is `boardGameCollection`, not `collection`.**

`Route` carries `{ view: "boardGameCollection" }`, and `App` tests for that.

**3. `/collection` REDIRECTS. It does not 404 and it does not fall through to the landing.**

`canonicalPath()` in `web/src/state/parsePath.ts` maps a moved path to its new address, and
`App` runs one `navigate(…, { replace: true })` on it. `parsePath()` still resolves the old
path to the same view, so the shelf paints and the address is swapped underneath it.

## Context

The owner read the URL and asked the question the URL invites:

> "`queuepilot.octen.dev/collection` should be `queuepilot.octen.dev/board-game-collection`
> right? There may be others like Steam in the future. Who knows."

The shelf shipped a few hours earlier, in WP-8 (#210), as `/collection`.

## Why

**A generic path claimed by one specific shelf is a name the next feature cannot use.** A
Steam library, a Kavita shelf and a Plex library all want the word "collection". The first
one to take it forces every later one into a worse name, and this app already has a Steam
provider client on disk.

**The word is ALREADY taken here, in the other direction.** "Collection" is Plex's word in
this codebase: `type: "collection"` is a row of films, in `plex.ts`, `tiles.ts`, `sets.ts`,
`queues.ts`, `sse.ts`, `types.ts` and thirty other places. `route.view === "collection"` sat
one line away from `item.type === "collection"` and meant something unrelated. That is why
the internal name moved with the path — renaming the URL and leaving the ambiguity in the
code would have kept the trap that made this change risky to make.

**It follows a rule the fleet already set.** A thing is named for the specific product or
process, never a generic label — `mkdocs.octen.dev`, never `docs.octen.dev`
(`agentic/docs/decisions/2026-07-16-apps-get-product-name-subdomains.md`). A path is the same
kind of name as a subdomain.

**A redirect rather than a 404, because the cost is one pure function.** `/collection` was
live for a few hours, so almost nothing can be bookmarked on it — but "almost nothing" is not
nothing, and a link in a chat window costs nothing to keep working. It REPLACES the history
entry rather than pushing one: a pushed redirect makes Back land on the old path, which
redirects forward again, and the button reads as dead.

**The old path still PARSES to the shelf, deliberately.** Drop that and the redirect is still
correct, but the frame before it renders the landing — an old link would flash the wrong page
on the way to the right one, which reads as a broken bookmark.

## Evidence

- Owner, 2026-08-25, quoted above.
- The SPA fallback needed no change. `createStaticHandler({ hasSpaFallback: true })` already
  answers any unmatched extensionless path, and a hyphenated segment is still extensionless —
  but that was VERIFIED rather than assumed: `routing-test.ts` cold-GETs
  `/board-game-collection` and asserts a reload on it still renders the shelf.
- Gates. `web/src/state/route.test.ts` pins the new path, the trailing-slash form, the legacy
  path resolving to the same view, and `canonicalPath` answering `null` for every path that
  did not move. `e2e/routing-test.ts` pins the cold GET, the deep link, the reload, the
  rewrite of `/collection`, and that Back out of the redirect reaches the landing rather than
  a loop.
- Nothing that means a PLEX collection was touched. Of the 74 `/collection` matches in the
  tree, 8 were this route; the rest are Plex's `/library/collections/<rk>/children`, the
  picker's `/api/collection` privacy rule, and BoardGameGeek's own `/collection` endpoint.

## What did NOT change

- **The DOM ids.** `#collection`, `#collection-grid`, `#collection-find` and the
  `#bg-<id>-*` handles are unchanged, so every existing browser gate keeps its selectors.
  They are scoped inside one view and carry none of the ambiguity the route did.
- **The visible copy.** The heading is still "Collection", the back label is still
  "‹ Collection", and the landing's link still reads "Board game collection ›". The
  complaint was about the address.
- **Wire ids.** This is a page route. No `sets.id` moved.
