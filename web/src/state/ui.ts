import { useSyncExternalStore } from "react"

/**
 * The two bits of view state that outlive a single component: the Home queue filter
 * (typed in the toolbar, applied to shelves rendered elsewhere) and which shelves
 * are collapsed (persisted, and toggled from both the shelf and "Collapse all").
 *
 * Plus `homeScroll`: returning from a queue lands you back where you were, so you
 * can open the next queue near where you left off.
 */

const COLLAPSE_KEY = "pc.collapsedQueues"

function readCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "[]"))
  }
  catch {
    return new Set()
  }
}

type UiState = {
  filter: string
  collapsed: Set<string>
}

let state: UiState = { collapsed: readCollapsed(), filter: "" }

const listeners = new Set<() => void>()

const emit = () => {
  for (const l of listeners) l()
}

export const getUi = () => state

export const useUi = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l)

      return () => {
        listeners.delete(l)
      }
    },
    () => state,
  )

export function setFilter(filter: string) {
  state = { ...state, filter }
  emit()
}

export function setCollapsed(collapsed: Set<string>) {
  state = { ...state, collapsed }

  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed]))
  }
  catch {
    /* private mode */
  }

  emit()
}

export function toggleCollapsed(id: string) {
  const next = new Set(state.collapsed)

  if (next.has(id)) next.delete(id)
  else next.add(id)

  setCollapsed(next)
}

/** Where the shelves were scrolled when a queue was opened from Home. */
export const homeScroll = { y: 0 }
