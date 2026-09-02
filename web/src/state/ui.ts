import { useSyncExternalStore } from "react"

/**
 * The two bits of view state that outlive a single component: the Home queue filter
 * (typed in the toolbar, applied to shelves rendered elsewhere) and which shelves
 * are collapsed (persisted, and toggled from both the shelf and "Collapse all").
 *
 * Scroll position used to live here too, as `homeScroll`. Charcuterie's `Main`
 * remembers where every history entry was scrolled to, so the one-way version this
 * held — Queues only, and only when the queue was opened by its title — is gone.
 */

const COLLAPSE_KEY = "pc.collapsedQueues"

function readCollapsed(): {
  collapsed: Set<string>
  hasCollapsePreference: boolean
} {
  try {
    const stored = localStorage.getItem(COLLAPSE_KEY)

    return {
      collapsed: new Set(JSON.parse(stored || "[]")),
      hasCollapsePreference: stored !== null,
    }
  } catch {
    return {
      collapsed: new Set(),
      hasCollapsePreference: false,
    }
  }
}

type UiState = {
  filter: string
  collapsed: Set<string>
  /** No saved preference means every Picks shelf starts collapsed. */
  hasCollapsePreference: boolean
}

const initialCollapse = readCollapsed()

let state: UiState = {
  ...initialCollapse,
  filter: "",
}

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
  state = {
    ...state,
    collapsed,
    hasCollapsePreference: true,
  }

  try {
    localStorage.setItem(
      COLLAPSE_KEY,
      JSON.stringify([...collapsed]),
    )
  } catch {
    /* private mode */
  }

  emit()
}

export function toggleCollapsed(
  id: string,
  isCurrentlyCollapsed = state.collapsed.has(id),
) {
  const next = new Set(state.collapsed)

  if (isCurrentlyCollapsed) next.delete(id)
  else next.add(id)

  setCollapsed(next)
}
