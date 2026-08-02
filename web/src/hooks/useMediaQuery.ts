import { useSyncExternalStore } from "react"

/**
 * A media query as a subscription. Used for the 760px breakpoint at which the Home
 * toolbar moves out of the sticky header (too tight on a phone — Bob's explicit
 * ask) and into the top of the Home content.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      const mq = window.matchMedia(query)

      mq.addEventListener("change", listener)

      return () => mq.removeEventListener("change", listener)
    },
    () => window.matchMedia(query).matches,
  )
}
