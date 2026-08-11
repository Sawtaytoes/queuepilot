import { useSyncExternalStore } from "react"

/**
 * Routing is `location.hash`, unchanged from the vanilla app:
 *
 *   `#/`                  PLAY (landing)
 *   `#/queues`            QUEUES configurator (poster shelves)
 *   `#/q/<id>`            one curated queue / channel as a grid
 *   `#/channels[/<id>]`   the rule-based rotation channels
 *
 * Hash routing is why the Express server needs no SPA fallback: every URL the
 * browser requests is `/`.
 *
 * The header back button returns to the ORIGIN — where navigation into this view
 * STARTED, not a fixed parent (Bob: opening a channel from Play should go back to
 * Play, not to Channels). The origin is only updated on a real hash change, which
 * in this port is structural rather than guarded: only the `hashchange` listener
 * writes it, so a live re-render cannot clobber it the way it could when the
 * vanilla `route()` was also the repaint entry point.
 */

export type { Route } from "./parseHash"
export { labelForHash, parseHash } from "./parseHash"

let currentHash = location.hash || "#/"
let routeOrigin = "#/"

const listeners = new Set<() => void>()

window.addEventListener("hashchange", () => {
  const here = location.hash || "#/"

  if (here !== currentHash) {
    routeOrigin = currentHash
    currentHash = here

    for (const l of listeners) l()
  }
})

export const getHash = () => currentHash

export const getRouteOrigin = () => routeOrigin

export function useHash(): string {
  return useSyncExternalStore((l) => {
    listeners.add(l)

    return () => {
      listeners.delete(l)
    }
  }, getHash)
}

export const navigate = (hash: string) => {
  location.hash = hash
}
