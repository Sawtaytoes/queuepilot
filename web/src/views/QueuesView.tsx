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
import { isRandomOrder } from "../lib/kind"
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
  moveEntryLane,
  queueEntryActions,
  removeQueueItem,
} from "../state/queueEntry"
import { splitLanes } from "../state/queueView"
import { curatedIds, useStore } from "../state/store"
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
        onRemove={() => removeQueueItem(setId, item)}
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
          face.title + (face.year ? ` (${face.year})` : "")
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
  }

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
          <ChevronDownIcon />
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
          <span className="lbl">{label}</span>
          <span className="sec">{items.length}</span>
          {laneClause ? (
            <span className="lanes-sec">{laneClause}</span>
          ) : null}
        </Link>
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
              {lanes.priority.map((item) =>
                renderTile(item, "priority"),
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
  const { collapsed, filter, hasCollapsePreference } =
    useUi()
  const shelvesRef = useRef<HTMLDivElement>(null)

  useHomeDrags(shelvesRef)

  // Shelf heights are deterministic (fixed tile size + aspect-ratio), so the page
  // height is settled synchronously — restore the pre-navigation scroll on the next
  // frame.
  useEffect(() => {
    const y = homeScroll.y

    requestAnimationFrame(() => window.scrollTo(0, y))
    // Only on entering the view, which is now the same thing as mounting it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const playingSet = activeSet(now, data)

  // WP-5. Two queues may share people and activity — "Allow, and add a number."
  //
  // Over the shelves THIS PAGE DRAWS, in the order it draws them, and not over the registry.
  // A number is how you tell two cards apart, so it only means anything among cards somebody
  // can see at once: numbering the registry made this page open at "Movies & Shows 3",
  // because two filtered pools on the Pools page had taken 1 and 2.
  // EVERY Picks queue, both lane defaults. It was the priority-lane half until 2026-08-26,
  // which is what left `Kevin — Anime` and nine others listed on the Rules page instead
  // (decision `2026-08-26-a-picks-queue-lives-on-the-picks-screen-whichever-lane-it-defaults-to`).
  const shelfIds = curatedIds(data)
  const numbers = queueNumbers(
    shelfIds
      .map((id) => reg?.sets.find((s) => s.id === id))
      .filter((s): s is NonNullable<typeof s> => s != null),
    people.byQueue,
  )

  return (
    <div className="view" id="home">
      <div id="gslot-narrow">{toolbar}</div>
      <div id="shelves" ref={shelvesRef}>
        {shelfIds.map((id) => {
          const q = data!.sets[id]!
          const registrySet = reg?.sets.find(
            (s) => s.id === id,
          )
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
            <Shelf
              groups={people.groups}
              isCollapsed={
                !hasCollapsePreference || collapsed.has(id)
              }
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
                registrySet?.provider_kind ?? ""
              }
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
          )
        })}
      </div>
    </div>
  )
}
