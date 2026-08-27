import { mergeRefs, useFlipList } from "@charcuterie/logic"
import {
  Badge,
  BadgeButton,
  Button,
  Checkbox,
  EmptyState,
  SegmentedControl,
} from "@charcuterie/ui"
import { useRef, useState } from "react"
import {
  EditionChip,
  TypeBadge,
} from "../components/badges"
import { EditionBadge } from "../components/EditionBadge"
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
import {
  PencilGlyph,
  PosterTile,
} from "../components/PosterTile"
import { SearchDropdown } from "../components/SearchDropdown"
import { SelectListbox } from "../components/SelectListbox"
import { SkippedPanel } from "../components/SkippedPanel"
import { Tip } from "../components/Tip"
import { useGridDrag } from "../hooks/useGridDrag"
import { api } from "../lib/api"
import { flashTile } from "../lib/flip"
import { isRandomOrder } from "../lib/kind"
import { activeSet, isPlayingItem } from "../lib/nowPlaying"
import { entryTitle } from "../lib/searchGroups"
import {
  isCompleted,
  isStartable,
  progressLabel,
  runtimeLabel,
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
  moveEntryLane,
  queueEntryActions,
  removeQueueItem,
} from "../state/queueEntry"
import {
  applyFilters,
  type Density,
  splitLanes,
  useQueueView,
} from "../state/queueView"
import {
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
    episodes: null,
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
  setId,
}: {
  setId: string | null
}) {
  const { data, now, reg } = useStore()
  const selected = useSelected()
  const lanesRef = useRef<HTMLDivElement>(null)
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
  // Prefer the registry row when present — it always carries effective add_as.
  // The queues payload may still be the shelves skeleton for a beat.
  // The queue's OWN default lane — what an entry with no `placement` of its own means.
  // `isRandomOrder` already tolerates a registry row carrying only a legacy kind, so this
  // is that one answer named as a lane rather than as a boolean about order.
  const isChannel = isRandomOrder(regSet ?? q)
  const setLane = isChannel ? "random" : "priority"
  // Pushed at a device, or opened by a link. Decides the whole start affordance — the
  // queue-level button AND every tile's ▶.
  const isPull = isPullSet(regSet)
  // The provider's own words. Falls back to Plex's so a registry response that predates
  // `vocabulary` renders exactly as it used to rather than rendering "undefined".
  const vocab = regSet?.vocabulary ?? PLEX_WORDS
  const verb = vocab.verb

  // The fourth argument is the poster tap: with no selection running, tapping a poster
  // opens that entry's sheet. See the hook for why the gesture is resolved there.
  // The CONTAINER, not a lane: the gesture spans both `ul.grid[data-lane]` under it,
  // because a drag across the divider is how an entry is promoted or demoted.
  useGridDrag(lanesRef, setId, setLane, openEntryEditor)

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
  // FILE order, always. The page-wide alphabetical sort a random-order set used to get
  // here moved INTO the pool lane (`splitLanes`): it was never true of the whole page once
  // half of it is a Priority queue whose order is the thing being edited.
  const allItems = q ? q.items : []

  // The libraries this queue actually draws from — the only ones its search can return, so
  // offering the whole server's list would be four dead options out of five. A queue that
  // names NONE draws from all of them (decision
  // `2026-08-17-no-libraries-checked-means-every-library`), so the filter is skipped
  // entirely rather than narrowing the dropdown to nothing.
  const queueSections = regSet?.sections ?? []
  const libraryOptions = (reg?.libraries ?? [])
    .filter(
      (l) =>
        !queueSections.length ||
        queueSections.includes(l.id),
    )
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

  // THE SPLIT. One stored list, drawn as two lanes — an entry's lane is its own
  // `placement`, else the queue's `add_as` (`state/queueView.splitLanes`).
  const lanes = splitLanes(items, setLane)

  /*
   * FLIP is `@charcuterie/logic`'s now, not this repo's.
   *
   * There were two copies of this in the fleet — queuepilot's
   * `hooks/useFlipList.ts` and the one Docket needed — so the shape
   * moved to the library and this app adopts it. `lib/flip.ts` STAYS:
   * `flipMove` wraps a DRAG's own DOM mutation, transforms existing
   * nodes without re-rendering, and is what keeps the mid-drag
   * duplication bug from coming back. The library has no equivalent
   * and this is not that animation.
   *
   * `keyAttribute` points at the `data-key` these tiles have always
   * carried rather than emitting a second attribute with the same
   * value in it; `itemSelector` moves with it, because the library's
   * default looks for `data-flip-key`.
   *
   * The ref is MERGED rather than replacing `gridRef`: `useGridDrag`
   * claimed that ref first, and the drag needs the same element.
   */
  const flipRef = useFlipList<HTMLDivElement>({
    isAnimating: isSamePaint,
    itemSelector: "li.tile",
    keyAttribute: "data-key",
    // Each entry's LANE rides in the signature. Without it a move whose only effect is
    // which half a tile sits in does not read as a change, and the tile teleports across
    // the divider instead of gliding.
    signature: `${setId}:${[
      ...lanes.priority,
      ...lanes.random,
    ]
      .map((i) => `${i.key}@${i.placement ?? setLane}`)
      .join("|")}`,
  })

  if (setId) lastPaintedSet.current = setId

  const playingSet = activeSet(now, data)

  // Both live in `state/queueEntry` rather than here: the Home shelf renders the same
  // `PosterTile` and needs the same two, and a second copy of an optimistic write is a
  // second place for it to drift
  // (decision `2026-08-21-any-tile-in-an-editable-grid-gets-the-remove-control`).
  const removeTile = (item: QueueItem) =>
    removeQueueItem(setId, item)

  const entryFor = (item: QueueItem): EntryActions =>
    queueEntryActions(setId, item)

  /**
   * ONE tile, rendered the same in either lane.
   *
   * It was inline in the grid's `.map()` until the page grew a second lane. Extracted
   * VERBATIM rather than rewritten: the two lanes have to be the same tile in every
   * density, with the same chrome and the same handlers, and a copy per lane is two places
   * for that to stop being true.
   */
  const renderTile = (item: QueueItem) => {
    const face = tileFace(item)
    const isPlaying =
      setId === playingSet && isPlayingItem(now, item)
    const entry = entryFor(item)

    return (
      <PosterTile
        badges={
          <>
            <TypeBadge face={face} item={item} />
            {/* Which EDITION this is, when Plex tagged one — the only thing that
                    tells two tiles of the same film in the same year apart. */}
            <EditionChip face={face} />
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
            ) : isCompleted(item) ? (
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
                worth reading. Clicking one (or the pencil pill) opens the panel.
                The pencil sits HERE — by the labels — so it is not next to ✕.
                (decision 2026-08-14-entry-settings-are-tags-plus-a-panel;
                 decision 2026-08-25-checkmark-under-x-edit-by-the-labels) */}
            {item.resolved ? (
              <SettingTags
                item={item}
                onEdit={() =>
                  setId && openEntryEditor(setId, item.key)
                }
                vocab={vocab}
              />
            ) : null}
            {item.resolved && setId ? (
              <Tip
                label={`${vocab.units[0]?.toUpperCase()}${vocab.units.slice(1)} per turn, weight, where the batch stops, start point`}
              >
                <BadgeButton
                  appearance="outline"
                  className="badge editbtn"
                  intent="neutral"
                  onClick={() =>
                    openEntryEditor(setId, item.key)
                  }
                  size="sm"
                >
                  <PencilGlyph />
                </BadgeButton>
              </Tip>
            ) : null}
          </>
        }
        className={[
          // See QueuesView: a pending tile has not claimed to be missing.
          item.resolved || item.pending
            ? null
            : "unresolved",
          isCompleted(item) ? "done" : null,
          isPlaying ? "playing" : null,
          setId && selected.has(`${setId}::${item.key}`)
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
        isChecked={Boolean(
          setId && selected.has(`${setId}::${item.key}`),
        )}
        isPriority={
          (item.placement ?? setLane) === "priority"
        }
        onCheck={() =>
          setId && toggleSelect(setId, item.key)
        }
        // The third control in the stack: into the Priority queue, or back out to the pool.
        // The drag across the divider does the same thing and stays — this is the answer for
        // a pointer that would rather press than drag, and the only one a touch device gets
        // without a long press (owner, 2026-08-26).
        // Every queue page draws BOTH lanes, whatever its own default is — a random-order
        // queue's Priority lane is exactly where a promote goes — so this is offered on all
        // of them and gated only on there being a set to write to.
        onLane={
          setId
            ? () => void moveEntryLane(setId, item, setLane)
            : undefined
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
        // How long the next episode runs. The next-up leaf's runtime is the one Plex
        // sends for a show; a film reads its own. The batch is the entry's override,
        // else the queue's default — the same number the engine will queue.
        runtime={runtimeLabel(
          item.nextEp?.duration || item.duration,
          item.episodes ?? regSet?.episodes ?? 1,
        )}
        posterRatingKey={
          item.resolved ? face.ratingKey : null
        }
        title={
          face.title + (face.year ? ` (${face.year})` : "")
        }
        // The item's own page in Plex / Kavita. `webUrl` is absent on an unresolved
        // entry, and the tile then renders the caption as plain text.
        titleHref={item.webUrl}
        titleHrefLabel={vocab.name ?? "Plex"}
        titleTooltip={
          face.from
            ? `${face.fullTitle || face.title} — from the “${face.from}” collection`
            : face.title +
              (face.year ? ` (${face.year})` : "")
        }
      />
    )
  }

  /**
   * One lane — a heading, a count, and the grid of tiles under it.
   *
   * `data-lane` is the DRAG's handle as much as a style hook: `useGridDrag` finds the lanes
   * with `ul.grid[data-lane]` and reads the landed lane back off it, so the attribute is
   * load-bearing and must not be swapped for a class.
   *
   * An EMPTY lane renders a slim drop STRIP rather than the app's `EmptyState` box. It has
   * to render something with height: an empty `<ul>` is zero pixels tall, which leaves the
   * first promote on a fresh queue with nothing to aim at — and that is the case the whole
   * gesture exists for.
   */
  const renderLane = (
    lane: "priority" | "random",
    laneItems: QueueItem[],
  ) => {
    const isPriority = lane === "priority"

    return (
      <section className="lane" data-lane={lane}>
        <h2 className="lanehead">
          {isPriority ? "Priority queue" : "Random pool"}
          <Badge appearance="outline" size="sm">
            {laneItems.length}
          </Badge>
          <span className="lanehint">
            {isPriority
              ? "plays first, in this order — drag to reorder"
              : "drawn at random to fill the rest"}
          </span>
        </h2>
        <ul
          className={`grid ${view.density}`}
          data-lane={lane}
          id={isPriority ? "grid-priority" : "grid-pool"}
        >
          {laneItems.length === 0 ? (
            <li className="dropstrip">
              {isPriority
                ? "Drag something here to play it first"
                : "Drag something here to let it come up at random"}
            </li>
          ) : (
            laneItems.map(renderTile)
          )}
        </ul>
      </section>
    )
  }

  return (
    <main
      className={`view editable${selected.size ? " move-mode" : ""}`}
      // The whole queue page wears its provider's accent — every ▶, ring, count and badge
      // under here is about THIS queue, so all of it is that service's colour. Page chrome
      // that belongs to no queue stays Charcuterie because it sits outside this element.
      // (decision `2026-08-15-a-queue-wears-its-providers-colour`)
      data-provider={regSet?.provider_kind || undefined}
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
          // The noun matches the family: a curated POOL is not an ordered queue.
          placeholder={
            isChannel
              ? "Add — search this pool's libraries…"
              : "Add — search this queue's libraries…"
          }
          rowFor={(hit, _index, close) => {
            const isCollection = hit.type === "collection"
            // `entryTitle` appends the EDITION when Plex gave the item one. Two editions of a
            // film are two library items with the same title and the same year, so without it
            // the two rows are identical AND the two entries this box writes are stored under
            // one indistinguishable title. The pool member picker has done this since #139;
            // the queue box was simply never carried across.
            const label = entryTitle(hit)
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
                      </span>
                      <EditionBadge hit={hit} />{" "}
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
                      <>
                        <span className="y">
                          {hit.year || ""}
                        </span>
                        <EditionBadge hit={hit} />
                      </>
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
            <span className="addlbl">Type</span>
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
            <span className="addlbl">Library</span>
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
            <span className="addlbl">Year</span>
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
            <span className="addlbl">State</span>
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
          {/* The toolbar's positioning class goes on a WRAPPER, not on the Checkbox.
              Charcuterie's Checkbox IS a `<label>` with its own box-then-text layout, and
              since 2.17.0 `className` beats a component's base utilities — so putting
              `.addpos` (`display: flex`) on it replaced that layout and left the box
              stranded a hundred pixels from its own text.

              No key: this box's only writer is the user, so the uncontrolled input IS the
              store and nothing re-seeds it behind them. No `value` either — it is a lone
              boolean, not a member of a group. */}
          <div className="addpos">
            <Checkbox
              isChecked={hideQueued}
              label="Hide what’s already here"
              onChange={setHideQueued}
              size="sm"
            />
          </div>
          <label className="addpos">
            <span className="addlbl">Add to</span>
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
          {/* Charcuterie `Button`s, configured by props. `.ghost` is Charcuterie's
              `outline` — the app class paints a surface background AND a border, which is
              what `outline` means; the borderless one is Charcuterie's own `ghost`.
              (decision `2026-08-21-a-component-configured-by-props-not-a-borrowed-class`) */}
          <Button
            appearance="outline"
            // `done`, NOT `isCompleted`: this removes entries from queues.yaml, and the
            // endpoint behind it can only remove what the FILE has flagged. A live-finished
            // entry gets its flag from the next reconcile (finished.js), seconds after
            // playback ends — offering to remove it before then would do nothing.
            hidden={!items.some((it) => it.done)}
            id="qremovedone"
            intent="neutral"
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
          >
            Remove all completed
          </Button>
          <Tip label="Configure this set">
            <Button
              appearance="outline"
              id="qconfigure"
              intent="neutral"
              onClick={() => setId && openSetModal(setId)}
            >
              ⚙ Configure
            </Button>
          </Tip>
          {isPull ? (
            // No device to cast to — hand back the launcher URL instead.
            <OpenQueueButton set={regSet!} />
          ) : (
            <>
              {/* A Charcuterie `Button`, `intent="accent"` — what `.playbtn`'s solid accent skin
              painted by hand. The class STAYS as a DOM handle: `PlayMenu` asks
              `t.closest(".playbtn")` so pressing this does not close the menu it opens. */}
              <Button
                className="playbtn"
                id="qplay"
                intent="accent"
                onClick={(e) =>
                  setId &&
                  openPlayMenu({
                    anchor:
                      e.currentTarget.getBoundingClientRect(),
                    setId,
                  })
                }
              >
                ▶ Play on ▾
              </Button>
            </>
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
            {
              label: "In the Priority queue",
              value: "priority",
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
          <Button
            appearance="outline"
            id="qfilterclear"
            intent="neutral"
            onClick={view.resetFilters}
          >
            {`Clear filters — showing ${items.length} of ${allItems.length}`}
          </Button>
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

      {/* SKIPPED — between the toolbar and the grid, because that is where it is ABOUT
          something: it explains why a tile below names the episode it names. Collapsed, and
          absent entirely on a queue that has never skipped anything, so the common case pays
          nothing for it. */}
      {setId ? <SkippedPanel setId={setId} /> : null}

      {/* TWO LANES, and the drag across the divider is the promote
          (decision `2026-08-26-the-queue-page-is-two-lanes-and-the-drag-is-the-promote`).
          Both are always drawn, even when one is empty: a lane you cannot see is a lane you
          cannot drag into, and demoting off an ordered queue needs the pool to exist as a
          target. The empty one is a strip, not a box — see `renderLane`. */}
      <div
        className="lanes"
        // `#grid` STAYS on the container, and that is not cosmetic. It used to be the one
        // `<ul>`, and both a CSS rule and a dozen harnesses read `#grid li.tile` meaning
        // "every tile in this queue" — which is still exactly what it means here, and would
        // NOT be if the id had followed one lane. `body.gdrag #grid li.tile` is the settle
        // transition every sibling glides on during a drag; scoped to the Priority lane it
        // would have left the pool's tiles jumping while a promote glided past them.
        id="grid"
        ref={mergeRefs(lanesRef, flipRef)}
      >
        {!q ? null : allItems.length === 0 ? (
          <div className="empty">
            <EmptyState
              description="Search above to add something."
              heading="Empty"
              headingLevel={3}
              size="sm"
            />
          </div>
        ) : (
          <>
            {renderLane("priority", lanes.priority)}
            {renderLane("random", lanes.random)}
          </>
        )}
      </div>

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
