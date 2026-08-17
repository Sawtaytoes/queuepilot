import { useCallback, useEffect, useState } from "react"

import { isCompleted } from "../lib/tileFace"
import type { QueueItem } from "../lib/types"

/**
 * How ONE queue is being looked at: its density, and the filter narrowing what you see.
 *
 * Persisted PER QUEUE (`queuepilot:view:<setId>` in localStorage), because the queues are not
 * alike — a 45-entry anime channel wants cards you can read, a three-item movie queue is fine
 * as a poster wall — and because the filter is part of that: coming back to a queue you left
 * filtered to "completed" and finding it unfiltered would lose the pass you were in the middle
 * of. The count of hidden entries is always on screen so a filter can never masquerade as an
 * empty queue.
 */

export type Density = "posters" | "cards" | "rows"

export type EntryState =
  | ""
  | "done"
  | "active"
  | "overrides"
  | "weighted"
  | "start"

export type Sort = "queue" | "title" | "weight"

export type QueueFilters = {
  text: string
  type: "" | "show" | "movie" | "collection"
  state: EntryState
  sort: Sort
}

export type QueueView = {
  density: Density
  filters: QueueFilters
}

export const EMPTY_FILTERS: QueueFilters = {
  sort: "queue",
  state: "",
  text: "",
  type: "",
}

const DEFAULT_VIEW: QueueView = {
  density: "cards",
  filters: EMPTY_FILTERS,
}

const KEY = (setId: string) => `queuepilot:view:${setId}`

const DENSITIES: Density[] = ["posters", "cards", "rows"]

/** Read one queue's stored view, healing anything a stale/hand-edited entry got wrong. */
function readView(setId: string | null): QueueView {
  if (!setId) return DEFAULT_VIEW
  try {
    const raw = window.localStorage.getItem(KEY(setId))
    if (!raw) return DEFAULT_VIEW
    const v = JSON.parse(raw) as Partial<QueueView>
    return {
      density: DENSITIES.includes(v.density as Density)
        ? (v.density as Density)
        : DEFAULT_VIEW.density,
      filters: { ...EMPTY_FILTERS, ...(v.filters ?? {}) },
    }
  } catch {
    return DEFAULT_VIEW // private mode, quota, corrupt JSON — a view is never worth throwing over
  }
}

export const isFiltered = (f: QueueFilters) =>
  Boolean(f.text.trim() || f.type || f.state) ||
  f.sort !== "queue"

export function useQueueView(setId: string | null) {
  const [view, setView] = useState<QueueView>(() =>
    readView(setId),
  )

  // Switching queues loads THAT queue's view. Keyed on the id rather than remounting the whole
  // grid, so the poster images already in cache stay put.
  useEffect(() => {
    setView(readView(setId))
  }, [setId])

  const write = useCallback(
    (next: QueueView) => {
      setView(next)
      if (!setId) return
      try {
        window.localStorage.setItem(
          KEY(setId),
          JSON.stringify(next),
        )
      } catch {
        /* storage full or blocked: the view still works for this session */
      }
    },
    [setId],
  )

  return {
    density: view.density,
    filters: view.filters,
    isFiltered: isFiltered(view.filters),
    resetFilters: () =>
      write({ ...view, filters: EMPTY_FILTERS }),
    setDensity: (density: Density) =>
      write({ ...view, density }),
    setFilters: (patch: Partial<QueueFilters>) =>
      write({
        ...view,
        filters: { ...view.filters, ...patch },
      }),
  }
}

/** Does this entry carry ANY per-entry override, i.e. is it not just following the set? */
export const hasOverrides = (it: QueueItem) =>
  it.episodes != null ||
  it.volumes != null ||
  (it.weight ?? 1) > 1 ||
  Boolean(it.batch_stops_at) ||
  Boolean(it.start)

/** Apply one queue's filters to its entries. Order is the caller's; sort is applied last. */
export function applyFilters(
  items: QueueItem[],
  f: QueueFilters,
): QueueItem[] {
  const text = f.text.trim().toLowerCase()
  const out = items.filter((it) => {
    if (
      text &&
      !it.title.toLowerCase().includes(text) &&
      !(it.raw ?? "").toLowerCase().includes(text)
    ) {
      return false
    }
    if (f.type && it.type !== f.type) return false
    // "Completed / fully watched" means what the TILE means by it — the file's flag or a
    // live-finished entry the next scan will flag — so filtering never hides a tile that is
    // sitting right there wearing a Completed badge.
    if (f.state === "done" && !isCompleted(it)) return false
    if (f.state === "active" && isCompleted(it))
      return false
    if (f.state === "overrides" && !hasOverrides(it))
      return false
    if (f.state === "weighted" && (it.weight ?? 1) < 2)
      return false
    if (f.state === "start" && !it.start) return false
    return true
  })
  if (f.sort === "title") {
    return [...out].sort((a, b) =>
      a.title.localeCompare(b.title, undefined, {
        sensitivity: "base",
      }),
    )
  }
  if (f.sort === "weight") {
    // Heaviest first; ties keep the queue's own order, so this reads as "the weighted ones,
    // then everything else as it sits" rather than an arbitrary reshuffle.
    return [...out].sort(
      (a, b) => (b.weight ?? 1) - (a.weight ?? 1),
    )
  }
  return out
}
