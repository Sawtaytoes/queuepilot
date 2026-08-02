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

const listeners = new Set<() => void>()

function commit(next: Map<string, Selected>) {
  selected = next
  busy.selectedCount = next.size

  for (const l of listeners) l()
}

export const selKey = (set: string, key: string) => `${set}::${key}`

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
  if (!selected.size) return

  commit(new Map())
}
