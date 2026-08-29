import { api } from "../lib/api"
import { isRandomOrder } from "../lib/kind"
import {
  isSkipListChanged,
  mergeIncludedSpecials,
  mergeSkipped,
} from "../lib/skipList"
import type { QueueItem } from "../lib/types"
import { refreshData } from "./live"
import type { EntryActions, Lane } from "./overlays"
import {
  effectiveLane,
  orderAfterLaneMove,
  orderAtPriorityPosition,
} from "./queueView"
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
 * TOGGLE one entry's lane — the tile's ↑ / ↓, on the queue page and on a Picks shelf.
 *
 * A thin wrapper, deliberately. The arrow and the tile menu's two lane rows are the same
 * write with different words on them, and they used to be two functions computing the file
 * order two ways (`promotedOrder` here, `orderAfterLaneMove` there). That is the drift
 * `2026-08-26-the-tile-menu-carries-what-the-card-cannot` names: a promote from the arrow
 * and a promote from the menu must land in the same place, and the only way to be sure of
 * that is for one of them not to have its own implementation.
 *
 * The arrow says only "the other lane", so the toggle is all this adds. Everything the old
 * body carried — the sparse placement write, `placement` before `/order`, the optimistic
 * paint, the re-sync on failure — is `setEntryLane`, unchanged.
 *
 * One behaviour moved with it: a DEMOTE now sends the order too. It used to send none, on
 * the ground that the pool is shuffled at playback so its order means nothing. That is still
 * true of the POOL, but the file is one sequence, and an entry that leaves the Priority
 * queue has to leave the priority run of the file as well.
 */
export async function moveEntryLane(
  setId: string | null | undefined,
  item: QueueItem,
  setLane: Lane,
) {
  await setEntryLane(
    setId,
    item,
    effectiveLane(item, setLane) === "priority"
      ? "random"
      : "priority",
  )
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
export async function saveMemberSelection(
  setId: string | null | undefined,
  {
    includedSpecials,
    managed,
    managedSpecials,
    skipped,
  }: {
    includedSpecials: Iterable<string>
    managed: Iterable<string>
    managedSpecials: Iterable<string>
    skipped: Iterable<string>
  },
): Promise<boolean> {
  if (!setId) return false

  const set = getState().reg?.sets.find(
    (s) => s.id === setId,
  )
  const current = set?.skipped || []
  const next = mergeSkipped({ current, managed, skipped })
  const currentIncluded = set?.included_specials || []
  const nextIncluded = mergeIncludedSpecials({
    current: currentIncluded,
    managed: managedSpecials,
    included: includedSpecials,
  })

  // Nothing ticked or unticked: say so and write nothing. A PATCH here would re-resolve
  // every tile in the queue to arrive at the list it already had.
  if (
    !isSkipListChanged(current, next) &&
    !isSkipListChanged(currentIncluded, nextIncluded)
  ) {
    setStatus("Nothing changed", "ok")

    return true
  }

  setStatus("Saving…")

  try {
    await api("PATCH", `/api/sets/${setId}`, {
      included_specials: nextIncluded,
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
  // The LANE half of the menu. Only a queue entry has one — a rules channel's members are
  // not a two-lane list — so this is set here and left off `channelEntryActions`.
  lane: setId
    ? {
        current: laneOf(setId, item),
        isFirst:
          getState().data?.sets[setId]?.items.find(
            (it) => laneOf(setId, it) === "priority",
          )?.key === item.key,
        moveTo: (lane) =>
          void setEntryLane(setId, item, lane),
        playNext: () =>
          void setEntryLane(setId, item, "priority", "top"),
      }
    : undefined,
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

/**
 * The queue's OWN default lane — what an entry carrying no `placement` of its own means.
 *
 * The registry row first, the queues payload second, exactly as `QueueView` resolves it: the
 * registry always reports an effective `add_as`, while `/api/queues` may still be the shelves
 * skeleton for a beat.
 */
const defaultLaneOf = (
  setId: string | null | undefined,
): Lane => {
  if (!setId) return "priority"

  const state = getState()
  const set =
    state.reg?.sets.find((s) => s.id === setId) ??
    state.data?.sets[setId]

  return isRandomOrder(set) ? "random" : "priority"
}

/** Which lane one entry is in: its own `placement`, else the queue's default. */
export const laneOf = (
  setId: string | null | undefined,
  item: QueueItem,
): Lane => effectiveLane(item, defaultLaneOf(setId))

/**
 * Move ONE entry between the Priority queue and the Random pool.
 *
 * The same write the drag across the lane divider makes (`useGridDrag`), reachable without a
 * drag — which is what the tile menu needed, because a promote was a touch gesture only
 * (decision `2026-08-26-the-tile-menu-carries-what-the-card-cannot`).
 *
 * `where` says which END of the Priority queue the entry lands on. "Move to the Priority
 * queue" appends, so a promote never displaces what is already promoted; "Play this next"
 * puts it first, which is the whole point of that row. The Random pool stores no order — it
 * is shuffled at playback — so `where` means nothing there and the entry simply joins it.
 *
 * OPTIMISTIC, then two writes in the order `useGridDrag` documents: `placement` FIRST, so the
 * file never says an entry is in a lane the order does not put it in, then `/order` with BOTH
 * lanes concatenated, priority first, because the file is one sequence.
 */
export async function setEntryLane(
  setId: string | null | undefined,
  item: QueueItem,
  lane: Lane,
  where: "top" | "bottom" = "bottom",
) {
  if (!setId) return

  const set = getState().data?.sets[setId]

  if (!set) return

  const defaultLane = defaultLaneOf(setId)
  const from = laneOf(setId, item)
  // Sparse, under the same rule the server writes: an entry that lands in the lane it
  // already inherits keeps saying nothing, so it goes on following the queue if the
  // queue's own default is changed later.
  const placement = lane === defaultLane ? null : lane
  const moved = set.items.find((it) => it.key === item.key)

  if (!moved) return

  moved.placement = placement
  set.items = orderAfterLaneMove(
    set.items,
    defaultLane,
    [moved.key],
    lane,
    where,
  )
  bumpRevision()

  const isMove = from !== lane

  setStatus(isMove ? "Moving…" : "Saving order…")

  try {
    if (isMove) {
      await api(
        "PATCH",
        `/api/queues/${setId}/items/${encodeURIComponent(moved.key)}/placement`,
        { placement: placement ?? "" },
      )
    }

    await api("PATCH", `/api/queues/${setId}/order`, {
      keys: set.items.map((it) => it.key),
    })
    setStatus(
      isMove
        ? lane === "priority"
          ? "Moved to the Priority queue"
          : "Moved to the Random pool"
        : "Plays next",
      "ok",
    )
  } catch (e) {
    setStatus(
      `${isMove ? "Move" : "Reorder"} failed: ${(e as Error).message}`,
      "err",
    )
    refreshData()
  }
}

/**
 * Re-sequence ONE queue's file order after a BULK lane change.
 *
 * `PATCH /api/queues/bulk` writes each entry's `placement` and nothing else, so a promoted
 * pool entry would join the Priority queue at whatever position it happened to hold in the
 * file — and the pool is displayed alphabetically, so that position is arbitrary to anyone
 * looking at the screen. This lands the whole selection at the END of the lane it moved to,
 * which is what the one-entry menu row does (`setEntryLane`, `where: "bottom"`).
 *
 * Runs AFTER the bulk apply's own `load()`, so `laneOf` reads the placements the server has
 * already written rather than the ones it is about to.
 */
export async function settleLanes(
  setId: string,
  movedKeys: string[],
  lane: Lane,
) {
  const set = getState().data?.sets[setId]

  if (!set) return

  if (!set.items.some((it) => movedKeys.includes(it.key)))
    return

  set.items = orderAfterLaneMove(
    set.items,
    defaultLaneOf(setId),
    movedKeys,
    lane,
  )
  bumpRevision()

  await api("PATCH", `/api/queues/${setId}/order`, {
    keys: set.items.map((it) => it.key),
  })
}

/** Move one entry to an explicit one-based position inside the Priority queue. */
export async function setPriorityPosition(
  setId: string,
  item: QueueItem,
  position: number,
) {
  const set = getState().data?.sets[setId]

  if (!set) return

  const next = orderAtPriorityPosition(
    set.items,
    defaultLaneOf(setId),
    item.key,
    position,
  )

  if (next === set.items) return

  set.items = next
  bumpRevision()
  setStatus("Saving Priority position…")

  try {
    await api("PATCH", `/api/queues/${setId}/order`, {
      keys: next.map((entry) => entry.key),
    })
    setStatus(
      `Moved to Priority position ${position}`,
      "ok",
    )
  } catch (error) {
    setStatus(
      `Reorder failed: ${(error as Error).message}`,
      "err",
    )
    refreshData()
  }
}
