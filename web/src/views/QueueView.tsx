import {
  Badge,
  EmptyState,
  SegmentedControl,
} from "@charcuterie/ui"
import { useRef, useState } from "react"
import { TypeBadge } from "../components/badges"
import {
  EntryEditor,
  PLEX_WORDS,
  SettingTags,
} from "../components/EntrySettings"
import {
  isPullSet,
  OpenQueueButton,
} from "../components/OpenQueueButton"
import { Poster } from "../components/Poster"
import { PosterTile } from "../components/PosterTile"
import { SearchDropdown } from "../components/SearchDropdown"
import { SelectListbox } from "../components/SelectListbox"
import { Tip } from "../components/Tip"
import { useFlipList } from "../hooks/useFlipList"
import { useGridDrag } from "../hooks/useGridDrag"
import { api } from "../lib/api"
import { flashTile } from "../lib/flip"
import { activeSet, isPlayingItem } from "../lib/nowPlaying"
import {
  byTitle,
  isStartable,
  progressLabel,
  tileFace,
} from "../lib/tileFace"
import type { QueueItem, SearchHit } from "../lib/types"
import { refreshData } from "../state/live"
import {
  closeEntryEditor,
  type EntryActions,
  openEntryEditor,
  openPlayMenu,
  openSetModal,
  openStartModal,
  openTileMenu,
  useOverlays,
} from "../state/overlays"
import {
  applyFilters,
  type Density,
  useQueueView,
} from "../state/queueView"
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

/**
 * The queue key a search hit WOULD have — the same identity the server stores, so a hit can be
 * matched against the entries already in the queue. Collections are addressed by title (they
 * have no stable per-queue ratingKey in the file), everything else by ratingKey.
 */
const keyOfHit = (hit: SearchHit) =>
  hit.type === "collection"
    ? `title:Collection: ${hit.title}`
    : `rk:${hit.ratingKey}`

/** Is a hit's release year inside one of the add box's bands? An unknown year matches none. */
function inYearBand(
  year: number | null | undefined,
  band: string,
) {
  if (!year) return false
  if (band === "2020s") return year >= 2020
  if (band === "2010s") return year >= 2010 && year <= 2019
  if (band === "2000s") return year >= 2000 && year <= 2009
  if (band === "older") return year < 2000
  return true
}

/**
 * A hit's watch state, from what the section listing already carries — no extra request. A
 * MOVIE reports its own `viewCount`/`viewOffset`; a SHOW reports the aggregate
 * `viewedLeafCount` / `leafCount`. A collection reports neither, so it is always "unknown"
 * and drops out of a state-filtered search rather than pretending to be unwatched.
 */
function watchState(hit: SearchHit): string {
  if (hit.type === "movie") {
    if ((hit.viewCount ?? 0) > 0) return "watched"
    return (hit.viewOffset ?? 0) > 0
      ? "inprogress"
      : "unwatched"
  }
  if (hit.type === "show") {
    const seen = hit.viewedLeafCount ?? 0
    const total = hit.leafCount ?? 0
    if (!total) return "unknown"
    if (seen === 0) return "unwatched"
    return seen >= total ? "watched" : "inprogress"
  }
  return "unknown"
}

/** An instant, un-resolved stand-in for a just-added search hit. */
function optimisticItem(hit: SearchHit): QueueItem {
  const isCollection = hit.type === "collection"

  return {
    childCount: isCollection
      ? (hit.childCount ?? null)
      : null,
    done: false,
    episodes: 1,
    weight: 1,
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
  const { data, now, reg } = useStore()
  const selected = useSelected()
  const gridRef = useRef<HTMLUListElement>(null)
  const lastPaintedSet = useRef<string | null>(null)
  const [addPosition, setAddPosition] = useState("top")
  // Density + filter, remembered per queue (state/queueView.ts).
  const view = useQueueView(setId)
  const { entryEditor } = useOverlays()
  // The add box's own filters. NOT persisted: they belong to the search you are running right
  // now, and a stale "Movies only" silently hiding shows the next time you open the box is the
  // exact failure the queue filter's always-visible count exists to prevent.
  const [searchType, setSearchType] = useState("")
  const [searchLibrary, setSearchLibrary] = useState("")
  const [searchYear, setSearchYear] = useState("")
  const [searchState, setSearchState] = useState("")
  const [hideQueued, setHideQueued] = useState(false)

  const q = setId ? data?.sets[setId] : undefined
  // The REGISTRY entry (not the queue contents) — it carries `delivery`, which decides
  // whether this queue is pushed at a device or opened by a link.
  const regSet = setId
    ? reg?.sets.find((x) => x.id === setId)
    : undefined
  const isChannel = q?.kind === "anime"
  // Pushed at a device, or opened by a link. Decides the whole start affordance — the
  // queue-level button AND every tile's ▶.
  const isPull = isPullSet(regSet)
  // The provider's own words. Falls back to Plex's so a registry response that predates
  // `vocabulary` renders exactly as it used to rather than rendering "undefined".
  const vocab = regSet?.vocabulary ?? PLEX_WORDS
  const verb = vocab.verb

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
  const allItems = !q
    ? []
    : isChannel
      ? [...q.items].sort(byTitle)
      : q.items

  // The libraries this queue actually draws from — the only ones its search can return, so
  // offering the whole server's list would be four dead options out of five.
  const libraryOptions = (reg?.libraries ?? [])
    .filter((l) => (regSet?.sections ?? []).includes(l.id))
    .map((l) => ({ label: l.title, value: String(l.id) }))

  // Entry keys already in this queue, for the add box's "already here" answer. An object rather
  // than a Set so it can be built inline without a memo; the lists are dozens of entries.
  const queuedKeys: Record<string, true> = {}
  for (const it of allItems) queuedKeys[it.key] = true

  // What you SEE: the queue narrowed by this queue's own filter. `allItems` stays the truth for
  // anything that must not lie about the queue's contents — the duplicate check when adding,
  // the "Remove all completed" affordance, and the "showing N of M" count.
  const items = applyFilters(allItems, view.filters)

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
    setId,
    save: (start) =>
      api(
        "PATCH",
        `/api/queues/${setId}/items/${encodeURIComponent(item.key)}/start`,
        { start },
      ),
  })

  return (
    <main
      className={`view editable${selected.size ? " move-mode" : ""}`}
      // The whole queue page wears its provider's accent — every ▶, ring, count and badge
      // under here is about THIS queue, so all of it is that service's colour. Page chrome
      // that belongs to no queue stays Charcuterie because it sits outside this element.
      // (decision `2026-08-15-a-queue-wears-its-providers-colour`)
      data-provider={regSet?.provider_kind || undefined}
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

            // The filters are applied HERE rather than as query parameters because
            // /api/search has no notion of them; it answers "what matches, in this set's
            // libraries". Narrowing its answer is the editor's job, and doing it in one place
            // keeps the row renderer dumb.
            const filtered = results.filter((hit) => {
              if (searchType && hit.type !== searchType)
                return false
              if (
                searchLibrary &&
                String(hit.sectionId) !== searchLibrary
              ) {
                return false
              }
              if (
                hideQueued &&
                keyOfHit(hit) in queuedKeys
              ) {
                return false
              }
              if (
                searchYear &&
                !inYearBand(hit.year, searchYear)
              ) {
                return false
              }
              if (
                searchState &&
                watchState(hit) !== searchState
              ) {
                return false
              }
              return true
            })

            // Anything already in this queue sorts FIRST and is never offered as an add: the
            // question "is this already in here?" is most of why you search a queue you have
            // been curating for months, and the old box answered it by silently doing nothing
            // when you picked a duplicate.
            return [
              ...filtered.filter(
                (h) => keyOfHit(h) in queuedKeys,
              ),
              ...filtered.filter(
                (h) => !(keyOfHit(h) in queuedKeys),
              ),
            ]
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
            const queuedKey = keyOfHit(hit)
            const isQueued = queuedKey in queuedKeys

            // Already here: picking it takes you TO the entry and opens its settings, rather
            // than adding a duplicate (which the server would refuse) or removing it (which
            // nobody asked for by typing a title into an "Add" box).
            if (isQueued) {
              return {
                className: "queued",
                content: (
                  <>
                    <Poster
                      cover={hit.cover}
                      fallback={
                        <span
                          aria-hidden="true"
                          className="noposter"
                        />
                      }
                      // A collection with no artwork of its own has nothing to ask for.
                      ratingKey={
                        isCollection && !hit.hasThumb
                          ? null
                          : hit.ratingKey
                      }
                    />
                    <span>
                      {hit.title}{" "}
                      <span className="y">
                        {hit.year || ""}
                      </span>{" "}
                      <span className="collbadge">
                        In this queue
                      </span>
                    </span>
                  </>
                ),
                pick: () => {
                  close()
                  if (!setId) return
                  // Clear any filter hiding it, or "jump to" would scroll to nothing.
                  if (
                    !items.some(
                      (it) => it.key === queuedKey,
                    )
                  ) {
                    view.resetFilters()
                  }
                  flashTile(setId, queuedKey)
                  document
                    .querySelector(
                      `#grid [data-key="${CSS.escape(queuedKey)}"]`,
                    )
                    ?.scrollIntoView({
                      block: "center",
                      behavior: "smooth",
                    })
                  openEntryEditor(setId, queuedKey)
                },
              }
            }

            return {
              content: (
                <>
                  <Poster
                    cover={hit.cover}
                    fallback={
                      <span
                        aria-hidden="true"
                        className="noposter"
                      />
                    }
                    // A collection with no artwork of its own has nothing to ask for.
                    ratingKey={
                      isCollection && !hit.hasThumb
                        ? null
                        : hit.ratingKey
                    }
                  />
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
            Type
            <SelectListbox
              id="searchtype"
              label="Result type"
              onChange={setSearchType}
              options={[
                { label: "Anything", value: "" },
                { label: "Series", value: "show" },
                { label: "Movies", value: "movie" },
                {
                  label: "Collections",
                  value: "collection",
                },
              ]}
              value={searchType}
            />
          </label>
          <label className="addpos">
            Library
            <SelectListbox
              id="searchlib"
              label="Library"
              onChange={setSearchLibrary}
              options={[
                { label: "All libraries", value: "" },
                ...libraryOptions,
              ]}
              value={searchLibrary}
            />
          </label>
          <label className="addpos">
            Year
            <SelectListbox
              id="searchyear"
              label="Release year"
              onChange={setSearchYear}
              options={[
                { label: "Any year", value: "" },
                { label: "2020 – now", value: "2020s" },
                { label: "2010 – 2019", value: "2010s" },
                { label: "2000 – 2009", value: "2000s" },
                { label: "Before 2000", value: "older" },
              ]}
              value={searchYear}
            />
          </label>
          <label className="addpos">
            State
            <SelectListbox
              id="searchstate"
              label="Watch state"
              onChange={setSearchState}
              options={[
                { label: "Any state", value: "" },
                { label: "Unwatched", value: "unwatched" },
                {
                  label: "In progress",
                  value: "inprogress",
                },
                { label: "Watched", value: "watched" },
              ]}
              value={searchState}
            />
          </label>
          <label className="addpos addcheck">
            <input
              checked={hideQueued}
              onChange={(e) =>
                setHideQueued(e.target.checked)
              }
              type="checkbox"
            />
            Hide what&rsquo;s already here
          </label>
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
          {isPull ? (
            // No device to cast to — hand back the launcher URL instead.
            <OpenQueueButton set={regSet!} />
          ) : (
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
          )}
        </SearchDropdown>
      </div>

      {/* The queue's OWN toolbar: how it is displayed, and which of its entries are shown.
          Deliberately not in the add box above — that box reaches out to Plex, this row only
          ever narrows what is already here, and conflating the two is what made "filter" and
          "search" feel like one broken control. */}
      <div className="qtoolbar" id="qtoolbar">
        <input
          aria-label="Filter this queue"
          className="qfilter"
          id="qfilter"
          onChange={(e) =>
            view.setFilters({ text: e.target.value })
          }
          placeholder="Filter this queue…"
          type="search"
          value={view.filters.text}
        />
        <SelectListbox
          id="qfiltertype"
          label="Type"
          onChange={(v) =>
            view.setFilters({
              type: v as typeof view.filters.type,
            })
          }
          options={[
            { label: "Any type", value: "" },
            { label: "Series", value: "show" },
            { label: "Movies", value: "movie" },
            { label: "Collections", value: "collection" },
          ]}
          size="sm"
          value={view.filters.type}
        />
        <SelectListbox
          id="qfilterstate"
          label="State"
          onChange={(v) =>
            view.setFilters({
              state: v as typeof view.filters.state,
            })
          }
          options={[
            { label: "Any state", value: "" },
            {
              label: "Completed / fully watched",
              value: "done",
            },
            {
              label: "Still has something to play",
              value: "active",
            },
            { label: "Has overrides", value: "overrides" },
            {
              label: "Weighted above 1x",
              value: "weighted",
            },
            { label: "Has a start point", value: "start" },
          ]}
          size="sm"
          value={view.filters.state}
        />
        <SelectListbox
          id="qsort"
          label="Sort"
          onChange={(v) =>
            view.setFilters({
              sort: v as typeof view.filters.sort,
            })
          }
          options={[
            // A CHANNEL has no play order to preserve — its members are shuffled, and the
            // grid already lists them alphabetically for lookup — so its "stored order"
            // option IS A→Z, and offering a second A→Z entry would be two options with the
            // same value.
            ...(isChannel
              ? [
                  {
                    label: "A → Z (playback is random)",
                    value: "queue",
                  },
                ]
              : [
                  { label: "Queue order", value: "queue" },
                  { label: "A → Z", value: "title" },
                ]),
            {
              label: "Weight, high first",
              value: "weight",
            },
          ]}
          size="sm"
          value={view.filters.sort}
        />
        {/* Always visible while anything is filtered, and it says how many entries are hidden:
            a filter you forgot you set is indistinguishable from a queue that lost its
            contents. */}
        {view.isFiltered ? (
          <button
            className="ghost"
            id="qfilterclear"
            onClick={view.resetFilters}
            type="button"
          >
            {`Clear filters — showing ${items.length} of ${allItems.length}`}
          </button>
        ) : (
          <span className="qcount">
            {`${allItems.length} ${allItems.length === 1 ? "entry" : "entries"}`}
          </span>
        )}
        <span className="qtoolbar-right">
          {/* A radiogroup names itself through `label`, so the visible text is the options
              themselves — see ProviderBlock for the same reasoning. */}
          <SegmentedControl
            items={[
              { label: "Posters", value: "posters" },
              { label: "Cards", value: "cards" },
              // "List", not "Rows" — the owner's word for it. The stored value stays
              // `rows` so every persisted per-queue density (and the `ul.grid.rows`
              // selectors + e2e reads) keeps working; only the label is the owner's.
              { label: "List", value: "rows" },
            ]}
            label="View"
            onChange={(v) =>
              view.setDensity((v ?? "cards") as Density)
            }
            selectedValue={view.density}
          />
        </span>
      </div>

      <ul
        className={`grid ${view.density}`}
        id="grid"
        ref={gridRef}
      >
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
                        intent="success"
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
                        intent="info"
                        size="sm"
                      >
                        {now.now?.state === "paused"
                          ? "Paused"
                          : "Now playing"}
                      </Badge>
                    ) : null}
                    {/* The per-entry settings are TAGS now, not four controls per tile: a
                        default entry says nothing, and every tag you do see is a deviation
                        worth reading. Clicking one (or Edit) opens the panel that changes
                        them. Same markup in all three densities, which is what lets the
                        poster wall carry the information at all.
                        (decision 2026-08-14-entry-settings-are-tags-plus-a-panel) */}
                    {item.resolved ? (
                      <SettingTags
                        item={item}
                        onEdit={() =>
                          setId &&
                          openEntryEditor(setId, item.key)
                        }
                        vocab={vocab}
                      />
                    ) : null}
                    {item.resolved && setId ? (
                      <Tip
                        label={`${vocab.units[0]?.toUpperCase()}${vocab.units.slice(1)} per turn, weight, where the batch stops, start point`}
                      >
                        <button
                          className="badge tagbtn editbtn"
                          onClick={() =>
                            openEntryEditor(setId, item.key)
                          }
                          type="button"
                        >
                          Edit
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
                // Only a RESOLVED entry can be played: an unresolved one has no library item
                // behind it, so the server would reject the start after the device menu had
                // already asked which TV. No ▶ is a clearer answer than a late error.
                //
                // PUSH only. A pull queue has no device to name, so its tile gets a link
                // (`playHref` below) instead of the device menu — which used to offer the
                // Shield, Plex Dash and a phone for a manga chapter.
                onPlay={
                  setId && item.resolved && !isPull
                    ? (anchor) =>
                        openPlayMenu({
                          anchor,
                          kind: undefined,
                          only: item.key,
                          onlyLabel: face.title,
                          setId,
                        })
                    : undefined
                }
                onRemove={() => removeTile(item)}
                // "Read THIS one now": rebuild the reading list around this one entry and
                // 302 into the reader. The pull counterpart of the play-one-entry key.
                playHref={
                  setId && item.resolved && isPull
                    ? `/go/${encodeURIComponent(setId)}?only=${encodeURIComponent(item.key)}`
                    : undefined
                }
                playTitle={`${verb} “${face.title}” now`}
                posterCover={item.cover}
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

      {/* One panel for the whole grid, addressed by entry key — see state/overlays.ts for why
          it holds the key rather than the item. */}
      <EntryEditor
        entryFor={entryFor}
        isOpen={Boolean(
          entryEditor && entryEditor.setId === setId,
        )}
        itemKey={entryEditor?.key ?? null}
        onClose={closeEntryEditor}
        setId={setId}
      />
    </main>
  )
}
