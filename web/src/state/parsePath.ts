/**
 * The pure half of the router: pathname in, route out.
 *
 *   `/`                  PLAY (landing) — every group's sets
 *   `/g/<group>`         PLAY, filtered to one QueuePilot group
 *   `/queues`            QUEUES configurator (poster shelves)
 *   `/q/<id>`            one curated queue / channel as a grid
 *   `/channels[/<id>]`   the rule-based rotation channels
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
  | { view: "queues" }
  | { view: "pending" }
  | { view: "queue"; id: string }
  | { view: "channels"; id: string | null }

export function parsePath(pathname: string): Route {
  // `/queues/` and `/queues` are one page. A path router makes trailing slashes
  // reachable in a way `location.hash` never did (a link, a proxy rewrite, or a
  // user typing one), and an unhandled `/queues/` would silently fall through to
  // the PLAY fallback below.
  const path =
    pathname.length > 1
      ? pathname.replace(/\/+$/, "")
      : pathname

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
  if (p.startsWith("/queues")) return "‹ Ordered Queues"
  if (p.startsWith("/channels")) return "‹ Pools"
  if (p.startsWith("/q/")) return "‹ Back"

  return "‹ Play"
}
