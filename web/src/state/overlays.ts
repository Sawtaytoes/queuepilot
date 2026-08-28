import { useSyncExternalStore } from "react"

import { isStartable } from "../lib/tileFace"
import type { StartPoint, TileEntry } from "../lib/types"

/** The two lanes a Picks queue is drawn in. Mirrors `AddAs` on the wire. */
export type Lane = "priority" | "random"

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
  /**
   * How to remove the entry.
   *
   * NOT a tile-menu row — the ✕ on the card is the remove, in every editable grid
   * (decision `2026-08-21-any-tile-in-an-editable-grid-gets-the-remove-control`), and a menu
   * that repeats what the card already carries is a menu with nothing in it
   * (decision `2026-08-26-the-tile-menu-carries-what-the-card-cannot`). It stays on the type
   * because `PosterTile`'s ✕ and the entry sheet both call it.
   */
  remove?: () => void
  removeLabel?: string
  /**
   * Skip the one ITEM this entry is about to play, keeping the entry itself. Absent when
   * there is nothing inside the entry to skip — a movie entry, or one with nothing left —
   * so the menu row is omitted rather than shown and inert.
   */
  skip?: () => void
  skipLabel?: string
  /**
   * The entry's LANE, and how to move it — a promote or a demote without a drag.
   *
   * Absent on anything that is not a Picks queue entry: a rules channel's curated members are
   * one list, not two lanes, so the rows are not rendered there rather than rendered and
   * inert. Present on a queue entry wherever it is drawn, so the Home shelf's tiles get the
   * same two rows the queue page's do.
   */
  lane?: {
    current: Lane
    /** Already at the head of the Priority queue, so "Play this next" would do nothing. */
    isFirst: boolean
    moveTo: (lane: Lane) => void
    playNext: () => void
  }
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
  /**
   * Auto / Rules rewatch hint. Product kind on the wire is picks|rules; `rewatch` is how
   * a Movies Rules card (and set:auto Movie button) picks the rewatch channel.
   */
  behavior?: "rewatch"
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
  /**
   * The MEMBER list — every item inside one entry, and which of them this queue plays.
   *
   * Its own overlay rather than a section of the entry sheet: the list is as long as the
   * series is (a collection's five members, a show's whole run), and it saves as one answer
   * with its own Save/Cancel, where every control on the entry sheet writes on change.
   */
  membersModal: EntryActions | null
  playMenu: PlayMenuTarget | null
  setModal: {
    setId: string | null
    /**
     * Which lane a NEW Picks queue defaults to (`add_as`). Product kind is always
     * `picks` here — the legacy `movies` / `anime` preset strings are retired
     * (decision `2026-08-23-kind-is-picks-or-rules`).
     */
    presetAddAs?: "priority" | "random"
    /**
     * Libraries the FIRST provider block starts with, as Plex section ids.
     *
     * Set when the queue is being created FOR something — the Pending screen's "New queue…",
     * which knows the library the item came from. Without it a queue created from that menu
     * draws from nothing, so the item that prompted it could not be added to it
     * (decision `2026-08-22-pending-can-make-the-queue-it-is-adding-to`).
     */
    presetLibraries?: string[]
    /** Called with the new set's id after a successful CREATE (never on an edit). */
    onCreated?: (setId: string) => void
  } | null
  dynModal: { setId: string | null } | null
  /**
   * The per-ENTRY settings panel (episodes / weight / batch stop / start). Holds the set and
   * the entry KEY rather than the item itself, so the open panel re-reads the live entry out
   * of the store — an SSE update or another device's edit lands in it instead of leaving a
   * stale copy on screen.
   */
  entryEditor: { setId: string; key: string } | null
  /** The roster editor. No payload — it always opens on the whole household. */
  peopleModal: boolean
}

let overlays: Overlays = {
  dynModal: null,
  entryEditor: null,
  peopleModal: false,
  membersModal: null,
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

/**
 * Does this entry have anything to PUT in the tile menu?
 *
 * The menu carries only what the card cannot: the lane moves, the manual start point and
 * Skip. Remove is on the card as ✕ and is deliberately not a row. So an entry with none of
 * those — a movie member of a rules channel — would open an empty box, and this is what
 * stops it: `openTileMenu` no-ops instead, and the long-press does nothing visible.
 * (decision `2026-08-26-the-tile-menu-carries-what-the-card-cannot`)
 */
export const hasTileMenuActions = (entry: EntryActions) =>
  Boolean(
    entry.lane ||
      entry.skip ||
      (entry.item && isStartable(entry.item)),
  )

export const openTileMenu = (
  x: number,
  y: number,
  entry: EntryActions,
) => {
  if (!hasTileMenuActions(entry)) return

  set({ tileMenu: { entry, x, y } })
}

export const closeTileMenu = () => {
  if (overlays.tileMenu) set({ tileMenu: null })
}

export const openStartModal = (entry: EntryActions) =>
  set({ startModal: entry, tileMenu: null })

export const closeStartModal = () =>
  set({ startModal: null })

// Closes the tile menu AND the entry sheet, for the same reason `openStartModal` closes the
// menu: this opens from either one, and two overlays over one tile is never intended.
export const openMembersModal = (entry: EntryActions) =>
  set({
    entryEditor: null,
    membersModal: entry,
    tileMenu: null,
  })

export const closeMembersModal = () =>
  set({ membersModal: null })

export const openPlayMenu = (target: PlayMenuTarget) =>
  set({ playMenu: target })

export const closePlayMenus = () => {
  if (overlays.playMenu) set({ playMenu: null })
}

export const openSetModal = (
  setId: string | null,
  presetAddAs?: "priority" | "random",
  opts?: {
    presetLibraries?: string[]
    onCreated?: (setId: string) => void
  },
) =>
  set({
    setModal: {
      onCreated: opts?.onCreated,
      presetAddAs,
      presetLibraries: opts?.presetLibraries,
      setId,
    },
  })

export const closeSetModal = () => set({ setModal: null })

export const openDynModal = (setId: string | null) =>
  set({ dynModal: { setId } })

export const closeDynModal = () => set({ dynModal: null })

export const openPeopleModal = () =>
  set({ peopleModal: true })

export const closePeopleModal = () =>
  set({ peopleModal: false })

// Opening the entry panel closes the tile menu that usually launched it, the same way
// openStartModal does — two overlays over one tile is never intended.
export const openEntryEditor = (
  setId: string,
  key: string,
) => set({ entryEditor: { key, setId }, tileMenu: null })

export const closeEntryEditor = () =>
  set({ entryEditor: null })
