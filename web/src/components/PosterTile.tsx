import { Skeleton } from "@charcuterie/ui"
import type { ReactNode } from "react"

import { Poster } from "./Poster"
import { PriorityPositionInput } from "./PriorityPositionInput"
import { Tip } from "./Tip"

/**
 * The poster tile shell — the vanilla `#tile-tpl` template, as a component.
 *
 * Shared by the Home shelf, the queue grid, the channel member grid (all three
 * editable — every one of them can remove an entry) and the channel eligible pool
 * (read-only, no chrome), so the same entry reads identically wherever it appears. Its class names are the
 * e2e suites' contract (`li.tile`, `.thumb`, `.poster`, `.check`, `.remove`,
 * `.tilechrome`, `.cap`, `.title`, `.next`, `.badges`) and `data-key` must be stable
 * across re-render, drag and reload. `.editbtn` lives in the badge row (QueueView),
 * not in this chrome.
 *
 * `.tilechrome` (✕ above ✓) is a SIBLING of `.thumb`, not a child of it. The
 * controls used to be absolutely positioned inside the poster, which the poster
 * wall can afford and the other two densities cannot: on a 40px row thumb a 28px ✕
 * covers the artwork entirely. Out here, `cards`/`rows` give the stack its own
 * grid column — off the poster, in the card — while `posters` overlays it via
 * `position: absolute` on the tile.
 * (decision `2026-08-15-tile-controls-are-quiet-and-sit-beside-the-poster`)
 *
 * ✕ sits alone at the top-right; ✓ stacks under it so a reach for select does not
 * also hit remove. Edit is an outline pencil pill in the badge row, away from ✕
 * (decision `2026-08-25-checkmark-under-x-edit-by-the-labels`).
 */

type Props = {
  dataKey: string
  dataSet?: string
  className?: string
  posterRatingKey?: string | null
  /** A non-Plex entry's server-sent artwork URL (see `Poster`). */
  posterCover?: string | null
  /** Editable one-based order, present only for a tile in the Priority queue. */
  priorityPosition?: {
    count: number
    onChange: (position: number) => void
    position: number
  }
  title: string
  titleTooltip?: string
  /**
   * The item's page in the app that owns it (Plex, Kavita) — the server sends it as
   * `webUrl` and the title becomes the link to it
   * (decision `2026-08-22-a-tile-links-to-its-item-in-plex-or-kavita`).
   *
   * The TITLE and not a chip: the tile already carries a ▶, a ✓ and a ✕, and the
   * owner's words were that a new control has nowhere to go. Absent/null renders the
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
  /**
   * How long the next thing runs — "24 min", "2 x 24 min · about 48 min". Its OWN line,
   * under the next-up line: on the next-up line it competed with an episode title that
   * already truncates, and in the badge row it read as one more chip
   * (decision `2026-08-22-a-tile-names-the-runtime-on-its-own-line`).
   *
   * Absent/null renders nothing at all — a reading queue and a board game have no runtime,
   * and an empty line would leave a gap on those tiles.
   */
  runtime?: string | null
  badges?: ReactNode
  /** The multi-select checkbox — queue grid only. Stacks under ✕ in `.tilechrome`. */
  onCheck?: () => void
  /**
   * Is this tile in the selection? The control is a real `aria-pressed` button, so the state
   * has to reach it — the CSS used to read `.tile.selected` on an ancestor instead, and it
   * lost that fight on specificity (see `CheckGlyph`).
   */
  isChecked?: boolean
  /**
   * Move this entry between the two lanes — into the Priority queue, or back out to the
   * Random pool. The third control in the stack, under ✓.
   *
   * The same answer the drag across the lane divider gives, reachable without a drag
   * (owner, 2026-08-26: "instead of right-click, I think we should add a 3rd icon under the
   * checkbox that allows you to move it into Priority or out of Priority"). Absent on every
   * grid that has no lanes — the shelf, the channel member grid.
   */
  onLane?: () => void
  /** Which lane the entry is in NOW, which decides the arrow's direction and its label. */
  isPriority?: boolean
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
   * The ✕. Sits at the top of `.tilechrome`; ✓ stacks under it when both exist.
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

/**
 * ✓ — the select mark, as an SVG.
 *
 * It was the TEXT character `✓` until 2026-08-26, and it never painted: the rule that turns a
 * selected tile's circle accent (`.tile.selected .check`) is outranked by the one that draws
 * the circle in the first place (`.editable .tile .tilechrome .check`), so the mark stayed
 * `color: transparent` in every state and the control looked identical checked and unchecked.
 * The same reason `.remove` gives for its ×: a font glyph is not a reliable icon here.
 */
const CheckGlyph = () => (
  <svg
    aria-hidden="true"
    fill="none"
    height="13"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth="2.5"
    viewBox="0 0 14 14"
    width="13"
  >
    <path d="M2.5 7.5l3 3 6-6.5" />
  </svg>
)

/**
 * ↑ / ↓ — into the Priority queue, or back out to the Random pool.
 *
 * The arrow points the way the tile MOVES on screen: the Priority lane is drawn above the
 * pool, so up is a promote and down is a demote. It is the same write the drag across the
 * lane divider makes, for a pointer that would rather press a button than drag one
 * (owner, 2026-08-26).
 */
const LaneGlyph = ({ isUp }: { isUp: boolean }) => (
  <svg
    aria-hidden="true"
    fill="none"
    height="13"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth="2"
    viewBox="0 0 14 14"
    width="13"
  >
    {isUp ? (
      <path d="M7 11.5V2.5M3 6.5l4-4 4 4" />
    ) : (
      <path d="M7 2.5v9M3 7.5l4 4 4-4" />
    )}
  </svg>
)

/**
 * Pencil — the Edit affordance in the badge row (QueueView). Exported so the
 * outline pill and this shell cannot drift to different glyphs.
 */
export const PencilGlyph = () => (
  <svg
    aria-hidden="true"
    fill="none"
    height="12"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth="1.75"
    viewBox="0 0 24 24"
    width="12"
  >
    <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
  </svg>
)

export function PosterTile({
  badges,
  className,
  dataKey,
  dataSet,
  isChecked = false,
  isPending,
  isPriority = false,
  next,
  onCheck,
  onLane,
  onContextMenu,
  onPlay,
  onRemove,
  playHref,
  playTitle = "Play this now",
  posterCover,
  posterRatingKey,
  priorityPosition,
  removeTitle = "Remove",
  runtime,
  title,
  titleHref,
  titleHrefLabel = "Plex",
  titleTooltip,
}: Props) {
  const isStartable = Boolean(next?.onStart && next.text)
  const hasChrome = Boolean(onCheck || onRemove || onLane)
  const laneTitle = isPriority
    ? "Move out of the Priority queue"
    : "Move to the Priority queue"
  const checkTitle = isChecked
    ? "Deselect this entry"
    : "Select this entry"

  return (
    <li
      className={`tile${isPending ? " pending" : ""}${className ? ` ${className}` : ""}`}
      data-key={dataKey}
      data-set={dataSet}
      onContextMenu={onContextMenu}
      tabIndex={0}
    >
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
        {priorityPosition ? (
          <PriorityPositionInput
            count={priorityPosition.count}
            onChange={priorityPosition.onChange}
            position={priorityPosition.position}
            title={title}
          />
        ) : null}
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
      {/* ✕ on top, ✓ under it — one stack at the trailing edge so a press for
          select does not land on remove.
          (decision `2026-08-25-checkmark-under-x-edit-by-the-labels`) */}
      {hasChrome ? (
        <div className="tilechrome">
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
          {/* A BUTTON, not a `<span aria-hidden>`: it holds state, it is the only way to
              build a multi-select from the keyboard, and a screen reader was told to ignore
              it. `aria-pressed` is what announces the state a `.selected` class used to
              carry alone. */}
          {onCheck ? (
            <Tip label={checkTitle}>
              <button
                aria-label={checkTitle}
                aria-pressed={isChecked}
                className="check"
                onClick={onCheck}
                type="button"
              >
                <CheckGlyph />
              </button>
            </Tip>
          ) : null}
          {onLane ? (
            <Tip label={laneTitle}>
              <button
                aria-label={laneTitle}
                className="lanebtn"
                onClick={onLane}
                type="button"
              >
                <LaneGlyph isUp={!isPriority} />
              </button>
            </Tip>
          ) : null}
        </div>
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
        {runtime ? (
          <span className="runtime">{runtime}</span>
        ) : null}
        <span className="badges">{badges}</span>
      </div>
    </li>
  )
}
