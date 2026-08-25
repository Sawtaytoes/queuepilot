import {
  Badge,
  EmptyState,
  IconButton,
} from "@charcuterie/ui"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react"
import { Link } from "react-router"
import {
  EditionChip,
  TypeBadge,
} from "../components/badges"
import { isPullSet } from "../components/OpenQueueButton"
import { PeopleRow } from "../components/PeopleRow"
import { PosterTile } from "../components/PosterTile"
import { Tip } from "../components/Tip"
import { useHomeDrags } from "../hooks/useHomeDrags"
import { activeSet, isPlayingItem } from "../lib/nowPlaying"
import { queueNumbers, queueTitle } from "../lib/people"
import {
  isCompleted,
  progressLabel,
  runtimeLabel,
  tileFace,
} from "../lib/tileFace"
import type {
  GroupWithRoster,
  NowState,
  Person,
  QueueItem,
  QueueMember,
  RegistrySet,
} from "../lib/types"
import { PLEX_WORDS } from "../lib/vocab"
import {
  openPlayMenu,
  openSetModal,
  openTileMenu,
} from "../state/overlays"
import { usePeople } from "../state/people"
import {
  queueEntryActions,
  removeQueueItem,
} from "../state/queueEntry"
import { queueIds, useStore } from "../state/store"
import {
  homeScroll,
  toggleCollapsed,
  useUi,
} from "../state/ui"

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

function Shelf({
  groups,
  isCollapsed,
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
}: {
  setId: string
  /**
   * WHAT THIS QUEUE IS CALLED — and since WP-5 that is its ACTIVITY, plus a number when two
   * cards would otherwise read identically. There is no hand-typed name any more; who the
   * queue is for is the row of faces below this
   * (decision `2026-08-25-a-queue-is-people-plus-an-activity` §4).
   */
  label: string
  /** This queue's two trays. Empty is legal and means "Anybody". */
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

  return (
    <section
      className={`shelf${isCollapsed ? " collapsed" : ""}${isLive ? " live" : ""}`}
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
          onClick={() => toggleCollapsed(setId)}
          size="sm"
        >
          ▾
        </IconButton>
        {/* An anchor, so the shelf title can be middle-clicked / ⌘-clicked into a new tab
            like any other link. The handler stays but no longer navigates: it only records
            where we were, and letting the default run is what performs the navigation.
            Deliberately NOT preventDefault'd — that would put us back to a button wearing a
            link's clothes. (A ⌘/Ctrl-click also fires `click`, so it harmlessly stamps the
            scroll position of a page we are not leaving.) */}
        <Link
          className="open"
          onClick={() => {
            homeScroll.y = window.scrollY // restore this position when we come back
          }}
          to={`/q/${setId}`}
        >
          <span className="lbl">{label}</span>{" "}
          <span className="sec">{items.length}</span>{" "}
          <span className="chev">›</span>
        </Link>
        {/* THE LIST INHERITS THE TRAYS. Must-be-here faces large, nice-to-have faces small and
            dashed — the queue list draws the same distinction the editor does, because it is
            now the only thing telling two "Movies & Shows" apart
            (decision `2026-08-25-the-queue-editor-is-two-trays-not-a-sentence-or-a-roster`
            §3). */}
        <PeopleRow
          groups={groups}
          members={members}
          people={people}
        />
        {/* The PROVIDER, once more than one serves the same activity — "show the provider
            name in the queue list" (decision §1). It is an ATTRIBUTE of the queue, never a
            heading over it, so it sits in the shelf's own row rather than grouping anything. */}
        {providerKind ? (
          <span className="qprovider">{providerKind}</span>
        ) : null}
        <span className="livepill" hidden={!isLive}>
          {isLive && now.now?.state === "paused"
            ? "Paused"
            : "Playing"}
        </span>
        <span className="shelfspacer" />
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
              ▶
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
            ⚙
          </IconButton>
        </Tip>
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
            ≡
          </IconButton>
        </Tip>
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
            items.map((item) => {
              const face = tileFace(item)
              const isPlaying =
                isLive && isPlayingItem(now, item)

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
                  key={item.key}
                  next={{
                    isDone: face.nextDone,
                    text: face.next,
                    tooltip:
                      face.from && item.childCount != null
                        ? `${face.next} — ${item.childCount} in order`
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
                  onRemove={() =>
                    removeQueueItem(setId, item)
                  }
                  posterCover={item.cover}
                  // The runtime line, the same as the queue grid's — the shelf shows the
                  // same entries and answers the same question about them.
                  runtime={runtimeLabel(
                    item.nextEp?.duration || item.duration,
                    item.episodes ?? set?.episodes ?? 1,
                  )}
                  posterRatingKey={
                    item.resolved ? face.ratingKey : null
                  }
                  title={
                    face.title +
                    (face.year ? ` (${face.year})` : "")
                  }
                  // The item's own page in Plex / Kavita — see QueueView.
                  titleHref={item.webUrl}
                  titleHrefLabel={
                    set?.vocabulary?.name || PLEX_WORDS.name
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

export function QueuesView({
  isHidden,
  toolbar,
}: {
  isHidden: boolean
  /** The Home toolbar, when the viewport is narrow enough that it mounts here. */
  toolbar: React.ReactNode
}) {
  const { data, now, reg } = useStore()
  const people = usePeople()
  const { collapsed, filter } = useUi()
  const shelvesRef = useRef<HTMLDivElement>(null)

  useHomeDrags(shelvesRef)

  // Shelf heights are deterministic (fixed tile size + aspect-ratio), so the page
  // height is settled synchronously — restore the pre-navigation scroll on the next
  // frame.
  useEffect(() => {
    if (isHidden) return

    const y = homeScroll.y

    requestAnimationFrame(() => window.scrollTo(0, y))
    // Only on entering the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHidden])

  const playingSet = activeSet(now, data)

  // WP-5. Two queues may share people and activity — "Allow, and add a number." Computed over
  // the REGISTRY order so the number is stable: the first Movies & Shows queue is unnumbered
  // forever, and creating a second one never renumbers the first.
  const numbers = queueNumbers(
    reg?.sets ?? [],
    people.byQueue,
  )

  return (
    <main className="view" hidden={isHidden} id="home">
      <div id="gslot-narrow">{toolbar}</div>
      <div id="shelves" ref={shelvesRef}>
        {isHidden
          ? null
          : queueIds(data).map((id) => {
              const q = data!.sets[id]!
              const registrySet = reg?.sets.find(
                (s) => s.id === id,
              )
              // THE NAME IS THE ACTIVITY. `q.label` is the hand-typed string the registry
              // still carries; it is data we migrated FROM, not a field to show. It is kept
              // as the FILTER's haystack below, because typing "manga" should still find the
              // queue somebody named that.
              const title = registrySet
                ? queueTitle(
                    registrySet.activity,
                    numbers.get(id) ?? null,
                  )
                : q.label

              return (
                <Shelf
                  groups={people.groups}
                  isCollapsed={collapsed.has(id)}
                  isHiddenByFilter={
                    !shelfMatches(
                      filter,
                      [title, q.label],
                      q.items,
                    )
                  }
                  items={q.items}
                  key={id}
                  label={title}
                  members={people.byQueue[id] ?? []}
                  now={now}
                  people={people.people}
                  playingSet={playingSet}
                  providerKind={
                    reg?.sets.find((s) => s.id === id)
                      ?.provider_kind ?? ""
                  }
                  set={
                    reg?.sets.find((s) => s.id === id) ??
                    null
                  }
                  setId={id}
                />
              )
            })}
      </div>
    </main>
  )
}
