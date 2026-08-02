import type { ReactNode } from "react"

import { thumbUrl } from "../lib/api"

/**
 * The poster tile shell — the vanilla `#tile-tpl` template, as a component.
 *
 * Shared by the Home shelf (read-only), the queue grid (editable), the channel
 * member grid (editable) and the channel eligible pool (read-only, no chrome), so
 * the same entry reads identically wherever it appears. Its class names are the
 * e2e suites' contract (`li.tile`, `.thumb`, `.poster`, `.check`, `.remove`,
 * `.cap`, `.title`, `.next`, `.badges`) and `data-key` must be stable across
 * re-render, drag and reload.
 */

type Props = {
  dataKey: string
  dataSet?: string
  className?: string
  posterRatingKey?: string | null
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
  /** The × — queue grid and member grid. */
  onRemove?: () => void
  removeTitle?: string
  /** Right-click / long-press opens the per-entry menu (editable grids only). */
  onContextMenu?: (e: React.MouseEvent<HTMLLIElement>) => void
}

export function PosterTile({
  badges,
  className,
  dataKey,
  dataSet,
  next,
  onCheck,
  onContextMenu,
  onRemove,
  posterRatingKey,
  removeTitle = "Remove",
  title,
  titleTooltip,
}: Props) {
  const isStartable = Boolean(next?.onStart && next.text)

  return (
    <li
      className={`tile${className ? ` ${className}` : ""}`}
      data-key={dataKey}
      data-set={dataSet}
      onContextMenu={onContextMenu}
      tabIndex={0}
    >
      <div className="thumb">
        {posterRatingKey
          ? (
              <img
                alt=""
                className="poster"
                draggable={false}
                loading="lazy"
                src={thumbUrl(posterRatingKey)}
              />
            )
          : null}
        {onCheck
          ? (
              <span
                aria-hidden="true"
                className="check"
                onClick={onCheck}
              >
                ✓
              </span>
            )
          : null}
        {onRemove
          ? (
              <button
                className="remove"
                onClick={onRemove}
                title={removeTitle}
                type="button"
              >
                <svg aria-hidden="true" height="12" viewBox="0 0 12 12" width="12">
                  <path
                    d="M1.5 1.5l9 9M10.5 1.5l-9 9"
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeWidth="2"
                  />
                </svg>
              </button>
            )
          : null}
      </div>
      <div className="cap">
        <span className="title" title={titleTooltip ?? title}>
          {title}
        </span>
        {/* The manual start point has NO always-on control — the next-up line
            itself is the button, which is touch-reachable in a way a right-click is
            not (decision 2026-07-31-start-episode-is-picked-in-a-modal). */}
        <span
          className={`next${next?.isDone ? " done" : ""}${isStartable ? " startable" : ""}`}
          onClick={isStartable ? next?.onStart : undefined}
          onKeyDown={
            isStartable
              ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault()
                    next?.onStart?.()
                  }
                }
              : undefined
          }
          role={isStartable ? "button" : undefined}
          tabIndex={isStartable ? 0 : undefined}
          title={next?.tooltip ?? next?.text}
        >
          {next?.text ?? ""}
        </span>
        <span className="badges">{badges}</span>
      </div>
    </li>
  )
}
