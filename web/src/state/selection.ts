import { useSyncExternalStore } from "react"

import { busy } from "./busy"

/**
 * The queue grid's multi-select. Keyed `${set}::${key}` so a title that sits in
 * several queues can only ever be selected in the one you are looking at.
 *
 * A non-empty selection counts as "the UI is busy" — it is an edit in progress, and
 * a live refresh underneath it would discard what the user picked.
 */

export type Selected = { fromSet: string; key: string }

let selected = new Map<string, Selected>()
let anchor: Selected | null = null

const listeners = new Set<() => void>()

function commit(next: Map<string, Selected>) {
  selected = next
  busy.selectedCount = next.size

  for (const l of listeners) l()
}

export const selKey = (set: string, key: string) =>
  `${set}::${key}`

export const getSelected = () => selected

export const useSelected = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l)

      return () => {
        listeners.delete(l)
      }
    },
    () => selected,
  )

export function toggleSelect(set: string, key: string) {
  const next = new Map(selected)
  const k = selKey(set, key)

  if (next.has(k)) next.delete(k)
  else next.set(k, { fromSet: set, key })

  anchor = { fromSet: set, key }
  commit(next)
}

/**
 * Toggle one entry, or add the inclusive range from the last selection anchor.
 *
 * `orderedKeys` is the order on screen, not the queue file's order. This matters while a
 * view filter is active and because the Priority queue and Random pool are two rendered
 * lanes. Shift-selection must select what the person can see between the two clicks.
 */
export function toggleSelectThrough(
  set: string,
  key: string,
  orderedKeys: readonly string[],
  isRange: boolean,
) {
  if (!isRange || anchor?.fromSet !== set) {
    toggleSelect(set, key)

    return
  }

  const from = orderedKeys.indexOf(anchor.key)
  const to = orderedKeys.indexOf(key)

  if (from < 0 || to < 0) {
    toggleSelect(set, key)

    return
  }

  const next = new Map(selected)
  const start = Math.min(from, to)
  const end = Math.max(from, to)

  for (const rangeKey of orderedKeys.slice(
    start,
    end + 1,
  )) {
    next.set(selKey(set, rangeKey), {
      fromSet: set,
      key: rangeKey,
    })
  }

  commit(next)
}

export function deselect(set: string, key: string) {
  const k = selKey(set, key)

  if (!selected.has(k)) return

  const next = new Map(selected)

  next.delete(k)
  commit(next)
}

export function clearSelection() {
  anchor = null
  if (!selected.size) return

  commit(new Map())
}
