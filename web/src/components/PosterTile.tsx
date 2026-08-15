import { Skeleton } from "@charcuterie/ui"
import type { ReactNode } from "react"

import { Poster } from "./Poster"
import { Tip } from "./Tip"

/**
 * The poster tile shell — the vanilla `#tile-tpl` template, as a component.
 *
 * Shared by the Home shelf (read-only), the queue grid (editable), the channel
 * member grid (editable) and the channel eligible pool (read-only, no chrome), so
 * the same entry reads identically wherever it appears. Its class names are the
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
   */
  onPlay?: (anchor: DOMRect) => void
  playTitle?: string
  /** The × — queue grid and member grid. */
  onRemove?: () => void
  removeTitle?: string
  /** Right-click / long-press opens the per-entry menu (editable grids only). */
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
  playTitle = "Play this now",
  posterCover,
  posterRatingKey,
  removeTitle = "Remove",
  title,
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
        {onPlay ? (
          <Tip label={playTitle}>
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
              <svg
                aria-hidden="true"
                height="14"
                viewBox="0 0 14 14"
                width="14"
              >
                <path
                  d="M3 1.5l9 5.5-9 5.5z"
                  fill="currentColor"
                />
              </svg>
            </button>
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
        <Tip label={titleTooltip ?? title}>
          <span className="title">{title}</span>
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
