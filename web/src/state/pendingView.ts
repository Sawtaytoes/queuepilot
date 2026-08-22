import { useCallback, useState } from "react"

/**
 * How the Pending screen is being looked at: a wall of posters, or a list.
 *
 * The queue grid has had this choice since it was built (`queueView.ts`), and Pending is the
 * same content in the same shape — the owner asked for both here for the same reason: *"I
 * think we can have both list and poster views."*
 *
 * Two views, not three. The queue grid's middle density (Cards) exists because a queue entry
 * carries per-entry knobs a poster cannot show — a batch, a weight, a start point. A pending
 * item carries none of that; it is a title, its library, and three things you can do to it.
 * (decision `2026-08-22-pending-has-a-poster-view-and-a-list-view`)
 *
 * Persisted once for the screen, not per library filter: this is how you like to READ the
 * page, and it does not change because you ticked a different library.
 */

export type PendingDensity = "posters" | "list"

const KEY = "queuepilot:pending-view"

const DENSITIES: PendingDensity[] = ["posters", "list"]

const DEFAULT: PendingDensity = "posters"

/** The stored view, healing anything a stale or hand-edited entry got wrong. */
function readDensity(): PendingDensity {
  try {
    const raw = window.localStorage.getItem(KEY)

    return DENSITIES.includes(raw as PendingDensity)
      ? (raw as PendingDensity)
      : DEFAULT
  } catch {
    // Private mode, quota, a blocked store: a view preference is never worth throwing over.
    return DEFAULT
  }
}

export function usePendingView() {
  const [density, setDensityState] =
    useState<PendingDensity>(readDensity)

  const setDensity = useCallback((next: PendingDensity) => {
    setDensityState(next)

    try {
      window.localStorage.setItem(KEY, next)
    } catch {
      /* the choice still holds for this session */
    }
  }, [])

  return { density, setDensity }
}
