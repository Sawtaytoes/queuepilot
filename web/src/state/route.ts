import { useLocation } from "react-router"

/**
 * Routing is react-router over real paths, as of 2026-08-16 — see `parsePath.ts` for
 * the four routes and the fleet
 * [decision](../../../docs/decisions/2026-08-16-routing-is-paths-not-hashes.md).
 *
 * This module is what is LEFT of the hand-rolled hash router: react-router owns the
 * history and the subscription now, so the `hashchange` listener, the module-level
 * `currentHash`, the listener `Set` and the `useSyncExternalStore` shim are all gone.
 * What react-router does NOT give us is the back TARGET.
 *
 * The header back button returns to the ORIGIN — where navigation into this view
 * STARTED, not a fixed parent (Bob: opening a channel from Play should go back to
 * Play, not to Channels). react-router exposes the current location, never the
 * previous one, so the origin is still tracked here.
 *
 * **The safety changed shape and it is worth knowing which.** Under the hash router
 * only the `hashchange` listener could write the origin, so a live re-render could
 * not clobber it *structurally*. Tracking now happens during render, so it is
 * *guarded* instead: `trackRouteOrigin` is a no-op unless the pathname actually
 * differs, which makes it idempotent under a StrictMode double-render and under any
 * re-render at the same path. Call it exactly once, at the top of `App`, before the
 * chrome is computed — the whole point is that `getRouteOrigin()` is already correct
 * on the FIRST render of the view you just navigated into.
 */

export type { Route } from "./parsePath"
export { labelForPath, parsePath } from "./parsePath"

let currentPath = "/"
let routeOrigin = "/"

export const getRouteOrigin = () => routeOrigin

export function trackRouteOrigin(pathname: string): void {
  if (pathname === currentPath) return

  routeOrigin = currentPath
  currentPath = pathname
}

/** The live pathname. A thin alias so views don't each reach for react-router. */
export function usePath(): string {
  return useLocation().pathname
}
