import {
  Badge,
  EmptyState,
  IconButton,
  Spinner,
} from "@charcuterie/ui"
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { Link, useLocation } from "react-router"
import { AlsoInDivider } from "../components/AlsoInDivider"
import {
  EditionChip,
  TypeBadge,
} from "../components/badges"
import { LandingFilterBar } from "../components/LandingFilterBar"
import { isPullSet } from "../components/OpenQueueButton"
import { PeopleRow } from "../components/PeopleRow"
import { PosterTile } from "../components/PosterTile"
import { Tip } from "../components/Tip"
import { useHomeDrags } from "../hooks/useHomeDrags"
import { api } from "../lib/api"
import { activeBinding } from "../lib/channels"
import {
  filteredParent,
  nestFilteredQueues,
} from "../lib/filteredQueues"
import { isRandomOrder } from "../lib/kind"
import { titleWithYear } from "../lib/mediaTitle"
import { activeSet, isPlayingItem } from "../lib/nowPlaying"
import { queueNumbers, queueTitle } from "../lib/people"
import { ROUTE_PATHS } from "../lib/routePaths"
import {
  collectionOrderCount,
  isCompleted,
  progressLabel,
  runtimeLabel,
  tileFace,
} from "../lib/tileFace"
import type { PeopleMatch } from "../lib/tonight"
import {
  missingRequiredPeople,
  peopleMatch,
  resolveMembers,
  rosterOrder,
  splitByMatch,
} from "../lib/tonight"
import type {
  GroupWithRoster,
  NowState,
  Person,
  PreviewResponse,
  QueueItem,
  QueueMember,
  RegistrySet,
} from "../lib/types"
import { PLEX_WORDS } from "../lib/vocab"
import { parseLayout } from "../state/filterVariant"
import {
  parsePeople,
  parseProviders,
} from "../state/landingFilter"
import {
  openDynModal,
  openPlayMenu,
  openSetModal,
  openTileMenu,
} from "../state/overlays"
import { usePeople } from "../state/people"
import {
  moveEntryLane,
  queueEntryActions,
  removeQueueItem,
  setPriorityPosition,
} from "../state/queueEntry"
import { splitLanes } from "../state/queueView"
import {
  curatedIds,
  rotationChannels,
  setStatus,
  useStore,
} from "../state/store"
import { toggleCollapsed, useUi } from "../state/ui"

/**
 * QUEUES — the configurator. Every ordered queue is a horizontal poster shelf, so
 * all of them are glanceable but only one is "expanded" at a time; tapping one
 * opens it as a grid. Posters drag within and between shelves; the ≡ handle
 * reorders whole shelves. (decision `2026-07-20-queue-web-ui-ux-and-write-format`)
 */

/**
 * A shelf matches the filter on either of its NAMES, or on any title inside it.
 *
 * TWO names since WP-5, and both are searched on purpose. The displayed name is the activity
 * ("Movies & Shows"), which is what somebody reads on screen; the registry's `label` is the
 * hand-typed string that WP-5 migrated FROM and no longer shows. Dropping the second would
 * make typing "manga" stop finding the queue the owner named that, on the day the name
 * disappeared from the screen — a search that used to work and quietly does not.
 */
function shelfMatches(
  filter: string,
  names: readonly string[],
  items: { title?: string }[],
) {
  if (!filter) return true

  const f = filter.toLowerCase()

  if (names.some((name) => name.toLowerCase().includes(f)))
    return true

  return items.some((it) =>
    (it.title || "").toLowerCase().includes(f),
  )
}

type RulesPreviewItem = {
  cover?: string | null
  count?: number
  key: string
  ratingKey: string
  title: string
}

/**
 * A Rules queue uses the same collapsible shelf shape as a Picks queue. Its posters are a
 * read-only preview of the eligible titles: they can be opened, but they are not stored
 * entries and therefore never receive drag, lane, remove, or add controls.
 */
function RulesShelf({
  channel,
  filter,
  groups,
  isCollapsed,
  members,
  people,
}: {
  channel: RegistrySet
  filter: string
  groups: readonly GroupWithRoster[]
  isCollapsed: boolean
  members: readonly QueueMember[]
  people: readonly Person[]
}) {
  const [items, setItems] = useState<
    RulesPreviewItem[] | null
  >(null)
  const [isLoading, setIsLoading] = useState(false)
  const stripRef = useRef<HTMLUListElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const leftRef = useRef<HTMLButtonElement>(null)
  const rightRef = useRef<HTMLButtonElement>(null)

  const updateArrows = useCallback(() => {
    const strip = stripRef.current
    const wrap = wrapRef.current

    if (!strip || !wrap) return

    const hasMoreLeft = strip.scrollLeft > 2
    const hasMoreRight =
      strip.scrollLeft <
      strip.scrollWidth - strip.clientWidth - 2

    if (leftRef.current)
      leftRef.current.hidden = !hasMoreLeft
    if (rightRef.current)
      rightRef.current.hidden = !hasMoreRight
    wrap.classList.toggle("more-left", hasMoreLeft)
    wrap.classList.toggle("more-right", hasMoreRight)
  }, [])

  useLayoutEffect(() => {
    requestAnimationFrame(updateArrows)
  })

  useEffect(() => {
    window.addEventListener("resize", updateArrows)

    return () =>
      window.removeEventListener("resize", updateArrows)
  }, [updateArrows])

  useEffect(() => {
    if (isCollapsed || items !== null) return

    let isCancelled = false
    const run = async () => {
      setIsLoading(true)

      try {
        const qs = new URLSearchParams()

        if (channel.has_explicit_profiles) {
          const profile =
            activeBinding(channel, null).plex_user || ""

          if (profile) qs.set("profile", profile)
        }

        const query = qs.toString()
        const preview = await api<PreviewResponse>(
          "GET",
          `/api/generic/${channel.id}/preview${query ? `?${query}` : ""}`,
        )

        if (isCancelled) return
        if (preview.error) throw new Error(preview.error)

        const next: RulesPreviewItem[] = []

        for (const bucket of preview.buckets ?? []) {
          if (bucket.items) {
            for (const item of bucket.items) {
              next.push({
                key: `${bucket.ratingKey}:${item.ratingKey}`,
                ratingKey: item.ratingKey,
                title: item.title,
              })
            }
          } else {
            next.push({
              count: bucket.unwatched,
              cover: bucket.cover,
              key: String(bucket.ratingKey),
              ratingKey: String(bucket.ratingKey),
              title: bucket.show,
            })
          }
        }

        for (const movie of preview.movie_pool ?? []) {
          next.push({
            count: movie.count,
            key: `movie:${movie.ratingKey}`,
            ratingKey: movie.ratingKey,
            title: movie.title,
          })
        }

        setItems(next)
      } catch (error) {
        if (!isCancelled) {
          setStatus(
            `Preview failed: ${(error as Error).message}`,
            "err",
          )
        }
      } finally {
        if (!isCancelled) setIsLoading(false)
      }
    }

    void run()

    return () => {
      isCancelled = true
    }
  }, [channel, isCollapsed, items])

  const isHiddenByFilter = !shelfMatches(
    filter,
    [channel.label],
    items ?? [],
  )

  return (
    <section
      className={`shelf rules-shelf${isCollapsed ? " collapsed" : ""}`}
      data-provider={channel.provider_kind || undefined}
      data-set={channel.id}
      hidden={isHiddenByFilter}
    >
      <h2>
        <IconButton
          appearance="ghost"
          className="collapse-toggle"
          intent="neutral"
          label="collapse queue"
          onClick={() =>
            toggleCollapsed(channel.id, isCollapsed)
          }
          size="sm"
        >
          <ChevronDownIcon />
        </IconButton>
        <Link
          className="open"
          to={`/channels/${encodeURIComponent(channel.id)}`}
        >
          <span className="lbl">{channel.label}</span>
          {items ? (
            <span className="sec">{items.length}</span>
          ) : null}
          <span className="lanes-sec">
            {items ? "eligible" : "eligible titles"}
          </span>
        </Link>
        <PeopleRow
          groups={groups}
          members={members}
          people={people}
        />
        <span className="shelfspacer" />
        <span className="shelfactions">
          <Tip label="Edit queue">
            <IconButton
              appearance="ghost"
              className="shelfedit"
              intent="neutral"
              label="Edit queue"
              onClick={() => openDynModal(channel.id)}
              size="sm"
            >
              <SettingsIcon />
            </IconButton>
          </Tip>
        </span>
      </h2>
      <div className="strip-wrap" ref={wrapRef}>
        <button
          aria-label="scroll left"
          className="scroll left"
          onClick={() =>
            stripRef.current?.scrollBy({
              left: -stripRef.current.clientWidth * 0.85,
            })
          }
          ref={leftRef}
          type="button"
        >
          ‹
        </button>
        <ul
          aria-busy={isLoading || undefined}
          className="strip"
          onScroll={updateArrows}
          ref={stripRef}
        >
          {isLoading ? (
            <li className="empty">
              <Spinner
                label="Loading eligible titles…"
                size="sm"
              />
            </li>
          ) : items?.length ? (
            items.map((item) => (
              <PosterTile
                badges={
                  item.count != null ? (
                    <Badge
                      appearance="outline"
                      className="badge show"
                      intent="neutral"
                      size="sm"
                    >
                      {channel.behavior === "rewatch"
                        ? `${item.count} watches`
                        : `${item.count} unwatched`}
                    </Badge>
                  ) : null
                }
                dataKey={item.key}
                key={item.key}
                posterCover={item.cover}
                posterRatingKey={item.ratingKey}
                title={item.title}
              />
            ))
          ) : (
            <li className="empty">
              <EmptyState
                description="No titles match this queue's eligibility filters."
                heading="No eligible titles"
                headingLevel={3}
                size="sm"
              />
            </li>
          )}
        </ul>
        <button
          aria-label="scroll right"
          className="scroll right"
          onClick={() =>
            stripRef.current?.scrollBy({
              left: stripRef.current.clientWidth * 0.85,
            })
          }
          ref={rightRef}
          type="button"
        >
          ›
        </button>
      </div>
    </section>
  )
}

function Shelf({
  groups,
  isCollapsed,
  filteredFrom,
  isHiddenByFilter,
  items,
  label,
  members,
  now,
  people,
  playingSet,
  providerKind,
  set,
  setId,
  setLane,
}: {
  setId: string
  /**
   * WHAT THIS QUEUE IS CALLED — and since WP-5 that is its ACTIVITY, plus a number when two
   * cards would otherwise read identically. There is no hand-typed name any more; who the
   * queue is for is the row of faces below this
   * (decision `2026-08-25-a-queue-is-people-plus-an-activity` §4).
   */
  label: string
  /** This queue's audience rows. Empty is legal and means "Anybody". */
  members: readonly QueueMember[]
  people: readonly Person[]
  groups: readonly GroupWithRoster[]
  items: QueueItem[]
  isCollapsed: boolean
  isHiddenByFilter: boolean
  now: NowState
  playingSet: string | null
  /** `plex` / `kavita` — this shelf's accent. Empty for a queue whose provider this build
   *  does not recognise, which falls back to the app's neutral accent. */
  providerKind: string
  /** The registry row, for HOW this queue starts and what its provider calls that. Null
   *  while the registry is still loading, which reads as push — the pre-existing default. */
  set: Pick<
    RegistrySet,
    "id" | "delivery" | "episodes" | "vocabulary"
  > | null
  /**
   * The queue this one is a filtered VIEW of, when it is one.
   *
   * Present ⇒ the shelf is drawn nested under that queue: indented, badged `Filtered`, and
   * with neither drag handle — its order is the parent's, and a subset cannot express one
   * (`lib/filteredQueues.ts`). Null on every ordinary queue.
   */
  filteredFrom: { id: string; label: string } | null
  /**
   * This queue's OWN default lane — what an entry carrying no `placement` means here.
   *
   * Resolved by the caller through `isRandomOrder`, exactly as `QueueView` does it, because
   * the registry row may carry only a legacy `kind` and there must not be two places that
   * decide what an un-promoted entry is.
   */
  setLane: "priority" | "random"
}) {
  const stripRef = useRef<HTMLUListElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const leftRef = useRef<HTMLButtonElement>(null)
  const rightRef = useRef<HTMLButtonElement>(null)

  /**
   * An arrow (and its edge shadow) only exists when there is somewhere to scroll in
   * that direction — the shadow is the always-visible "more items this way" cue,
   * the arrow appears on hover. Written to the DOM rather than to state because it
   * fires on every scroll frame and must not re-render the shelf under a drag.
   * (decision `2026-07-21-shelf-ui-conventions`)
   */
  const updateArrows = useCallback(() => {
    const strip = stripRef.current
    const wrap = wrapRef.current

    if (!strip || !wrap) return

    const hasMoreLeft = strip.scrollLeft > 2
    const hasMoreRight =
      strip.scrollLeft <
      strip.scrollWidth - strip.clientWidth - 2

    if (leftRef.current)
      leftRef.current.hidden = !hasMoreLeft
    if (rightRef.current)
      rightRef.current.hidden = !hasMoreRight

    wrap.classList.toggle("more-left", hasMoreLeft)
    wrap.classList.toggle("more-right", hasMoreRight)
  }, [])

  useLayoutEffect(() => {
    requestAnimationFrame(updateArrows)
  })

  useEffect(() => {
    // A viewport resize changes how much of each strip fits.
    window.addEventListener("resize", updateArrows)

    return () =>
      window.removeEventListener("resize", updateArrows)
  }, [updateArrows])

  const isLive = setId === playingSet

  /**
   * THE TWO LANES, in the ONE strip.
   *
   * A Picks queue is one membership list with a Priority queue and a Random pool
   * (decision `2026-08-23-kind-is-picks-or-rules`), and until 2026-08-26 this page only ever
   * drew queues whose entries were all in one of them — the random-lane ones were listed on
   * the Rules page. They are all here now, so a shelf has to be able to say which lane a
   * poster is in.
   *
   * ONE strip and not two, unlike `/q/<id>`. `useHomeDrags` reads a shelf as a single
   * `.strip` — it hit-tests one per shelf, and it rebuilds the file order from
   * `strip.querySelectorAll("li.tile")` — so a second `<ul>` would send a PATCH carrying half
   * the queue's keys. The lanes are two RUNS inside that one list instead: Priority first,
   * then a divider `<li>`, then the pool. The divider is not a `li.tile`, so every one of
   * those queries steps over it.
   */
  const lanes = splitLanes(items, setLane)
  const hasBothLanes = Boolean(
    lanes.priority.length && lanes.random.length,
  )
  /**
   * The lane clause beside the count.
   *
   * A shelf holding one lane still has to say WHICH — the strip's divider can only appear
   * when there are two runs to divide, so a queue with every entry in the pool would
   * otherwise be indistinguishable from an ordered one. Same clause `PlayView.picksMeta`
   * puts on a landing card, so the two pages agree about a queue at a glance.
   */
  const laneClause = hasBothLanes
    ? `${lanes.priority.length} priority · ${lanes.random.length} pool`
    : items.length === 0
      ? null
      : lanes.priority.length
        ? "priority queue"
        : "random pool"

  /**
   * ONE poster, rendered the same in either lane.
   *
   * Extracted from the strip's `.map()` when the shelf grew a second run, for the reason
   * `QueueView.renderTile` gives: the two lanes have to be the same tile, with the same
   * chrome and the same handlers, and a copy per lane is two places for that to stop being
   * true. `lane` is the entry's OWN lane — `placement ?? setLane`, already resolved by
   * `splitLanes` — and it decides only the promote arrow's direction.
   */
  const renderTile = (
    item: QueueItem,
    lane: "priority" | "random",
    priorityPosition?: number,
  ) => {
    const face = tileFace(item)
    const isPlaying = isLive && isPlayingItem(now, item)

    return (
      <PosterTile
        badges={
          <>
            <TypeBadge face={face} item={item} />
            {/* Which EDITION this is — see QueueView. The shelf shows the same
                        entries the grid does, so it has the same pair to tell apart. */}
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
          </>
        }
        className={[
          // `pending` is not `unresolved`: the red border means "this
          // entry names something Plex does not have", and a tile that
          // simply hasn't been resolved YET has made no such claim.
          item.resolved || item.pending
            ? null
            : "unresolved",
          isCompleted(item) ? "done" : null,
          isPlaying ? "playing" : null,
        ]
          .filter(Boolean)
          .join(" ")}
        dataKey={item.key}
        dataSet={setId}
        isPending={item.pending}
        isPriority={lane === "priority"}
        key={item.key}
        // The third control in the tile's chrome stack: into the Priority queue, or
        // back out to the pool. The queue page's divider drag has no counterpart here
        // — a shelf is one `.strip` and its drag rebuilds file order, not placement —
        // so on this page the arrow is the ONLY promote, which is why it is offered on
        // every shelf rather than only on the mixed ones.
        onLane={() =>
          void moveEntryLane(setId, item, setLane)
        }
        next={{
          isDone: face.nextDone,
          text: face.next,
          tooltip:
            face.from && collectionOrderCount(item) != null
              ? `${face.next} — ${collectionOrderCount(item)} in order`
              : face.next,
        }}
        // The same per-entry menu the queue grid opens. It was already
        // half-wired here: `useHomeDrags` suppresses the browser's native menu
        // over a poster so a touch long-press can arm a drag, so a right-click
        // on a shelf poster did NOTHING at all. It also carries the start-point
        // actions, which had no shelf route either.
        onContextMenu={(e) => {
          e.preventDefault()
          openTileMenu(
            e.clientX,
            e.clientY,
            queueEntryActions(setId, item),
          )
        }}
        // The ✕. A shelf already REORDERS a title and MOVES it to another queue
        // (`useHomeDrags`), so "open the queue first" was the only write it
        // refused — reported 2026-08-21: "From the Ordered Queues view, I can't
        // remove items either."
        // (decision `2026-08-21-any-tile-in-an-editable-grid-gets-the-remove-control`)
        onRemove={() => removeQueueItem(setId, item)}
        posterCover={item.cover}
        priorityPosition={
          priorityPosition
            ? {
                count: lanes.priority.length,
                onChange: (position) =>
                  void setPriorityPosition(
                    setId,
                    item,
                    position,
                  ),
                position: priorityPosition,
              }
            : undefined
        }
        // The runtime line, the same as the queue grid's — the shelf shows the
        // same entries and answers the same question about them.
        runtime={
          item.item_order === "shuffle"
            ? null
            : runtimeLabel(
                item.nextEp?.duration || item.duration,
                item.episodes ?? set?.episodes ?? 1,
              )
        }
        posterRatingKey={
          item.resolved ? face.ratingKey : null
        }
        title={titleWithYear(face.title, face.year)}
        // The item's own page in Plex / Kavita — see QueueView.
        titleHref={item.webUrl}
        titleHrefLabel={
          set?.vocabulary?.name || PLEX_WORDS.name
        }
        titleTooltip={
          face.from
            ? `${face.fullTitle || face.title} — from the “${face.from}” collection`
            : titleWithYear(face.title, face.year)
        }
      />
    )
  }

  return (
    <section
      className={`shelf${isCollapsed ? " collapsed" : ""}${isLive ? " live" : ""}${filteredFrom ? " filtered" : ""}`}
      // This shelf's counts, rings and badges are about THIS queue, so they wear its
      // provider's colour; the page's own "New queue" / filter chrome sits outside and stays
      // Charcuterie. (decision `2026-08-15-a-queue-wears-its-providers-colour`)
      data-provider={providerKind || undefined}
      data-set={setId}
      hidden={isHiddenByFilter}
    >
      <h2>
        {/* `ghost` is the appearance for an icon row — nothing until hovered — which is
            what all four of this heading's controls painted by hand. The class stays and
            carries only the ROTATE: ▾ turns to ► when the shelf is collapsed, a state no
            component prop describes. */}
        <IconButton
          appearance="ghost"
          className="collapse-toggle"
          intent="neutral"
          label="collapse queue"
          onClick={() =>
            toggleCollapsed(setId, isCollapsed)
          }
          size="sm"
        >
          <ChevronDownIcon />
        </IconButton>
        {/* An anchor, so the shelf title can be middle-clicked / ⌘-clicked into a new tab
            like any other link. It records nothing on the way out: `Main` remembers where
            each history entry was scrolled to, so Back lands here by itself. */}
        <Link className="open" to={`/q/${setId}`}>
          <span className="lbl">{label}</span>
          <span className="sec">{items.length}</span>
          {laneClause ? (
            <span className="lanes-sec">{laneClause}</span>
          ) : null}
        </Link>
        {/* WHAT THIS SHELF IS. The badge says the queue is a view; the line beside it names
            what it is a view OF, because "Filtered" alone leaves the reader to guess which of
            the shelves above it belongs to. Both sit inside the heading rather than under it,
            so a collapsed shelf still says so. */}
        {filteredFrom ? (
          <>
            <Badge intent="neutral" size="sm">
              Filtered
            </Badge>
            <Link
              className="filtered-parent"
              to={`/q/${filteredFrom.id}`}
            >
              filters {filteredFrom.label}
            </Link>
          </>
        ) : null}
        {/* THE LIST INHERITS THE TRAYS. Required people come first, and optional people follow.
            The shared avatar badge and visible name tell two same-activity queues apart. The
            heading's content is baseline-aligned so the badges and names read as one row. */}
        <PeopleRow
          groups={groups}
          members={members}
          people={people}
        />
        <span className="livepill" hidden={!isLive}>
          {isLive && now.now?.state === "paused"
            ? "Paused"
            : "Playing"}
        </span>
        <span className="shelfspacer" />
        <span className="shelfactions">
          {/* HOW this queue starts, never WHICH provider it is — the same rule
            `OpenQueueButton` follows on the queue's own page. This shelf used to open the
            device menu unconditionally, so a pull queue offered a Shield and a phone for
            something none of them can open; with no broker it simply answered "MQTT not
            connected" (reported 2026-08-17 on a Steam queue, and true for Kavita and the
            board-game picker since each of those shipped).
            (decision `2026-08-15-a-provider-carries-its-own-vocabulary`) */}
          {isPullSet(set) ? (
            <Tip
              label={`${set?.vocabulary?.verb || PLEX_WORDS.verb} this queue in ${set?.vocabulary?.name || PLEX_WORDS.name}`}
            >
              <a
                aria-label={`${set?.vocabulary?.verb || PLEX_WORDS.verb} this queue in ${set?.vocabulary?.name || PLEX_WORDS.name}`}
                className="shelfplay"
                href={`/go/${encodeURIComponent(setId)}`}
                rel="noreferrer"
                // A new tab, so the shelf you launched from is still here on the way back —
                // same reason `OpenQueueButton` does it.
                target="_blank"
              >
                {set?.vocabulary?.startIcon ||
                  PLEX_WORDS.startIcon}
              </a>
            </Tip>
          ) : (
            <Tip label="Play this queue on a device">
              {/* ⚠️ `.shelfplay` is LOAD-BEARING as a selector, not only as a hover state:
                `PlayMenu`'s outside-click handler asks `t.closest(".shelfplay")`, so a
                control that opens that menu and does not wear the class opens a menu that
                shuts on the same click — measured, and the whole of #173. */}
              <IconButton
                appearance="ghost"
                className="shelfplay"
                intent="accent"
                label="Play this queue on a device"
                onClick={(e) =>
                  openPlayMenu({
                    anchor:
                      e.currentTarget.getBoundingClientRect(),
                    setId,
                  })
                }
                size="sm"
              >
                <PlayIcon />
              </IconButton>
            </Tip>
          )}
          <Tip label="Edit queue">
            <IconButton
              appearance="ghost"
              className="shelfedit"
              intent="neutral"
              label="Edit queue"
              onClick={() => openSetModal(setId)}
              size="sm"
            >
              <SettingsIcon />
            </IconButton>
          </Tip>
          {/* NO DRAG HANDLE on a filtered queue. Its place in the list is not a preference —
              it is pinned under the queue it views (`lib/filteredQueues.ts`), so a handle
              would offer a move that the next render undoes. */}
          {filteredFrom ? null : (
            <Tip label="Drag to reorder queues">
              {/* `.shelfdrag` is the drag HANDLE — `useHomeDrags` opens on
                `closest(".shelfdrag")` — so the class is a DOM handle first and a cursor
                second. */}
              <IconButton
                appearance="ghost"
                className="shelfdrag"
                intent="neutral"
                label="Drag to reorder queues"
                size="sm"
              >
                <DragIcon />
              </IconButton>
            </Tip>
          )}
        </span>
      </h2>
      <div className="strip-wrap" ref={wrapRef}>
        <button
          aria-label="scroll left"
          className="scroll left"
          onClick={() =>
            stripRef.current?.scrollBy({
              left: -stripRef.current.clientWidth * 0.85,
            })
          }
          ref={leftRef}
          type="button"
        >
          ‹
        </button>
        <ul
          className="strip"
          onScroll={updateArrows}
          ref={stripRef}
        >
          {items.length === 0 ? (
            <li className="empty">
              <EmptyState
                description="Open it to add something."
                heading="Empty"
                headingLevel={3}
                size="sm"
              />
            </li>
          ) : (
            <>
              {lanes.priority.map((item, index) =>
                renderTile(item, "priority", index + 1),
              )}
              {/* THE DIVIDER, and it is deliberately not a `li.tile`: `useHomeDrags` builds
                  the queue's new order from `strip.querySelectorAll("li.tile")` and hit-tests
                  drop slots the same way, so a marker that matched would be sent to the
                  server as a key. `aria-hidden` because the shelf heading already says the
                  split in words ("3 priority · 9 pool") — this is the visual echo of that
                  sentence, not a second copy of it for a screen reader to read out. */}
              {hasBothLanes ? (
                <li
                  aria-hidden="true"
                  className="lanesplit"
                >
                  <span>Random pool</span>
                </li>
              ) : null}
              {lanes.random.map((item) =>
                renderTile(item, "random"),
              )}
            </>
          )}
        </ul>
        <button
          aria-label="scroll right"
          className="scroll right"
          onClick={() =>
            stripRef.current?.scrollBy({
              left: stripRef.current.clientWidth * 0.85,
            })
          }
          ref={rightRef}
          type="button"
        >
          ›
        </button>
      </div>
    </section>
  )
}

function ChevronDownIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="18"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width="18"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

function PlayIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="currentColor"
      height="17"
      viewBox="0 0 24 24"
      width="17"
    >
      <path d="m8 5 11 7-11 7V5Z" />
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="18"
      stroke="currentColor"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width="18"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1A7 7 0 0 0 15 6l-.3-2.6h-4L10.4 6A7 7 0 0 0 8 7.1l-2.4-1-2 3.4 2 1.5a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.4-1A7 7 0 0 0 10.4 18l.3 2.6h4L15 18a7 7 0 0 0 1.5-1.1l2.4 1 2-3.4-2-1.5a7 7 0 0 0 .1-1Z" />
    </svg>
  )
}

function DragIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="currentColor"
      height="18"
      viewBox="0 0 24 24"
      width="18"
    >
      <circle cx="9" cy="5" r="1.5" />
      <circle cx="15" cy="5" r="1.5" />
      <circle cx="9" cy="12" r="1.5" />
      <circle cx="15" cy="12" r="1.5" />
      <circle cx="9" cy="19" r="1.5" />
      <circle cx="15" cy="19" r="1.5" />
    </svg>
  )
}

export function QueuesView({
  toolbar,
}: {
  /** The Home toolbar, when the viewport is narrow enough that it mounts here. */
  toolbar: React.ReactNode
}) {
  const { data, now, reg } = useStore()
  const people = usePeople()
  const { search } = useLocation()
  const { collapsed, filter, hasCollapsePreference } =
    useUi()
  const shelvesRef = useRef<HTMLDivElement>(null)

  useHomeDrags(shelvesRef)

  const playingSet = activeSet(now, data)
  const only = parseProviders(search)
  const layout = parseLayout(search)
  const selected = parsePeople(search)

  /** Every queue's audience, resolved through the SAME group rule the former queue landing
   * used. A group remains one "at least N of these people" member; it must not be flattened
   * into people here or the filter would require the whole group. */
  const membersOf = useMemo(() => {
    const out = new Map<
      string,
      ReturnType<typeof resolveMembers>
    >()

    for (const [setId, members] of Object.entries(
      people.byQueue,
    )) {
      out.set(
        setId,
        resolveMembers(
          members,
          people.people,
          people.groups,
        ),
      )
    }

    return out
  }, [people])

  // WP-5. Two queues may share people and activity — "Allow, and add a number."
  //
  // Over the shelves THIS PAGE DRAWS, in the order it draws them, and not over the registry.
  // A number is how you tell two cards apart, so it only means anything among cards somebody
  // can see at once: numbering the registry made this page open at "Movies & Shows 3",
  // because two filtered pools on the Pools page had taken 1 and 2.
  // EVERY Picks queue, both lane defaults. It was the priority-lane half until 2026-08-26,
  // which is what left `Kevin — Anime` and nine others listed on the Rules page instead
  // (decision `2026-08-26-a-picks-queue-lives-on-the-picks-screen-whichever-lane-it-defaults-to`).
  const setById = (id: string) =>
    reg?.sets.find((s) => s.id === id) ?? null
  // A FILTERED queue is drawn UNDER the queue it views, wherever the file happens to have
  // written it (`lib/filteredQueues.ts`).
  const shelfIds = nestFilteredQueues(
    curatedIds(data),
    setById,
  )
  const rulesChannels = rotationChannels(reg)
  const queueIds = [
    ...shelfIds,
    ...rulesChannels.map((channel) => channel.id),
  ]
  const kindOf = (id: string) =>
    reg?.sets.find((set) => set.id === id)?.provider_kind ??
    ""
  /**
   * HOW WELL one queue answers the filter — `exact`, `also` or `none`.
   *
   * The provider filter is a plain AND and has no tiers: a Kavita queue is not a near miss
   * for "Plex", it is a different library. Only the PEOPLE question has a middle answer.
   */
  const matchOf = (
    id: string,
    forPeople: readonly string[],
    forOnly: readonly string[],
  ): PeopleMatch =>
    forOnly.length && !forOnly.includes(kindOf(id))
      ? { missingRequired: 0, tier: "none" }
      : peopleMatch(membersOf.get(id) ?? [], forPeople)
  const shownShelfIds = splitByMatch(shelfIds, (id) =>
    matchOf(id, selected, only),
  )
  const shownRulesChannels = splitByMatch(
    rulesChannels,
    (channel) => matchOf(channel.id, selected, only),
  )
  const countFor = (
    forPeople: readonly string[],
    forOnly: readonly string[],
  ) =>
    queueIds.filter(
      (id) =>
        matchOf(id, forPeople, forOnly).tier !== "none",
    ).length
  const providerKinds = [
    ...new Set(queueIds.map(kindOf).filter(Boolean)),
  ]
  const labelForKind = (kind: string) =>
    reg?.sets.find((set) => set.provider_kind === kind)
      ?.vocabulary?.name || kind
  const numbers = queueNumbers(
    shelfIds
      .map((id) => reg?.sets.find((s) => s.id === id))
      .filter((s): s is NonNullable<typeof s> => s != null),
    people.byQueue,
  )
  /**
   * The names the "Also in these queues" line prints, over BOTH tiers' also-in lists at once
   * and in roster order.
   *
   * One list for the page rather than one per section, so the Picks divider and the Rules
   * divider cannot name two different sets of people for the same filter — they are answering
   * the same question about the same selection.
   */
  const alsoNames = (() => {
    const wanted = new Set(
      [
        ...shownShelfIds.also,
        ...shownRulesChannels.also.map(
          (channel) => channel.id,
        ),
      ].flatMap((id) =>
        missingRequiredPeople(
          membersOf.get(id) ?? [],
          selected,
        ),
      ),
    )

    return rosterOrder(people.people)
      .filter((person) => wanted.has(person.id))
      .map((person) => person.displayName)
  })()

  return (
    <div className="view" id="home">
      <div id="gslot-narrow">{toolbar}</div>
      <LandingFilterBar
        basePath={ROUTE_PATHS.queues.replace("/*", "")}
        countFor={countFor}
        labelForKind={labelForKind}
        only={only}
        people={rosterOrder(people.people)}
        providerKinds={providerKinds}
        search={search}
        selected={selected}
        variant={layout}
      />
      <div className="queue-section-heading picks-queue-heading">
        <div>
          <h2>Picks</h2>
          <p>Queues whose titles you choose and arrange.</p>
        </div>
      </div>
      <div id="shelves" ref={shelvesRef}>
        {[
          ...shownShelfIds.exact,
          ...shownShelfIds.also,
        ].map((id, index) => {
          // The rule goes BEFORE the first also-in shelf, inside the same drag container —
          // `useHomeDrags` reorders `#shelves`' children and a separate wrapper per tier
          // would make a drag across the line impossible.
          const isFirstAlso =
            shownShelfIds.also.length > 0 &&
            index === shownShelfIds.exact.length
          const q = data!.sets[id]!
          const registrySet = setById(id)
          // THE NAME WHEN THERE IS ONE, the ACTIVITY when there is not. This shelf
          // printed the activity unconditionally until 2026-08-26, which renamed
          // "Manga & Webtoons" to "Reading" on a queue the owner had deliberately named
          // (decision `2026-08-26-a-queue-name-is-optional-and-the-activity-fills-in`).
          // `q.label` stays the FILTER's haystack below either way, so typing "manga"
          // finds it even when the shelf is showing the activity.
          const title = registrySet
            ? queueTitle(
                registrySet,
                numbers.get(id) ?? null,
              )
            : q.label

          return (
            <Fragment key={id}>
              {isFirstAlso ? (
                <AlsoInDivider names={alsoNames} />
              ) : null}
              <Shelf
                groups={people.groups}
                isCollapsed={
                  !hasCollapsePreference ||
                  collapsed.has(id)
                }
                isHiddenByFilter={
                  !shelfMatches(
                    filter,
                    [title, q.label],
                    q.items,
                  )
                }
                items={q.items}
                label={title}
                members={people.byQueue[id] ?? []}
                now={now}
                people={people.people}
                playingSet={playingSet}
                providerKind={
                  registrySet?.provider_kind ?? ""
                }
                filteredFrom={filteredParent(
                  registrySet,
                  setById,
                )}
                set={registrySet ?? null}
                setId={id}
                // The registry row first, the queues payload as the fallback — the same
                // pair `QueueView` and `App` resolve the lane from, so one queue cannot
                // read as priority-by-default on its shelf and random-by-default on its
                // own page.
                setLane={
                  isRandomOrder(registrySet ?? q)
                    ? "random"
                    : "priority"
                }
              />
            </Fragment>
          )
        })}
      </div>
      {rulesChannels.length ? (
        <section
          aria-labelledby="rules-queues-heading"
          className="rules-queue-picker"
        >
          <div className="queue-section-heading">
            <div>
              <h2 id="rules-queues-heading">Rules</h2>
              <p>Queues filled from eligibility filters.</p>
            </div>
          </div>
          <div className="rules-queue-shelves">
            {[
              ...shownRulesChannels.exact,
              ...shownRulesChannels.also,
            ].map((channel, index) => (
              <Fragment key={channel.id}>
                {shownRulesChannels.also.length > 0 &&
                index ===
                  shownRulesChannels.exact.length ? (
                  <AlsoInDivider names={alsoNames} />
                ) : null}
                <RulesShelf
                  channel={channel}
                  filter={filter}
                  groups={people.groups}
                  isCollapsed={
                    !hasCollapsePreference ||
                    collapsed.has(channel.id)
                  }
                  members={people.byQueue[channel.id] ?? []}
                  people={people.people}
                />
              </Fragment>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}
