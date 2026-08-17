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
  /**
   * The set this entry belongs to. The start modal uses it to load units from
   * THAT set's provider (a Kavita series id is invisible to Plex) and to pick
   * the vocabulary the copy is rewritten with.
   */
  setId?: string | null
}

export type PlayMenuTarget = {
  /** The trigger's viewport box — the menu is `position: fixed` and clamps to it. */
  anchor: DOMRect
  setId: string
  kind?: "movie"
  profile?: string
  /**
   * Play ONE entry of a curated set (its entry key) rather than letting the set choose.
   * The device menu is deliberately the same one: every play in this app names a device,
   * and "play this entry" is a narrower lineup, not a different kind of action.
   */
  only?: string
  /** What the ▶ is about to start, for the "Starting <title> on <device>…" toast. */
  onlyLabel?: string
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
  /**
   * The per-ENTRY settings panel (episodes / weight / batch stop / start). Holds the set and
   * the entry KEY rather than the item itself, so the open panel re-reads the live entry out
   * of the store — an SSE update or another device's edit lands in it instead of leaving a
   * stale copy on screen.
   */
  entryEditor: { setId: string; key: string } | null
  /**
   * The GROUPS editor — who is watching, and what is theirs. Holds the id being edited
   * (or null for "nothing selected yet"), not a copy of the group: the panel re-reads it
   * from the store, so an SSE update or an SMB edit lands in the open editor rather than
   * leaving a stale draft on screen. Same rule `entryEditor` above follows.
   */
  groupsModal: { selectedId: string | null } | null
}

let overlays: Overlays = {
  dynModal: null,
  entryEditor: null,
  groupsModal: null,
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

export const openGroupsModal = (
  selectedId: string | null = null,
) => set({ groupsModal: { selectedId } })

export const selectGroupInModal = (
  selectedId: string | null,
) => set({ groupsModal: { selectedId } })

export const closeGroupsModal = () =>
  set({ groupsModal: null })

// Opening the entry panel closes the tile menu that usually launched it, the same way
// openStartModal does — two overlays over one tile is never intended.
export const openEntryEditor = (
  setId: string,
  key: string,
) => set({ entryEditor: { key, setId }, tileMenu: null })

export const closeEntryEditor = () =>
  set({ entryEditor: null })
