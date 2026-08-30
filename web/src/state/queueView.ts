import { useCallback, useEffect, useState } from "react"

import { byTitle, isCompleted } from "../lib/tileFace"
import type { QueueItem } from "../lib/types"
import type { Lane } from "./overlays"

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
  | "priority"
  | "start"

export type Sort = "queue" | "title" | "recent" | "weight"

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
  // A promote IS an override — the entry says something its queue did not. `lead` rides
  // with it rather than being listed separately: it only exists on a promoted entry.
  Boolean(it.placement) ||
  Boolean(it.start)

/**
 * The two LANES a Picks queue's grid is drawn in — Priority queue first, Random pool below
 * (decision `2026-08-26-the-queue-page-is-two-lanes-and-the-drag-is-the-promote`).
 *
 * `setLane` is the queue's own `add_as`, resolved by the caller through `normalizeAddAs` —
 * this function must not re-derive it, because the registry row may carry only a legacy kind
 * and there would then be two places that decide what an un-promoted entry means.
 *
 * The lanes are a VIEW. One list is stored, and an entry's lane is `placement ?? setLane`,
 * so a queue nobody has promoted anything in puts every entry in one lane and leaves the
 * other empty — which is the common case and is why the empty lane is a drop strip rather
 * than an error.
 *
 * ORDER differs by lane, and deliberately:
 *   * `priority` keeps the caller's order, which is FILE order. That is what the engine
 *     plays, so what you drag is literally what happens.
 *   * `random` is sorted for LOOKUP, because its order changes nothing — the pool is
 *     shuffled at playback. The queue page has always done this for a random-order set;
 *     this keeps it, now scoped to the lane instead of the whole page.
 */
export function splitLanes(
  items: QueueItem[],
  setLane: Lane,
  sort: Sort = "queue",
): { priority: QueueItem[]; random: QueueItem[] } {
  const priority: QueueItem[] = []
  const random: QueueItem[] = []

  for (const it of items) {
    if (effectiveLane(it, setLane) === "priority")
      priority.push(it)
    else random.push(it)
  }

  // `applyFilters` has already applied an explicit sort to the complete list. Preserve that
  // stable order inside both lanes. With no explicit sort, Priority keeps playback order and
  // the pool keeps its long-standing alphabetical lookup order.
  return {
    priority,
    random:
      sort === "queue" ? random.sort(byTitle) : random,
  }
}

/** Which lane ONE entry is in: its own `placement`, else the queue's default. */
export const effectiveLane = (
  item: Pick<QueueItem, "placement">,
  setLane: Lane,
): Lane =>
  (item.placement ?? setLane) === "priority"
    ? "priority"
    : "random"

/**
 * The new FILE order after `movedKeys` land in `lane`.
 *
 * The file is ONE sequence and the engine plays the priority entries in file order, so a
 * lane change is only half a write — the order has to say the same thing the lane does.
 * `useGridDrag` reads that order off the DOM after a drop; the tile menu and the selection
 * bar have no DOM to read, so they compute it here and both go through the same function.
 *
 * The moved entries land at ONE END of their new lane rather than keeping their file
 * positions. A promoted pool entry has no meaningful position to keep — the pool is
 * displayed alphabetically and shuffled at playback — so "wherever it happened to sit in the
 * file" would look arbitrary on screen. `bottom` is the promote ("after what is already
 * promoted"); `top` is "Play this next".
 *
 * Callers pass items whose `placement` is ALREADY the new one.
 * (decision `2026-08-26-the-tile-menu-carries-what-the-card-cannot`)
 */
export function orderAfterLaneMove(
  items: QueueItem[],
  setLane: Lane,
  movedKeys: string[],
  lane: Lane,
  where: "top" | "bottom" = "bottom",
): QueueItem[] {
  const isMoved = new Set(movedKeys)
  const moved = items.filter((it) => isMoved.has(it.key))
  const rest = items.filter((it) => !isMoved.has(it.key))
  const priority = rest.filter(
    (it) => effectiveLane(it, setLane) === "priority",
  )
  const random = rest.filter(
    (it) => effectiveLane(it, setLane) === "random",
  )
  const target = lane === "priority" ? priority : random

  if (where === "top") target.unshift(...moved)
  else target.push(...moved)

  return [...priority, ...random]
}

/** Move one Priority entry to a one-based position and keep the pool after the ordered run. */
export function orderAtPriorityPosition(
  items: QueueItem[],
  setLane: Lane,
  movedKey: string,
  position: number,
): QueueItem[] {
  const priority = items.filter(
    (item) => effectiveLane(item, setLane) === "priority",
  )
  const random = items.filter(
    (item) => effectiveLane(item, setLane) === "random",
  )
  const from = priority.findIndex(
    (item) => item.key === movedKey,
  )

  if (from < 0) return items

  const [moved] = priority.splice(from, 1)
  const requested = Number.isFinite(position)
    ? Math.round(position) - 1
    : from
  const at = Math.max(
    0,
    Math.min(priority.length, requested),
  )

  priority.splice(at, 0, moved!)

  return [...priority, ...random]
}

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
    // The entry's own PROMOTE, not the effective lane. On an ordered queue every entry is in
    // the Priority lane by inheritance, so an effective-lane filter would match all of them
    // and answer a question nobody asked; "what have I promoted here" is the useful one.
    if (
      f.state === "priority" &&
      it.placement !== "priority"
    )
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
  if (f.sort === "recent") {
    // Newest first. Old entries have no honest timestamp, so they follow every stamped entry
    // and keep their existing relative order instead of receiving an invented date.
    return [...out].sort(
      (a, b) => (b.queuedAt ?? 0) - (a.queuedAt ?? 0),
    )
  }
  return out
}
