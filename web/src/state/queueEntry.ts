import { api } from "../lib/api"
import {
  isSkipListChanged,
  mergeSkipped,
} from "../lib/skipList"
import type { QueueItem } from "../lib/types"
import { refreshData } from "./live"
import type { EntryActions } from "./overlays"
import { deselect } from "./selection"
import {
  bumpRevision,
  fetchAll,
  getState,
  setState,
  setStatus,
} from "./store"

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
 * The LEAF this tile is about to play — the episode, or the collection child — or null when
 * there is not one.
 *
 * Null in three cases, and each of them means "there is nothing here to skip": an entry that
 * is a MOVIE (the entry is the leaf, and the way to stop it is Remove); an entry with nothing
 * left to play; and a provider that resolves no leaf key. The tile menu asks this before it
 * offers Skip, so the action is never offered where it would do nothing.
 */
export const skippableLeaf = (
  item: QueueItem,
): string | null => {
  const rk = item.nextEp?.ratingKey

  return rk ? String(rk) : null
}

/** What the Skip row says it will drop — the episode label, else the leaf's own title. */
export const skipTarget = (item: QueueItem): string =>
  item.nextEp?.title || item.title

/**
 * Skip the item this entry is about to play — add its leaf key to the SET's `skipped` list.
 *
 * A set-level list rather than a per-entry field, matching a filtered pool's `blocklist`: the
 * thing being skipped is an episode or a collection child, and neither of those has a line in
 * `queues.yaml` to hang a flag on. Permanent until it is cleared from the Skipped panel.
 *
 * NOT optimistic, unlike `removeQueueItem`. The visible result of a skip is the tile's NEXT-UP
 * moving on to the following episode, and only the server can work out what that is — so there
 * is nothing honest to paint before the round-trip. The re-read is `fetchAll`, because the
 * write lands on the registry (`/api/sets/:id`) and the tile is rebuilt from `/api/queues`;
 * `PATCH /api/sets/:id` busts the server's resolve cache, so the second read sees the new
 * "next".
 */
export async function skipQueueItem(
  setId: string | null | undefined,
  item: QueueItem,
) {
  const leaf = skippableLeaf(item)

  if (!setId || !leaf) return

  const set = getState().reg?.sets.find(
    (s) => s.id === setId,
  )
  const current = set?.skipped || []
  const label = skipTarget(item)

  // Already there — the same guard the blocklist picker uses. A second PATCH would be
  // harmless (the server dedupes) but the toast would lie about having done something.
  if (current.includes(leaf)) {
    setStatus(`Already skipped — “${label}”`, "ok")

    return
  }

  setStatus(`Skipping ${label}…`)

  try {
    await api("PATCH", `/api/sets/${setId}`, {
      skipped: [...current, leaf],
    })

    const [data, reg] = await fetchAll()

    setState({ data, reg })
    setStatus(`Skipped “${label}”`, "ok")
  } catch (e) {
    setStatus(`Skip failed: ${(e as Error).message}`, "err")
  }
}

/**
 * Save a WHOLE entry's answer to "what plays" — the member list's Save.
 *
 * One PATCH for the lot, where `skipQueueItem` is one PATCH per item: the panel exists so
 * three duplicate cuts of one film can be dealt with in one go, and a write per tick would
 * cost a Plex re-resolve per tick and reorder the rows under the pointer between them.
 *
 * `managed` is what this panel is responsible for; every other key on the set is carried
 * through untouched (see `mergeSkipped` — the list is per set, not per entry).
 */
export async function saveSkipList(
  setId: string | null | undefined,
  {
    managed,
    skipped,
  }: {
    managed: Iterable<string>
    skipped: Iterable<string>
  },
): Promise<boolean> {
  if (!setId) return false

  const set = getState().reg?.sets.find(
    (s) => s.id === setId,
  )
  const current = set?.skipped || []
  const next = mergeSkipped({ current, managed, skipped })

  // Nothing ticked or unticked: say so and write nothing. A PATCH here would re-resolve
  // every tile in the queue to arrive at the list it already had.
  if (!isSkipListChanged(current, next)) {
    setStatus("Nothing changed", "ok")

    return true
  }

  setStatus("Saving…")

  try {
    await api("PATCH", `/api/sets/${setId}`, {
      skipped: next,
    })

    const [data, reg] = await fetchAll()

    setState({ data, reg })
    setStatus("Saved", "ok")

    return true
  } catch (e) {
    setStatus(`Save failed: ${(e as Error).message}`, "err")

    return false
  }
}

/** Put one leaf back — the Skipped panel's ✕, and the only way a skip ever ends. */
export async function unskipItem(
  setId: string,
  ratingKey: string,
  label: string,
) {
  const set = getState().reg?.sets.find(
    (s) => s.id === setId,
  )

  setStatus(`Restoring ${label}…`)

  try {
    await api("PATCH", `/api/sets/${setId}`, {
      skipped: (set?.skipped || []).filter(
        (rk) => rk !== ratingKey,
      ),
    })

    const [data, reg] = await fetchAll()

    setState({ data, reg })
    setStatus(`Restored “${label}”`, "ok")
  } catch (e) {
    setStatus(
      `Restore failed: ${(e as Error).message}`,
      "err",
    )
  }
}

/**
 * What the tile menu, the start picker and the entry sheet need from ONE queue
 * entry: the entry, how to persist a start point, how to repaint, how to skip the
 * one item it is about to play, and how to remove it.
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
  // Absent when there is no leaf to skip, so the menu row is not rendered at all rather than
  // rendered and inert.
  skip: skippableLeaf(item)
    ? () => void skipQueueItem(setId, item)
    : undefined,
  skipLabel: `Skip “${skipTarget(item)}”`,
  save: (start) =>
    api(
      "PATCH",
      `/api/queues/${setId}/items/${encodeURIComponent(item.key)}/start`,
      { start },
    ),
})
