import { useSyncExternalStore } from "react"

/**
 * A media query as a subscription. The 760px breakpoint controls Narrow View-only
 * layouts, including the Home toolbar's move out of the sticky header and the Rules
 * page's collapsible eligibility filters.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      const mq = window.matchMedia(query)

      mq.addEventListener("change", listener)

      return () =>
        mq.removeEventListener("change", listener)
    },
    () => window.matchMedia(query).matches,
  )
}
