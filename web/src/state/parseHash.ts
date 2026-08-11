/**
 * The pure half of the router: hash string in, route out.
 *
 *   `#/`                  PLAY (landing)
 *   `#/queues`            QUEUES configurator (poster shelves)
 *   `#/q/<id>`            one curated queue / channel as a grid
 *   `#/channels[/<id>]`   the rule-based rotation channels
 *
 * Split from `route.ts` because that module reads `location` at import time (it
 * owns the live subscription), which a Node-environment test cannot provide.
 * Nothing in here touches the DOM.
 */

export type Route =
  | { view: "play" }
  | { view: "queues" }
  | { view: "queue"; id: string }
  | { view: "channels"; id: string | null }

export function parseHash(hash: string): Route {
  const q = hash.match(/^#\/q\/(.+)$/)

  if (q?.[1])
    return { id: decodeURIComponent(q[1]), view: "queue" }

  const c = hash.match(/^#\/channels(?:\/(.+))?$/)

  if (c)
    return {
      id: c[1] ? decodeURIComponent(c[1]) : null,
      view: "channels",
    }

  if (hash.startsWith("#/queues")) return { view: "queues" }

  // An unknown hash lands on the landing rather than a blank page.
  return { view: "play" }
}

/** What the back button should SAY, given where it goes. */
export function labelForHash(h: string): string {
  if (h.startsWith("#/queues")) return "‹ Queues"
  if (h.startsWith("#/channels")) return "‹ Channels"
  if (h.startsWith("#/q/")) return "‹ Back"

  return "‹ Play"
}
