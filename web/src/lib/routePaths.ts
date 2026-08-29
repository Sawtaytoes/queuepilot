/**
 * THE ROUTE TABLE'S PATHS, and the two rewrites that keep an old link alive.
 *
 * The table itself is `App.tsx` — a react-router `<Routes>`, which is what MATCHES a
 * pathname now. This module holds the patterns it matches WITH, so they can be pinned by a
 * pure test (`routePaths.test.ts` runs react-router's own `matchRoutes` over them) without
 * pulling nine views into a Node-environment test run.
 *
 *   `/`                             MODE LANDING — choose Admin or What to Watch/Play
 *   `/admin`                        ADMIN — every queue and pool, filtered by `?people=` / `?only=`
 *   `/what-to-watch-play`           WHAT TO WATCH/PLAY — who's here, an activity, and Go
 *   `/what-to-watch-play/surprise`  …on Surprise Me's narrowing step
 *   `/what-to-watch-play/go?…`      …with the answers baked in
 *   `/result`                       RESULT — the pick: one card, reroll, confirm
 *   `/result/<gameId>`              RESULT for one named game — a queue arrival, and it has NO reroll
 *   `/board-game-collection`        COLLECTION — the board-game shelf, and "we played this"
 *   `/picks`                        Picks configurator (poster shelves)
 *   `/people`                       roster and saved audience-group management
 *   `/q/<id>`                       one curated queue / channel as a grid
 *   `/channels[/<id>]`              the rule-based rotation channels
 *
 * `:step?` and `:channelId?` are OPTIONAL SEGMENTS, and that is the point of using a router
 * rather than a chain of `startsWith` tests: `/what-to-watch-play/surprise` is a STEP of one
 * view, not a view of its own, and react-router ranks the specific pattern above the general
 * one for us. The hand-rolled parser this replaced carried a "longest first" comment because
 * nothing but the reading order kept the bare route from swallowing its own steps.
 *
 * `/what-to-watch-play/go` is the same kind of thing pointed the other way: not a place you
 * sit but an ADDRESS A CARD CARRIES. The query string holds the answers the form would have
 * collected, so the tap draws and lands on `/result` instead of asking again. The grammar and
 * the rule that a card which names NOBODY is refused are both in `lib/tonightPreset.ts`.
 *
 * `/g/<group>` is GONE as of 2026-08-26 and redirects to `/admin`. It was the management page
 * with a GROUP filter applied; that page filters by PEOPLE now — a multi-select in the query
 * string rather than a single group in the path
 * (decision `2026-08-26-the-landing-filters-by-people-and-the-group-chips-go`). Groups remain
 * compatibility data for queue audiences, but the app has no Groups editor. A redirect rather
 * than a 404 because `/g/<id>` was bookmarkable for nine days and that was half the point of it.
 *
 * `/board-game-collection` and NOT `/collection`, since 2026-08-25. The shelf is one KIND of
 * collection, and the generic word is already Plex's in this app — `type: "collection"` is a
 * row of films, in `tiles.ts`, `plex.ts`, `sets.ts` and thirty other places
 * ([decision](../../../docs/decisions/2026-08-25-the-board-game-shelf-is-board-game-collection.md)).
 *
 * These were `#/…` until 2026-08-16. They are real paths, so the server has to answer them —
 * `createStaticHandler` runs with `hasSpaFallback: true`, and the two facts move together or a
 * reload on `/picks` 404s
 * ([decision](../../../docs/decisions/2026-08-16-routing-is-paths-not-hashes.md)).
 */

export const WATCH_PLAY_PATH = "/what-to-watch-play"

export const BOARD_GAME_COLLECTION_PATH =
  "/board-game-collection"

/**
 * A trailing `/*` where the old parser said `startsWith`, so `/picks/anything` still opens
 * the configurator rather than falling through to the landing. A splat also matches the bare
 * path, so `/picks` and `/picks/` are the same route without a strip step.
 */
export const ROUTE_PATHS = {
  admin: "/admin",
  boardGameCollection: `${BOARD_GAME_COLLECTION_PATH}/*`,
  channels: "/channels/:channelId?",
  /** Anything unrecognised paints the mode landing rather than a blank page. */
  fallback: "*",
  home: "/",
  legacyCollection: "/collection/*",
  legacyGroup: "/g/*",
  /** Retired public address; `LegacyQueuesPage` replaces it with `/picks`. */
  legacyQueues: "/queues/*",
  legacyTonight: "/tonight/:step?",
  pending: "/pending/*",
  people: "/people",
  /** Unlinked compatibility surface for the card interactions that predate the task home. */
  overview: "/overview",
  queue: "/q/:setId",
  picks: "/picks/*",
  result: "/result/:gameId?",
  watchPlay: `${WATCH_PLAY_PATH}/:step?`,
} as const

/**
 * Where `/tonight[/<step>]` lives now. The STEP is carried across: `/tonight/surprise` is a
 * bookmark to the narrowing screen, and dropping the tail would land somebody who saved that
 * screen on the form above it.
 */
export function canonicalWatchPlayPath(
  step?: string,
): string {
  return step
    ? `${WATCH_PLAY_PATH}/${step}`
    : WATCH_PLAY_PATH
}

/**
 * Where `/collection[/<tail>]` lives now. The tail is carried for the same reason, even
 * though nothing under the shelf addresses one today — a rewrite that silently truncates is
 * the kind of thing the next route inherits.
 */
export function canonicalCollectionPath(
  tail?: string,
): string {
  return tail
    ? `${BOARD_GAME_COLLECTION_PATH}/${tail}`
    : BOARD_GAME_COLLECTION_PATH
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
    p.startsWith(BOARD_GAME_COLLECTION_PATH) ||
    p.startsWith("/collection")
  )
    return "‹ Collection"
  if (p.startsWith("/result")) return "‹ What to Watch/Play"
  if (p.startsWith("/picks") || p.startsWith("/queues"))
    return "‹ Picks"
  if (p.startsWith("/channels")) return "‹ Rules"
  if (p.startsWith("/q/")) return "‹ Back"
  if (p === "/admin" || p.startsWith("/admin/"))
    return "‹ QueuePilot"
  if (p === "/") return "‹ QueuePilot"

  return "‹ QueuePilot"
}
