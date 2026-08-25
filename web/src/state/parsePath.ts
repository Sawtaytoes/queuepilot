/**
 * The pure half of the router: pathname in, route out.
 *
 *   `/`                       PLAY (landing) — every group's sets
 *   `/g/<group>`              PLAY, filtered to one QueuePilot group
 *   `/tonight`                TONIGHT — who's here, an activity, and Go
 *   `/tonight/surprise`       TONIGHT, on Surprise Me's narrowing step
 *   `/tonight/go?…`           TONIGHT with the answers baked in — a PRESET CARD's address
 *   `/result`                 RESULT — tonight's pick: one card, reroll, confirm
 *   `/result/<gameId>`        RESULT for one named game — a queue arrival, and it has NO reroll
 *   `/board-game-collection`  COLLECTION — the board-game shelf, and "we played this"
 *   `/queues`                 QUEUES configurator (poster shelves)
 *   `/q/<id>`                 one curated queue / channel as a grid
 *   `/channels[/<id>]`        the rule-based rotation channels
 *
 * `/tonight/surprise` is a STEP of the Tonight view, not a view of its own — Surprise Me
 * opens a second screen where you narrow down before anything is chosen, and the who's-here
 * answer above it is still the same answer. It carries a path anyway because it is a place
 * you can be, and a place you can be is a URL you can reload and share.
 *
 * `/tonight/go` is the same kind of thing pointed the other way: not a place you sit but an
 * ADDRESS A CARD CARRIES. The query string holds the answers the form would have collected —
 * who is here, the activity, the filters — so the tap draws and lands on `/result` instead of
 * opening a form and asking again (absorb decision §5: *"Pick-preset NFC → land on result
 * card, not an empty form"*). The grammar and the rule that a card which names NOBODY is
 * refused are both in `lib/tonightPreset.ts`. It parses to a STEP for the same reason
 * `surprise` does: the view is Tonight either way, and a refused preset has to land on that
 * form with what the card did say already filled in.
 *
 * `/g/<group>` is the same VIEW as `/`, not a new one — it is the landing with a filter
 * applied, which is why it parses to `{view: "play"}` carrying a group rather than to a
 * view of its own. Every other route is group-agnostic on purpose: a queue has ONE
 * canonical address (`/q/<id>`) even when it belongs to three groups.
 *
 * `/g/` and not `/p/`: PROFILE is Plex's word in this app (`/api/profiles` is the Home
 * profile list, and the pool editor's second picker is labelled Profile), so the
 * household concept is a GROUP — see `server/src/groups.ts`.
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
  | { view: "play"; group: string | null }
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
] as const

/**
 * Where a legacy path should be REWRITTEN to, or `null` when it is already canonical.
 *
 * Pure, like the rest of this module: the caller owns the `navigate(…, {replace: true})`.
 * A redirect rather than a 404 because `/collection` was live for a few hours on
 * 2026-08-25 and a link to it may already be in a chat window.
 */
export function canonicalPath(
  pathname: string,
): string | null {
  const path = stripTrailingSlash(pathname)

  for (const [from, to] of MOVED_PATHS)
    if (path === from || path.startsWith(`${from}/`))
      return to + path.slice(from.length)

  return null
}

export function parsePath(pathname: string): Route {
  const path = stripTrailingSlash(pathname)

  const g = path.match(/^\/g\/(.+)$/)

  if (g?.[1])
    return {
      group: decodeURIComponent(g[1]),
      view: "play",
    }

  const q = path.match(/^\/q\/(.+)$/)

  if (q?.[1])
    return { id: decodeURIComponent(q[1]), view: "queue" }

  const c = path.match(/^\/channels(?:\/(.+))?$/)

  if (c)
    return {
      id: c[1] ? decodeURIComponent(c[1]) : null,
      view: "channels",
    }

  // `/result/<gameId>` is a QUEUE ARRIVAL and `/result` is tonight's own pick. They are
  // one view with one card; the difference is that the queue already chose, so the first
  // has no reroll. Matched before the bare `/result` for the same reason
  // `/tonight/surprise` is matched before `/tonight`.
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

  // Longest first: neither step may be swallowed by the bare `/tonight`.
  if (path === "/tonight/surprise")
    return { step: "surprise", view: "tonight" }
  if (path === "/tonight/go")
    return { step: "go", view: "tonight" }
  if (path.startsWith("/tonight"))
    return { step: null, view: "tonight" }

  if (path.startsWith("/queues")) return { view: "queues" }
  if (path.startsWith("/pending"))
    return { view: "pending" }

  // An unknown path lands on the landing rather than a blank page. With a SPA
  // fallback the server hands index.html to ANY extensionless path, so this is now
  // the only thing standing between a typo'd URL and an empty shell.
  return { group: null, view: "play" }
}

/** What the back button should SAY, given where it goes. */
export function labelForPath(p: string): string {
  if (p.startsWith("/tonight")) return "‹ Tonight"
  if (
    p.startsWith("/board-game-collection") ||
    p.startsWith("/collection")
  )
    return "‹ Collection"
  if (p.startsWith("/result")) return "‹ Tonight's pick"
  if (p.startsWith("/queues")) return "‹ Picks"
  if (p.startsWith("/channels")) return "‹ Rules"
  if (p.startsWith("/q/")) return "‹ Back"

  return "‹ Play"
}
