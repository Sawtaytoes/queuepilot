import { Badge, EmptyState } from "@charcuterie/ui"
import { useCallback, useEffect, useLayoutEffect, useRef } from "react"

import { activeSet, isPlayingItem } from "../lib/nowPlaying"
import { tileFace } from "../lib/tileFace"
import type { NowState, QueueItem } from "../lib/types"
import { TypeBadge } from "../components/badges"
import { PosterTile } from "../components/PosterTile"
import { useHomeDrags } from "../hooks/useHomeDrags"
import { openPlayMenu, openSetModal } from "../state/overlays"
import { navigate } from "../state/route"
import { queueIds, useStore } from "../state/store"
import { homeScroll, toggleCollapsed, useUi } from "../state/ui"

/**
 * QUEUES — the configurator. Every ordered queue is a horizontal poster shelf, so
 * all of them are glanceable but only one is "expanded" at a time; tapping one
 * opens it as a grid. Posters drag within and between shelves; the ≡ handle
 * reorders whole shelves. (decision `2026-07-20-queue-web-ui-ux-and-write-format`)
 */

/** A shelf matches the filter on its label OR any title inside it. */
function shelfMatches(
  filter: string,
  label: string,
  items: { title?: string }[],
) {
  if (!filter) return true

  const f = filter.toLowerCase()

  if (label.toLowerCase().includes(f)) return true

  return items.some((it) => (it.title || "").toLowerCase().includes(f))
}

function Shelf({
  isCollapsed,
  isHiddenByFilter,
  items,
  label,
  now,
  playingSet,
  setId,
}: {
  setId: string
  label: string
  items: QueueItem[]
  isCollapsed: boolean
  isHiddenByFilter: boolean
  now: NowState
  playingSet: string | null
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
      strip.scrollLeft < strip.scrollWidth - strip.clientWidth - 2

    if (leftRef.current) leftRef.current.hidden = !hasMoreLeft
    if (rightRef.current) rightRef.current.hidden = !hasMoreRight

    wrap.classList.toggle("more-left", hasMoreLeft)
    wrap.classList.toggle("more-right", hasMoreRight)
  }, [])

  useLayoutEffect(() => {
    requestAnimationFrame(updateArrows)
  })

  useEffect(() => {
    // A viewport resize changes how much of each strip fits.
    window.addEventListener("resize", updateArrows)

    return () => window.removeEventListener("resize", updateArrows)
  }, [updateArrows])

  const isLive = setId === playingSet

  return (
    <section
      className={`shelf${isCollapsed ? " collapsed" : ""}${isLive ? " live" : ""}`}
      data-set={setId}
      hidden={isHiddenByFilter}
    >
      <h2>
        <button
          aria-label="collapse queue"
          className="collapse"
          onClick={() => toggleCollapsed(setId)}
          type="button"
        >
          ▾
        </button>
        <button
          className="open"
          onClick={() => {
            homeScroll.y = window.scrollY // restore this position when we come back
            navigate(`#/q/${setId}`)
          }}
          type="button"
        >
          <span className="lbl">{label}</span>
          {" "}
          <span className="sec">{items.length}</span>
          {" "}
          <span className="chev">›</span>
        </button>
        <span className="livepill" hidden={!isLive}>
          {isLive && now.now?.state === "paused" ? "Paused" : "Playing"}
        </span>
        <span className="shelfspacer" />
        <button
          className="shelfplay"
          onClick={(e) =>
            openPlayMenu({
              anchor: e.currentTarget.getBoundingClientRect(),
              setId,
            })}
          title="Play this queue on a device"
          type="button"
        >
          ▶
        </button>
        <button
          className="shelfedit"
          onClick={() => openSetModal(setId)}
          title="Edit queue"
          type="button"
        >
          ⚙
        </button>
        <button
          className="shelfdrag"
          title="Drag to reorder queues"
          type="button"
        >
          ≡
        </button>
      </h2>
      <div className="strip-wrap" ref={wrapRef}>
        <button
          aria-label="scroll left"
          className="scroll left"
          onClick={() =>
            stripRef.current?.scrollBy({
              left: -stripRef.current.clientWidth * 0.85,
            })}
          ref={leftRef}
          type="button"
        >
          ‹
        </button>
        <ul className="strip" onScroll={updateArrows} ref={stripRef}>
          {items.length === 0
            ? (
                <li className="empty">
                  <EmptyState
                    description="Open it to add something."
                    heading="Empty"
                    headingLevel={3}
                    size="sm"
                  />
                </li>
              )
            : items.map((item) => {
                const face = tileFace(item)
                const isPlaying = isLive && isPlayingItem(now, item)

                return (
                  <PosterTile
                    badges={
                      <>
                        <TypeBadge face={face} item={item} />
                        {/* "In Progress" wins over "Completed": a mid-episode resume point
                            (Plex viewOffset, unwatched) means the item is being watched, not
                            finished — the Prison School OAD case must never read "Completed". */}
                        {item.partiallyWatched
                          ? (
                              <Badge
                                appearance="outline"
                                className="badge progressbadge"
                                intent="accent"
                                size="sm"
                              >
                                In Progress
                              </Badge>
                            )
                          : item.done
                            ? (
                                <Badge
                                  appearance="outline"
                                  className="badge donebadge"
                                  intent="neutral"
                                  size="sm"
                                >
                                  Completed
                                </Badge>
                              )
                            : null}
                        {/* Solid, not outline: this one has to win against the
                            type and Completed chips beside it. Green rather than
                            amber so it never reads as the selection outline. */}
                        {isPlaying
                          ? (
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
                            )
                          : null}
                      </>
                    }
                    className={[
                      // `pending` is not `unresolved`: the red border means "this
                      // entry names something Plex does not have", and a tile that
                      // simply hasn't been resolved YET has made no such claim.
                      item.resolved || item.pending ? null : "unresolved",
                      item.done ? "done" : null,
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
                    posterRatingKey={item.resolved ? face.ratingKey : null}
                    title={face.title + (face.year ? ` (${face.year})` : "")}
                    titleTooltip={
                      face.from
                        ? `${face.fullTitle || face.title} — from the “${face.from}” collection`
                        : face.title + (face.year ? ` (${face.year})` : "")
                    }
                  />
                )
              })}
        </ul>
        <button
          aria-label="scroll right"
          className="scroll right"
          onClick={() =>
            stripRef.current?.scrollBy({
              left: stripRef.current.clientWidth * 0.85,
            })}
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
  const { data, now } = useStore()
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

  return (
    <main className="view" hidden={isHidden} id="home">
      <div id="gslot-mobile">{toolbar}</div>
      <div id="shelves" ref={shelvesRef}>
        {isHidden
          ? null
          : queueIds(data).map((id) => {
              const q = data!.sets[id]!

              return (
                <Shelf
                  isCollapsed={collapsed.has(id)}
                  isHiddenByFilter={!shelfMatches(filter, q.label, q.items)}
                  items={q.items}
                  key={id}
                  label={q.label}
                  now={now}
                  playingSet={playingSet}
                  setId={id}
                />
              )
            })}
      </div>
    </main>
  )
}
