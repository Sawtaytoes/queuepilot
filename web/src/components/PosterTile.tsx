import { Skeleton } from "@charcuterie/ui"
import type { ReactNode } from "react"

import { Poster } from "./Poster"
import { Tip } from "./Tip"

/**
 * The poster tile shell — the vanilla `#tile-tpl` template, as a component.
 *
 * Shared by the Home shelf, the queue grid, the channel member grid (all three
 * editable — every one of them can remove an entry) and the channel eligible pool
 * (read-only, no chrome), so the same entry reads identically wherever it appears. Its class names are the
 * e2e suites' contract (`li.tile`, `.thumb`, `.poster`, `.check`, `.remove`,
 * `.cap`, `.title`, `.next`, `.badges`) and `data-key` must be stable across
 * re-render, drag and reload.
 *
 * `.check` and `.remove` are SIBLINGS of `.thumb`, not children of it. They used to
 * be absolutely positioned inside the poster, which the poster wall can afford and
 * the other two densities cannot: on a 40px row thumb a 28px ✕ covers the artwork
 * entirely, and shrinking it (the old `transform: scale(.75)`) only made it a
 * smaller thing sitting on top of the art. Out here, `cards`/`rows` can give each
 * control its own grid column — off the poster, in the card — while `posters` keeps
 * overlaying them via `position: absolute` on the tile.
 * (decision `2026-08-15-tile-controls-are-quiet-and-sit-beside-the-poster`)
 */

type Props = {
  dataKey: string
  dataSet?: string
  className?: string
  posterRatingKey?: string | null
  /** A non-Plex entry's server-sent artwork URL (see `Poster`). */
  posterCover?: string | null
  title: string
  titleTooltip?: string
  /**
   * The item's page in the app that owns it (Plex, Kavita) — the server sends it as
   * `webUrl` and the title becomes the link to it
   * (decision `2026-08-22-a-tile-links-to-its-item-in-plex-or-kavita`).
   *
   * The TITLE and not a chip: the tile already carries a ▶, a ✓, a ✕ and an Edit chip, and
   * the owner's words were that a new control has nowhere to go. Absent/null renders the
   * title as plain text, which is what an unresolved entry gets.
   */
  titleHref?: string | null
  /** What opening `titleHref` reaches, for the link's accessible name ("Plex", "Kavita"). */
  titleHrefLabel?: string
  next?: {
    text: string
    tooltip?: string
    isDone?: boolean
    onStart?: () => void
  }
  badges?: ReactNode
  /** The multi-select checkbox — queue grid only. */
  onCheck?: () => void
  /**
   * Start THIS entry now — the ▶ over the poster, queue/channel grid only. Takes the
   * button's viewport box because what it opens is the same fixed-position device menu
   * "Play on ▾" opens; nothing here plays without naming a device.
   *
   * PUSH queues only. A pull queue passes `playHref` instead — see below.
   */
  onPlay?: (anchor: DOMRect) => void
  /**
   * Start THIS entry now on a PULL queue: a URL to open, not a device menu.
   *
   * The same split `OpenQueueButton` makes for the queue-level button, applied to the tile.
   * Kavita has no cast and no webhooks, so the device menu this tile used to open offered a
   * Shield, a Plex Dash and a phone for something none of them can open — reported live on
   * 2026-08-15. An anchor rather than a button because it NAVIGATES, so it middle-clicks and
   * bookmarks like every other link (decision `2026-08-15-navigation-is-an-anchor-not-a-button`).
   *
   * Ignored when `onPlay` is also given; a queue is one or the other, never both.
   */
  playHref?: string
  playTitle?: string
  /**
   * The ✕.
   *
   * EVERY editable grid passes this. The shelf did not until 2026-08-21, so the one
   * page that reorders a title and drags it into another queue was also the one page
   * that could not remove it — the owner had to open `/q/<id>` first. Its presence is
   * what the CSS keys on, so a tile that renders one always shows one
   * (decision `2026-08-21-any-tile-in-an-editable-grid-gets-the-remove-control`).
   */
  onRemove?: () => void
  removeTitle?: string
  /** Right-click / long-press opens the per-entry menu (editable grids only —
   *  the shelf, the queue grid and the member grid). */
  onContextMenu?: (
    e: React.MouseEvent<HTMLLIElement>,
  ) => void
  /**
   * This entry came from `/api/shelves` and `/api/queues` has not resolved it yet.
   * The tile still occupies its full final geometry (`.thumb` carries
   * `aspect-ratio: 2/3` unconditionally), so this only changes what fills the
   * poster box — a shimmer instead of an empty rectangle. The swap when the
   * resolved response lands moves nothing.
   */
  isPending?: boolean
}

/** The ▶, shared by the push button and the pull link so the two cannot drift apart. */
const PlayGlyph = () => (
  <svg
    aria-hidden="true"
    height="14"
    viewBox="0 0 14 14"
    width="14"
  >
    <path d="M3 1.5l9 5.5-9 5.5z" fill="currentColor" />
  </svg>
)

export function PosterTile({
  badges,
  className,
  dataKey,
  dataSet,
  isPending,
  next,
  onCheck,
  onContextMenu,
  onPlay,
  onRemove,
  playHref,
  playTitle = "Play this now",
  posterCover,
  posterRatingKey,
  removeTitle = "Remove",
  title,
  titleHref,
  titleHrefLabel = "Plex",
  titleTooltip,
}: Props) {
  const isStartable = Boolean(next?.onStart && next.text)

  return (
    <li
      className={`tile${isPending ? " pending" : ""}${className ? ` ${className}` : ""}`}
      data-key={dataKey}
      data-set={dataSet}
      onContextMenu={onContextMenu}
      tabIndex={0}
    >
      {onCheck ? (
        <span
          aria-hidden="true"
          className="check"
          onClick={onCheck}
        >
          ✓
        </span>
      ) : null}
      <div className="thumb">
        {/* `aria-hidden` on Skeleton is the component's contract — the LOAD is
            announced by the owning region's `aria-busy`, never by the placeholder. */}
        {isPending ? (
          <Skeleton
            blockSize="100%"
            inlineSize="100%"
            shape="block"
          />
        ) : null}
        <Poster
          className="poster"
          cover={posterCover}
          ratingKey={posterRatingKey}
        />
        {/* Centred ON the artwork, unlike ✓/✕ — this one is about the thing in the picture,
            and it is the affordance Plex puts there too, so it is the one place the poster
            is worth covering. Inside `.thumb` so it centres on the poster in every density
            without a second set of per-density rules. */}
        {onPlay || playHref ? (
          <Tip label={playTitle}>
            {onPlay ? (
              <button
                aria-label={playTitle}
                className="tileplay"
                onClick={(e) => {
                  e.stopPropagation()
                  onPlay(
                    e.currentTarget.getBoundingClientRect(),
                  )
                }}
                type="button"
              >
                <PlayGlyph />
              </button>
            ) : (
              <a
                aria-label={playTitle}
                className="tileplay"
                href={playHref}
                // The click must not also select/open the tile underneath — the same reason
                // the button above stops propagation.
                onClick={(e) => e.stopPropagation()}
                rel="noreferrer"
                // A new tab, so the queue you launched from is still there when you come
                // back from the reader — matching OpenQueueButton.
                target="_blank"
              >
                <PlayGlyph />
              </a>
            )}
          </Tip>
        ) : null}
      </div>
      {onRemove ? (
        <Tip label={removeTitle}>
          <button
            aria-label={removeTitle}
            className="remove"
            onClick={onRemove}
            type="button"
          >
            <svg
              aria-hidden="true"
              height="12"
              viewBox="0 0 12 12"
              width="12"
            >
              <path
                d="M1.5 1.5l9 9M10.5 1.5l-9 9"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="2"
              />
            </svg>
          </button>
        </Tip>
      ) : null}
      <div className="cap">
        <Tip
          label={
            titleHref
              ? `${titleTooltip ?? title}\nOpens in ${titleHrefLabel}`
              : (titleTooltip ?? title)
          }
        >
          {/* The `.title` SPAN survives the link: it is the class the e2e suites read a
              tile's caption from, and the four density rules (`ul.grid.rows .tile .title`
              and friends) all hang off it. The anchor lives inside it, so nothing that
              selects `.title` changes.

              `draggable={false}` because a tile is a drag source — a browser drags an
              anchor as a URL by default, which would replace the reorder with a link drag.
              `stopPropagation` because the tile itself is clickable underneath. */}
          <span className="title">
            {titleHref ? (
              <a
                draggable={false}
                href={titleHref}
                onClick={(e) => e.stopPropagation()}
                rel="noreferrer"
                // A new tab: the queue you were arranging is still there when you come back,
                // matching the ▶ link and OpenQueueButton.
                target="_blank"
              >
                {title}
              </a>
            ) : (
              title
            )}
          </span>
        </Tip>
        {/* The manual start point has NO always-on control — the next-up line
            itself is the button, which is touch-reachable in a way a right-click is
            not (decision 2026-07-31-start-episode-is-picked-in-a-modal).

            The episode line's readout is the styled Charcuterie `Tooltip`, not a
            native `title` — it carries extra ("N in order", "Tap to choose where this
            starts"), which is what a Tooltip is for, and it matches the rest of the
            chrome instead of the OS's slow grey box. */}
        <Tip label={next?.tooltip ?? next?.text}>
          <span
            className={`next${next?.isDone ? " done" : ""}${isStartable ? " startable" : ""}`}
            onClick={
              isStartable ? next?.onStart : undefined
            }
            onKeyDown={
              isStartable
                ? (e) => {
                    if (
                      e.key === "Enter" ||
                      e.key === " "
                    ) {
                      e.preventDefault()
                      next?.onStart?.()
                    }
                  }
                : undefined
            }
            role={isStartable ? "button" : undefined}
            tabIndex={isStartable ? 0 : undefined}
          >
            {next?.text ?? ""}
          </span>
        </Tip>
        <span className="badges">{badges}</span>
      </div>
    </li>
  )
}
