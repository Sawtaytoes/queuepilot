import { api } from "../lib/api"
import type { QueueItem } from "../lib/types"
import { refreshData } from "./live"
import type { EntryActions } from "./overlays"
import { deselect } from "./selection"
import { bumpRevision, getState, setStatus } from "./store"

/**
 * ONE entry's write side, shared by every grid that renders that entry.
 *
 * This used to be two closures inside `QueueView` — which is why the Home shelf,
 * which renders the very same `PosterTile`, had no ✕ at all: reaching the removal
 * meant reaching into a component. Lifted here so a second call site costs a prop
 * rather than a second implementation, and so a fix lands in one place
 * (decision `2026-08-21-any-tile-in-an-editable-grid-gets-the-remove-control`).
 *
 * `setId` is nullable because the queue page reads it from the route, where it is
 * `undefined` for one paint. Every helper here no-ops on a missing set rather than
 * building a `/api/queues/undefined/...` URL.
 */

/**
 * Remove one entry from one queue — OPTIMISTIC, then DELETE behind it.
 *
 * The tile is pulled from the store immediately (the resolve round-trip is ~1.5 s
 * and the grid used to freeze for all of it), and a failed DELETE re-syncs from the
 * server so the tile cannot stay gone. Nothing here touches undo: the server
 * snapshots the YAML in `undoSnapshot` middleware before ANY mutating request, so
 * this participates in undo/redo exactly like every other write, and the counters
 * are re-read by the live refresh the write's own file change triggers.
 */
export function removeQueueItem(
  setId: string | null | undefined,
  item: QueueItem,
) {
  if (!setId) return

  const set = getState().data?.sets[setId]

  if (set) {
    set.items = set.items.filter(
      (it) => it.key !== item.key,
    )
    bumpRevision()
  }

  deselect(setId, item.key)
  setStatus("Removed", "ok")

  api(
    "DELETE",
    `/api/queues/${setId}/items/${encodeURIComponent(item.key)}`,
  ).catch((err: Error) => {
    setStatus(`Remove failed: ${err.message}`, "err")
    refreshData()
  })
}

/**
 * What the tile menu, the start picker and the entry sheet need from ONE queue
 * entry: the entry, how to persist a start point, how to repaint, and how to
 * remove it.
 */
export const queueEntryActions = (
  setId: string | null | undefined,
  item: QueueItem,
): EntryActions => ({
  item,
  refresh: () => refreshData(),
  remove: () => removeQueueItem(setId, item),
  removeLabel: "Remove from this queue",
  setId,
  save: (start) =>
    api(
      "PATCH",
      `/api/queues/${setId}/items/${encodeURIComponent(item.key)}/start`,
      { start },
    ),
})
