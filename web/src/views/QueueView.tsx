import { Badge, EmptyState } from "@charcuterie/ui"
import { useRef, useState } from "react"
import { TypeBadge } from "../components/badges"
import { PosterTile } from "../components/PosterTile"
import { SearchDropdown } from "../components/SearchDropdown"
import { SelectListbox } from "../components/SelectListbox"
import { Tip } from "../components/Tip"
import { useFlipList } from "../hooks/useFlipList"
import { useGridDrag } from "../hooks/useGridDrag"
import { api, thumbUrl } from "../lib/api"
import { flashTile } from "../lib/flip"
import { activeSet, isPlayingItem } from "../lib/nowPlaying"
import {
  byTitle,
  isStartable,
  progressLabel,
  startLabel,
  tileFace,
} from "../lib/tileFace"
import type { QueueItem, SearchHit } from "../lib/types"
import { refreshData } from "../state/live"
import {
  type EntryActions,
  openPlayMenu,
  openSetModal,
  openStartModal,
  openTileMenu,
} from "../state/overlays"
import {
  deselect,
  toggleSelect,
  useSelected,
} from "../state/selection"
import {
  bumpRevision,
  getState,
  load,
  setStatus,
  useStore,
} from "../state/store"

/**
 * QUEUE — one set as a wrapped poster grid.
 *
 * Queues reorder and move; anime CHANNELS use the same grid as a membership editor
 * with no ordering at all, and list alphabetically for lookup (random playback ⇒
 * the stored order is lookup-only). Display-only: the stored order is untouched.
 *
 * Both mutations are OPTIMISTIC, because the resolve round-trip is ~1.5 s and the
 * grid used to freeze for all of it:
 *
 * - **Add** drops a stand-in tile in immediately (poster + title come straight from
 *   the search hit) and lets the background refresh swap it for the resolved entry.
 * - **Remove** pulls the tile now and DELETEs behind it; FLIP slides the neighbours
 *   up to close the gap.
 *
 * A failure re-syncs from the server, so an optimistic tile can never linger.
 */

/** An instant, un-resolved stand-in for a just-added search hit. */
function optimisticItem(hit: SearchHit): QueueItem {
  const isCollection = hit.type === "collection"

  return {
    childCount: isCollection
      ? (hit.childCount ?? null)
      : null,
    done: false,
    episodes: 1,
    key: isCollection
      ? `title:Collection: ${hit.title}`
      : `rk:${hit.ratingKey}`,
    nextEp: null,
    ratingKey: hit.ratingKey,
    resolved: true,
    start: null,
    title: hit.title,
    type: isCollection ? "collection" : hit.type,
    year: hit.year || null,
  }
}

export function QueueView({
  isHidden,
  setId,
}: {
  isHidden: boolean
  setId: string | null
}) {
  const { data, now } = useStore()
  const selected = useSelected()
  const gridRef = useRef<HTMLUListElement>(null)
  const lastPaintedSet = useRef<string | null>(null)
  const [addPosition, setAddPosition] = useState("top")

  const q = setId ? data?.sets[setId] : undefined
  const isChannel = q?.kind === "anime"

  useGridDrag(gridRef, setId, Boolean(isChannel))

  // A CHANNEL's members play in random order, so the grid lists them
  // alphabetically for lookup; a queue keeps its hand order (top plays next).
  // Display-only — the stored order is untouched.
  //
  // Deliberately NOT memoised on `q`. An optimistic add/remove mutates the set IN
  // PLACE and republishes the snapshot, so `q`'s identity never changes — a
  // `useMemo(…, [q])` here returned the stale array and the "optimistic" tile only
  // appeared when the background refetch landed ~400 ms later, which is exactly the
  // freeze the optimistic path exists to remove. Sorting a few dozen entries per
  // render costs nothing; being wrong costs the whole feature.
  const items = !q
    ? []
    : isChannel
      ? [...q.items].sort(byTitle)
      : q.items

  // FLIP only when re-rendering the SAME queue (add/remove/reconcile/live-update) —
  // opening a different queue is a plain first paint, not a shuffle of the current
  // one.
  const isSamePaint = lastPaintedSet.current === setId

  useFlipList(
    gridRef,
    `${setId}:${items.map((i) => i.key).join("|")}`,
    !isHidden && isSamePaint,
  )

  if (!isHidden && setId) lastPaintedSet.current = setId

  const playingSet = activeSet(now, data)

  const removeTile = (item: QueueItem) => {
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

  const entryFor = (item: QueueItem): EntryActions => ({
    item,
    refresh: () => refreshData(),
    remove: () => removeTile(item),
    removeLabel: "Remove from this queue",
    save: (start) =>
      api(
        "PATCH",
        `/api/queues/${setId}/items/${encodeURIComponent(item.key)}/start`,
        { start },
      ),
  })

  const setEpisodes = async (
    item: QueueItem,
    episodes: number,
  ) => {
    setStatus("Saving…")

    try {
      await api(
        "PATCH",
        `/api/queues/${setId}/items/${encodeURIComponent(item.key)}/episodes`,
        { episodes },
      )

      const set = getState().data?.sets[setId!]
      const hit = set?.items.find(
        (it) => it.key === item.key,
      )

      if (hit) {
        hit.episodes = episodes
        bumpRevision()
      }

      setStatus("Saved", "ok")
    } catch (e) {
      setStatus(
        `Save failed: ${(e as Error).message}`,
        "err",
      )
    }
  }

  return (
    <main
      className={`view editable${selected.size ? " move-mode" : ""}`}
      hidden={isHidden}
      id="queue"
    >
      <div className="add">
        <SearchDropdown<SearchHit>
          doSearch={async (text) => {
            // Opt into Collection results — `collections=1` is additive; the scoped
            // add box is where "play a collection in order" is composed.
            const { results } = await api<{
              results: SearchHit[]
            }>(
              "GET",
              `/api/search?set=${setId}&q=${encodeURIComponent(text)}&collections=1`,
            )

            return results
          }}
          inputId="search"
          listId="results"
          // The noun matches the family: a curated channel is not a "queue".
          placeholder={
            isChannel
              ? "Add — search this channel's libraries…"
              : "Add — search this queue's libraries…"
          }
          rowFor={(hit, _index, close) => {
            const isCollection = hit.type === "collection"
            const label = isCollection
              ? hit.title
              : `${hit.title}${hit.year ? ` (${hit.year})` : ""}`

            return {
              content: (
                <>
                  {!isCollection || hit.hasThumb ? (
                    <img
                      alt=""
                      src={thumbUrl(hit.ratingKey)}
                    />
                  ) : (
                    <span
                      aria-hidden="true"
                      className="noposter"
                    />
                  )}
                  <span>
                    {hit.title}{" "}
                    {isCollection ? (
                      <>
                        <span className="collbadge">
                          Collection
                        </span>{" "}
                        <span className="y">{`${hit.childCount || 0} items`}</span>
                      </>
                    ) : (
                      <span className="y">
                        {hit.year || ""}
                      </span>
                    )}
                  </span>
                </>
              ),
              pick: async () => {
                close()

                if (!setId) return

                const set = getState().data?.sets[setId]

                if (!set) return

                const optimistic = optimisticItem(hit)
                const isDuplicate = set.items.some(
                  (it) => it.key === optimistic.key,
                )

                if (!isDuplicate) {
                  set.items =
                    addPosition === "bottom"
                      ? [...set.items, optimistic]
                      : [optimistic, ...set.items]
                  bumpRevision()
                  flashTile(setId, optimistic.key)
                }

                setStatus(
                  isDuplicate
                    ? `Already here — “${hit.title}”`
                    : `Added “${hit.title}”`,
                  "ok",
                )

                try {
                  const body: Record<string, unknown> = {
                    position: addPosition,
                  }

                  if (isCollection) {
                    body.value = hit.title
                    body.type = "collection"
                  } else {
                    body.value = {
                      ratingKey: hit.ratingKey,
                      title: label,
                    }
                  }

                  await api(
                    "POST",
                    `/api/queues/${setId}/items`,
                    body,
                  )
                  // Background, non-blocking: swap the stand-in for the resolved
                  // entry (its poster + ratingKey already resolve, so only nextEp
                  // fills in later).
                  refreshData()
                } catch (e) {
                  setStatus(
                    `Add failed: ${(e as Error).message}`,
                    "err",
                  )
                  refreshData() // re-sync so a failed optimistic tile can't linger
                }
              },
            }
          }}
        >
          <label className="addpos">
            Add to
            <SelectListbox
              id="addpos"
              label="Add to"
              onChange={setAddPosition}
              options={[
                { label: "Top (plays next)", value: "top" },
                { label: "Bottom", value: "bottom" },
              ]}
              value={addPosition}
            />
          </label>
          {/* Actions live on the right (the search grows to push them there). */}
          <button
            className="ghost"
            hidden={!items.some((it) => it.done)}
            id="qremovedone"
            onClick={async () => {
              if (!setId) return

              setStatus("Removing completed…")

              try {
                const out = await api<{ removed?: number }>(
                  "POST",
                  `/api/queues/${setId}/remove-completed`,
                )

                setStatus(
                  `Removed ${out.removed ?? 0} completed`,
                  "ok",
                )
                await load()
              } catch (e) {
                setStatus(
                  `Remove failed: ${(e as Error).message}`,
                  "err",
                )
              }
            }}
            type="button"
          >
            Remove all completed
          </button>
          <Tip label="Configure this set">
            <button
              className="ghost"
              id="qconfigure"
              onClick={() => setId && openSetModal(setId)}
              type="button"
            >
              ⚙ Configure
            </button>
          </Tip>
          <button
            className="playbtn"
            id="qplay"
            onClick={(e) =>
              setId &&
              openPlayMenu({
                anchor:
                  e.currentTarget.getBoundingClientRect(),
                setId,
              })
            }
            type="button"
          >
            ▶ Play on ▾
          </button>
        </SearchDropdown>
      </div>

      <ul className="grid" id="grid" ref={gridRef}>
        {isHidden || !q ? null : items.length === 0 ? (
          <li className="empty">
            <EmptyState
              description="Search above to add something."
              heading="Empty"
              headingLevel={3}
              size="sm"
            />
          </li>
        ) : (
          items.map((item) => {
            const face = tileFace(item)
            const isPlaying =
              setId === playingSet &&
              isPlayingItem(now, item)
            const entry = entryFor(item)

            return (
              <PosterTile
                badges={
                  <>
                    <TypeBadge face={face} item={item} />
                    {/* "In Progress" wins over "Completed": a mid-episode resume point
                            (Plex viewOffset, unwatched) means the item is being watched, not
                            finished — the Prison School OAD case must never read "Completed". */}
                    {item.partiallyWatched ? (
                      <Tip
                        label={progressLabel(
                          item.viewOffset,
                          item.duration,
                        )}
                      >
                        <Badge
                          appearance="outline"
                          className="badge progressbadge"
                          intent="accent"
                          size="sm"
                        >
                          In Progress
                        </Badge>
                      </Tip>
                    ) : item.done ? (
                      <Badge
                        appearance="outline"
                        className="badge donebadge"
                        intent="neutral"
                        size="sm"
                      >
                        Completed
                      </Badge>
                    ) : null}
                    {/* Solid, not outline: this one has to win against the
                            type and Completed chips beside it. Green rather than
                            amber so it never reads as the selection outline. */}
                    {isPlaying ? (
                      <Badge
                        appearance="solid"
                        className="badge playingbadge"
                        intent="success"
                        size="sm"
                      >
                        {now.now?.state === "paused"
                          ? "Paused"
                          : "Now playing"}
                      </Badge>
                    ) : null}
                    {/* Per-show episodes-per-play control. The dropdown speaks
                            for itself ("1 ep"), so it carries no "Play" label —
                            that was pure tile noise (decision
                            2026-07-31-collection-tiles-are-member-first). */}
                    {item.resolved &&
                    item.type === "show" ? (
                      <Tip label="Episodes queued per play">
                        <label className="eps">
                          {/* Keyed on the SERVER's value, because that is
                                    who owns it: the pick round-trips through a
                                    PATCH and can also arrive from another device
                                    over SSE. Unkeyed, an uncontrolled select would
                                    keep a value the PATCH rejected and would never
                                    hear a change made elsewhere. */}
                          <SelectListbox
                            key={String(item.episodes || 1)}
                            label="Episodes queued per play"
                            onChange={(v) =>
                              void setEpisodes(
                                item,
                                Number(v),
                              )
                            }
                            options={[1, 2, 3, 4, 5, 6].map(
                              (i) => ({
                                label:
                                  i === 1
                                    ? "1 ep"
                                    : `${i} eps`,
                                value: String(i),
                              }),
                            )}
                            size="sm"
                            value={String(
                              item.episodes || 1,
                            )}
                          />
                        </label>
                      </Tip>
                    ) : null}
                    {/* An entry that HAS an override wears one amber chip,
                            which is also a button back into the picker. */}
                    {item.start ? (
                      <Tip
                        label={`Manual start point${
                          item.nextEp?.startMember
                            ? ` — begins at “${item.nextEp.startMember}”`
                            : ""
                        }. Click to change it or go back to automatic.`}
                      >
                        <button
                          className="badge startbadge"
                          onClick={() =>
                            openStartModal(entry)
                          }
                          type="button"
                        >
                          {startLabel(item.start)}
                        </button>
                      </Tip>
                    ) : null}
                  </>
                }
                className={[
                  // See QueuesView: a pending tile has not claimed to be missing.
                  item.resolved || item.pending
                    ? null
                    : "unresolved",
                  item.done ? "done" : null,
                  isPlaying ? "playing" : null,
                  setId &&
                  selected.has(`${setId}::${item.key}`)
                    ? "selected"
                    : null,
                ]
                  .filter(Boolean)
                  .join(" ")}
                dataKey={item.key}
                dataSet={setId ?? undefined}
                isPending={item.pending}
                key={item.key}
                next={{
                  isDone: face.nextDone,
                  onStart: isStartable(item)
                    ? () => openStartModal(entry)
                    : undefined,
                  text: face.next,
                  tooltip: `${
                    face.from && item.childCount != null
                      ? `${face.next} — ${item.childCount} in order`
                      : face.next
                  }${
                    isStartable(item)
                      ? `\nTap to choose where this ${
                          item.type === "collection"
                            ? "collection"
                            : "show"
                        } starts`
                      : ""
                  }`,
                }}
                onCheck={() =>
                  setId && toggleSelect(setId, item.key)
                }
                onContextMenu={(e) => {
                  e.preventDefault()
                  openTileMenu(e.clientX, e.clientY, entry)
                }}
                onRemove={() => removeTile(item)}
                posterRatingKey={
                  item.resolved ? face.ratingKey : null
                }
                title={
                  face.title +
                  (face.year ? ` (${face.year})` : "")
                }
                titleTooltip={
                  face.from
                    ? `${face.fullTitle || face.title} — from the “${face.from}” collection`
                    : face.title +
                      (face.year ? ` (${face.year})` : "")
                }
              />
            )
          })
        )}
      </ul>
    </main>
  )
}
