/**
 * The pure half of the router: pathname in, route out.
 *
 *   `/`                       MODE LANDING — choose Admin or What to Watch/Play
 *   `/admin`                  ADMIN — every queue and pool, filtered by `?people=` / `?only=`
 *   `/what-to-watch-play`     WHAT TO WATCH/PLAY — who's here, an activity, and Go
 *   `/what-to-watch-play/surprise`  WHAT TO WATCH/PLAY, on Surprise Me's narrowing step
 *   `/what-to-watch-play/go?…`  WHAT TO WATCH/PLAY with the answers baked in
 *   `/result`                 RESULT — the pick: one card, reroll, confirm
 *   `/result/<gameId>`        RESULT for one named game — a queue arrival, and it has NO reroll
 *   `/board-game-collection`  COLLECTION — the board-game shelf, and "we played this"
 *   `/queues`                 QUEUES configurator (poster shelves)
 *   `/q/<id>`                 one curated queue / channel as a grid
 *   `/channels[/<id>]`        the rule-based rotation channels
 *
 * `/what-to-watch-play/surprise` is a STEP of the What to Watch/Play view, not a view of its own — Surprise Me
 * opens a second screen where you narrow down before anything is chosen, and the who's-here
 * answer above it is still the same answer. It carries a path anyway because it is a place
 * you can be, and a place you can be is a URL you can reload and share.
 *
 * `/what-to-watch-play/go` is the same kind of thing pointed the other way: not a place you sit but an
 * ADDRESS A CARD CARRIES. The query string holds the answers the form would have collected —
 * who is here, the activity, the filters — so the tap draws and lands on `/result` instead of
 * opening a form and asking again (absorb decision §5: *"Pick-preset NFC → land on result
 * card, not an empty form"*). The grammar and the rule that a card which names NOBODY is
 * refused are both in `lib/tonightPreset.ts`. It parses to a STEP for the same reason
 * `surprise` does: the view is What to Watch/Play either way, and a refused preset has to land on that
 * form with what the card did say already filled in.
 *
 * `/g/<group>` is GONE as of 2026-08-26 and redirects to `/admin`. It was the management
 * page with a GROUP filter applied; that page filters by PEOPLE now — a multi-select in the
 * query string rather than a single group in the path
 * (decision `2026-08-26-the-landing-filters-by-people-and-the-group-chips-go`). A group is
 * still a real object with a real editor; it is no longer an address. A redirect rather than
 * a 404 because `/g/<id>` was bookmarkable for nine days and that was half the point of it,
 * so an old bookmark has to land on a page rather than on an error.
 *
 * `/board-game-collection` and NOT `/collection`, since 2026-08-25. The shelf is one KIND of
 * collection, and the generic word is already Plex's in this app — `type: "collection"` is a
 * row of films, in `tiles.ts`, `plex.ts`, `sets.ts` and thirty other places. A Steam library
 * or a Kavita shelf would want the same generic path, so the specific one is named for what
 * it holds: *"There may be others like Steam in the future."* `/collection` shipped earlier
 * the SAME day, so it still parses to this view — an old link paints the shelf rather than
 * the landing, and `canonicalPath()` rewrites the address under it
 * ([decision](../../../docs/decisions/2026-08-25-the-board-game-shelf-is-board-game-collection.md)).
 *
 * These were `#/…` until 2026-08-16. They are real paths now, so the server has to
 * answer them — `createStaticHandler` runs with `hasSpaFallback: true`, and the two
 * facts move together or a reload on `/queues` 404s
 * ([decision](../../../docs/decisions/2026-08-16-routing-is-paths-not-hashes.md)).
 *
 * Split from `route.ts` because that module pulls in react-router hooks; nothing in
 * here touches the DOM or React, so a Node-environment test can call it directly.
 */

export type Route =
  | { view: "home" }
  // ADMIN is the page `play` used to be. There is no `play` route any more: it existed only
  // to carry a group id, and a group is not an address (see the `/g/<group>` note above).
  | { view: "admin" }
  | { view: "boardGameCollection" }
  | { view: "result"; gameId: string | null }
  | {
      view: "tonight"
      step: "go" | "surprise" | null
    }
  | { view: "queues" }
  | { view: "pending" }
  | { view: "queue"; id: string }
  | { view: "channels"; id: string | null }

export const WATCH_PLAY_PATH = "/what-to-watch-play"

// `/queues/` and `/queues` are one page. A path router makes trailing slashes
// reachable in a way `location.hash` never did (a link, a proxy rewrite, or a
// user typing one), and an unhandled `/queues/` would silently fall through to
// the PLAY fallback in `parsePath`. Shared with `canonicalPath` so a legacy path
// with a trailing slash is redirected as readily as it is parsed.
function stripTrailingSlash(pathname: string): string {
  return pathname.length > 1
    ? pathname.replace(/\/+$/, "")
    : pathname
}

/**
 * A path that MOVED, mapped to where it lives now. One entry today; a second is one line.
 *
 * Kept as data rather than an `if` in `canonicalPath` because the old path has to appear in
 * exactly two places — here, and in the `parsePath` branch that still renders it — and a
 * reader has to be able to find both.
 */
const MOVED_PATHS = [
  ["/collection", "/board-game-collection"],
  ["/tonight", WATCH_PLAY_PATH],
] as const

/**
 * `/g` and `/g/<anything>` — a group page, which no longer exists.
 *
 * It cannot be a `MOVED_PATHS` entry because that mapping keeps the TAIL
 * (`/collection/x` → `/board-game-collection/x`) and this one deliberately drops it: there
 * is no per-group address to move a group id to. The people filter is not a translation of
 * a group — a group is a saved set of people, and picking the same people by hand is a
 * different assertion — so guessing one would be worse than landing on everything.
 */
const GROUP_PATH = /^\/g(\/.*)?$/

/**
 * Where a legacy path should be REWRITTEN to, or `null` when it is already canonical.
 *
 * Pure, like the rest of this module: the caller owns the `navigate(…, {replace: true})`.
 * A redirect rather than a 404 because both `/collection` and `/tonight` were live addresses
 * and a link to either one may already be in a chat window.
 */
export function canonicalPath(
  pathname: string,
): string | null {
  const path = stripTrailingSlash(pathname)

  for (const [from, to] of MOVED_PATHS)
    if (path === from || path.startsWith(`${from}/`))
      return to + path.slice(from.length)

  if (GROUP_PATH.test(path)) return "/admin"

  return null
}

export function parsePath(pathname: string): Route {
  const path = stripTrailingSlash(pathname)

  if (path === "/") return { view: "home" }

  if (path === "/admin") return { view: "admin" }

  // A retired group page renders ADMIN while `canonicalPath` swaps the address underneath —
  // the same shape `/collection` uses. Drop this branch and an old bookmark falls through to
  // the catch-all, which is the MODE landing rather than the page it used to be, so the
  // redirect would flash a screen nobody asked for.
  if (GROUP_PATH.test(path)) return { view: "admin" }

  const q = path.match(/^\/q\/(.+)$/)

  if (q?.[1])
    return { id: decodeURIComponent(q[1]), view: "queue" }

  const c = path.match(/^\/channels(?:\/(.+))?$/)

  if (c)
    return {
      id: c[1] ? decodeURIComponent(c[1]) : null,
      view: "channels",
    }

  // `/result/<gameId>` is a QUEUE ARRIVAL and `/result` is the pick form's result. They are
  // one view with one card; the difference is that the queue already chose, so the first
  // has no reroll. Matched before the bare `/result` for the same reason
  // the Surprise Me step is matched before the bare What to Watch/Play route.
  const r = path.match(/^\/result\/(.+)$/)

  if (r?.[1])
    return {
      gameId: decodeURIComponent(r[1]),
      view: "result",
    }
  if (path === "/result")
    return { gameId: null, view: "result" }

  // The legacy `/collection` is matched here too, deliberately. It is what makes an old
  // link paint the SHELF while `canonicalPath` swaps the address underneath — drop it and
  // the same link falls through to the landing, which reads as a broken bookmark. It is
  // matched EXACTLY, on the same rule `canonicalPath` rewrites by, so no path renders the
  // shelf without also being redirected off the old name.
  if (
    path.startsWith("/board-game-collection") ||
    path === "/collection" ||
    path.startsWith("/collection/")
  )
    return { view: "boardGameCollection" }

  // Longest first: neither step may be swallowed by the bare What to Watch/Play route.
  if (
    path === `${WATCH_PLAY_PATH}/surprise` ||
    path === "/tonight/surprise"
  )
    return { step: "surprise", view: "tonight" }
  if (
    path === `${WATCH_PLAY_PATH}/go` ||
    path === "/tonight/go"
  )
    return { step: "go", view: "tonight" }
  if (
    path === WATCH_PLAY_PATH ||
    path.startsWith(`${WATCH_PLAY_PATH}/`) ||
    path === "/tonight" ||
    path.startsWith("/tonight/")
  )
    return { step: null, view: "tonight" }

  if (path.startsWith("/queues")) return { view: "queues" }
  if (path.startsWith("/pending"))
    return { view: "pending" }

  // An unknown path lands on the landing rather than a blank page. With a SPA
  // fallback the server hands index.html to ANY extensionless path, so this is now
  // the only thing standing between a typo'd URL and an empty shell.
  return { view: "home" }
}

/** What the back button should SAY, given where it goes. */
export function labelForPath(p: string): string {
  if (
    p.startsWith(WATCH_PLAY_PATH) ||
    p === "/tonight" ||
    p.startsWith("/tonight/")
  )
    return "‹ What to Watch/Play"
  if (
    p.startsWith("/board-game-collection") ||
    p.startsWith("/collection")
  )
    return "‹ Collection"
  if (p.startsWith("/result")) return "‹ What to Watch/Play"
  if (p.startsWith("/queues")) return "‹ Picks"
  if (p.startsWith("/channels")) return "‹ Rules"
  if (p.startsWith("/q/")) return "‹ Back"
  if (p === "/admin" || p.startsWith("/admin/"))
    return "‹ Admin"
  if (p === "/") return "‹ QueuePilot"

  return "‹ QueuePilot"
}
