import { useSyncExternalStore } from "react"

import type { StartPoint, TileEntry } from "../lib/types"

/**
 * The five things that float above a view: the tile context menu, the "Start
 * from…" picker, the "Play on ▾" device menu, the queue/channel modal and the
 * dynamic-channel modal.
 *
 * They live in one module store rather than being prop-drilled because a tile deep
 * inside a shelf, a grid, a member grid and a landing row all open the same ones —
 * which is exactly why the vanilla app made them singletons in the document.
 */

/**
 * Everything the start-point affordances need from an entry: the entry itself, how
 * to persist a start (a queue PATCH, or a whole-array members write), how to
 * repaint that grid afterwards, and optionally how to remove it.
 */
export type EntryActions = {
  item: TileEntry
  save: (start: StartPoint | null) => Promise<unknown>
  refresh: () => void
  remove?: () => void
  removeLabel?: string
  /** A Plex Home profile's `user_uuid`, set for a per-profile channel so the start
   * picker scopes its "watched" marks to THAT profile (not the admin account). Omitted
   * for queues/admin, which read Bob's view. */
  accountUuid?: string | null
}

export type PlayMenuTarget = {
  /** The trigger's viewport box — the menu is `position: fixed` and clamps to it. */
  anchor: DOMRect
  setId: string
  kind?: "movie"
  profile?: string
}

type Overlays = {
  tileMenu: {
    x: number
    y: number
    entry: EntryActions
  } | null
  startModal: EntryActions | null
  playMenu: PlayMenuTarget | null
  setModal: {
    setId: string | null
    presetKind?: string
  } | null
  dynModal: { setId: string | null } | null
}

let overlays: Overlays = {
  dynModal: null,
  playMenu: null,
  setModal: null,
  startModal: null,
  tileMenu: null,
}

const listeners = new Set<() => void>()

function set(patch: Partial<Overlays>) {
  overlays = { ...overlays, ...patch }

  for (const l of listeners) l()
}

export const getOverlays = () => overlays

export const useOverlays = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l)

      return () => {
        listeners.delete(l)
      }
    },
    () => overlays,
  )

export const openTileMenu = (
  x: number,
  y: number,
  entry: EntryActions,
) => set({ tileMenu: { entry, x, y } })

export const closeTileMenu = () => {
  if (overlays.tileMenu) set({ tileMenu: null })
}

export const openStartModal = (entry: EntryActions) =>
  set({ startModal: entry, tileMenu: null })

export const closeStartModal = () =>
  set({ startModal: null })

export const openPlayMenu = (target: PlayMenuTarget) =>
  set({ playMenu: target })

export const closePlayMenus = () => {
  if (overlays.playMenu) set({ playMenu: null })
}

export const openSetModal = (
  setId: string | null,
  presetKind?: string,
) => set({ setModal: { presetKind, setId } })

export const closeSetModal = () => set({ setModal: null })

export const openDynModal = (setId: string | null) =>
  set({ dynModal: { setId } })

export const closeDynModal = () => set({ dynModal: null })
