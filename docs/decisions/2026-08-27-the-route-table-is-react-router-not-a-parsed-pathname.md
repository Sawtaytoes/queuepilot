# The route table is react-router, not a parsed pathname

**Status:** Accepted
**Date:** 2026-08-27
**Type:** Architecture / frontend
**Supersedes:** the "what is left of the hand-rolled router" half of
[2026-08-16 — routing is real paths, not `#/…`](2026-08-16-routing-is-paths-not-hashes.md)
(that record's paths, its `hasSpaFallback` clause and its anchor rule all stand; what is no
longer true is that a regex chain decides the view)
**Superseded by:** —

## Decision

QueuePilot renders a react-router **`<Routes>` table**. One `<Route>` per address, in
`web/src/App.tsx`, under one pathless layout route.

1. **`parsePath()` is deleted.** A pathname is matched by react-router, not by a chain of
   `match()` calls and `startsWith()` tests. `web/src/state/parsePath.ts` and the `Route`
   union it exported are gone.
2. **The paths are constants** in `web/src/lib/routePaths.ts`. The table renders those
   constants, and `web/src/lib/routePaths.test.ts` runs react-router's own `matchRoutes` over
   the same constants — so the pure test and the app cannot disagree.
3. **A view mounts only on its own route.** Every view used to be mounted at all times and
   toggle the `hidden` attribute. Nine `<main>` elements were in the DOM on every page; there
   is one now.
4. **Each page states its own chrome.** `components/Page.tsx` takes the heading, sub-line,
   back target, document title and body classes as props, and renders `Header` +
   `NowPlayingBar` above the view. `computeChrome()` is gone.
5. **A moved address still paints its page, then rewrites the URL.** `/g/<id>`, `/collection`
   and `/tonight` each get a legacy `<Route>` that renders the page they moved to and
   `navigate(..., {replace: true})`s underneath.

## Context

The fleet rule is `2026-08-16-owned-web-apps-use-react-router-with-path-urls` in the `agentic`
root repo, and its second clause is explicit: *"Render a `<BrowserRouter>` with a `<Routes>`
table. Even a single-view app gets one, so the next view is a route rather than a `useState`
fork."*

QueuePilot took the first clause and not the second. Since 2026-08-16 it has had a real
`<BrowserRouter>`, real `<Link>`s, real paths and the Charcuterie router seam
(`RouterLinkProvider link={ReactRouterLink}`) — and then handed `useLocation().pathname` to a
hand-written parser, which returned a tagged union, which drove nine `hidden` attributes. The
router owned the history; the app still owned the matching.

That was defensible when the parser answered four routes. It answers **nine** now — `/admin`,
`/queues`, `/q/<id>`, `/channels[/<id>]`, `/pending`, `/board-game-collection`, `/result[/<id>]`,
`/what-to-watch-play[/<step>]` and `/` — plus three legacy addresses, and the file had grown a
`// Longest first:` comment because nothing but the reading order kept the bare
`/what-to-watch-play` route from swallowing its own two steps. That comment is the shape of the
bug this decision removes: route ranking is what a router does, and doing it by reading order
fails silently in the direction that looks like it worked.

## Why

- **One matcher, not two.** The app matched with a regex chain and the fleet's other apps match
  with `<Routes>`, so nothing transferred between them, and this repo's route knowledge lived
  in a file no other app has.
- **Ranking is free and was hand-maintained.** react-router ranks `/what-to-watch-play/:step?`
  above `/what-to-watch-play`, and `/collection/*` above `*`, without a reading order to
  preserve. Trailing slashes match without a strip step; params arrive URI-decoded without a
  `decodeURIComponent` per branch.
- **The `hidden` toggle cost more than it saved.** Every page carried nine `<main>` elements,
  eight of them empty, and every view had to gate its own fetch on `isHidden` so that opening
  the landing did not read the board-game shelf, the people roster and the pending libraries.
  Fifty-seven `isHidden` references are gone; a mount effect is the same rule stated once by
  React.
- **`computeChrome()` was the hand-rolled router wearing a different hat** — a second switch
  over the same tagged union, 200 lines below the first.

## Consequences

- `web/src/state/parsePath.ts` → deleted. `labelForPath` and `WATCH_PLAY_PATH` moved to
  `web/src/lib/routePaths.ts` with the route constants; `state/route.ts` keeps only the back
  ORIGIN, which react-router still does not expose.
- `web/src/state/route.test.ts` → `web/src/lib/routePaths.test.ts`, and it now asserts through
  `matchRoutes` rather than through a function this repo wrote.
- `AppFrame`, the pathless layout route, holds what outlives a page: the store load, the live
  subscription, the selection bar and the seven lazy overlays. It is the one caller of
  `trackRouteOrigin`. The bulk-edit bar reads the open queue with `useMatch`, since it renders
  above the route that has the param.
- **An e2e suite may no longer read a page it has navigated away from.** `routing-test.ts`
  asserted `#goqueues` was still `<a href="/queues">` *after* clicking it, which passed only
  because Admin stayed mounted; it reads the link before the click now, which is also the
  honest order. That was the one gate this change broke, and it broke loudly.
- The `#id:not([hidden])` selectors seventeen browser suites use are unaffected: an element
  with no `hidden` attribute matches `:not([hidden])`.
- Local state no longer survives leaving a page — the queue page's filter row, the pending
  page's selection. Nothing depended on it; `homeScroll` is module state and still restores,
  and the FLIP guard (`lastPaintedSet`) wanted a fresh first paint anyway.
- A path with two unknown segments under `/what-to-watch-play` (`/what-to-watch-play/a/b`) now
  falls to the mode landing rather than the bare form. It is not an address anything produces.

## Evidence

Verified against a local server on the fixture data, 2026-08-27.

- `e2e/routing-test.ts` — **40/40 PASS**, including both legacy rewrites, the reload on a deep
  link, the `<a href>` check and browser Back.
- Every no-Plex browser gate passes: `narrow-scroll`, `drag-stability`, `lane-drag`,
  `tile-lane`, `shelf-remove`, `play-reorder`, `pool-editor-keeps-blocked`,
  `collection-reorder`, `provider-cache`, `pick-contract`, `tonight`, `tonight-preset`,
  `board-game-play`. Plus the offline gates: `priority-lane`, `skipped-items`,
  `store-backend-parity`, `people`, `tonight-routing`, `board-game-absorb`, `queue-people`,
  `roster-editor`, `board-game-transport-parity`.
- ⚠️ `tile-menu-test.ts` fails ("nothing in the pool to promote"), and **it fails the same way
  on unmodified `main`** — checked by stashing this branch, rebuilding `web/dist` and running
  it again. It is not caused by this change and it is not fixed by it.
- A fifteen-route screenshot sweep, run before and after: same heading, same document title,
  same body classes, same final pathname on every route, and 11 of the 17 PNGs are
  byte-identical (the six that differ are a spinner phase and a poster shimmer). The one line
  that changed is the count of `<main>` elements — nine on every page before, one after.

> "Render a `<BrowserRouter>` with a `<Routes>` table. Even a single-view app gets one, so the
> next view is a route rather than a `useState` fork."
> (fleet decision `2026-08-16-owned-web-apps-use-react-router-with-path-urls`, clause 2)
