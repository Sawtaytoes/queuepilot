import { Badge, Skeleton } from "@charcuterie/ui"

import type { TileFace } from "../lib/tileFace"
import type { QueueItem, TileEntry } from "../lib/types"
import { Tip } from "./Tip"

/**
 * The type badge — which now renders NOTHING for a plain show or movie.
 *
 * A poster already says "this is a show". A chip repeating it on every single tile was
 * the noisiest thing in the grid and the least informative, and it was also what forced
 * the type axis to borrow the intent palette (`accent`/`success`/`info`) that the WATCH
 * STATE axis needs — which is how green came to mean "collection" on one chip and "now
 * playing" on the next.
 *
 * Two things survive, because neither is type-as-taxonomy:
 *
 *  - **Not in library** — availability, not type. The one chip that says the entry will
 *    not play at all.
 *  - **The two-part Collection chip** — it carries the collection's NAME, which the tile
 *    has nowhere else, and it is what tells you playback rolls on into the next series in
 *    that collection. Behaviour, not taxonomy.
 *    (decision `2026-07-31-collection-tiles-are-member-first`)
 *
 * (decision `2026-08-15-badge-intent-means-one-thing`)
 */
export function TypeBadge({
  face,
  item,
}: {
  face: TileFace
  item: TileEntry
}) {
  /**
   * The SKELETON phase (`/api/shelves` landed, `/api/queues` has not). The type is
   * genuinely unknown yet, so neither the real badge nor "Not in library" is
   * truthful — and flashing a red "Not in library" on every tile for two seconds of
   * every page load is exactly the bug this phase exists to remove. A placeholder at
   * badge height keeps the caption block from growing when the real badge arrives.
   */
  if ((item as QueueItem).pending) {
    return (
      <Skeleton
        blockSize="1.25rem"
        inlineSize="4.5rem"
        shape="block"
      />
    )
  }

  if (!item.resolved) {
    return (
      <Badge
        appearance="outline"
        className="badge warn"
        intent="danger"
        size="sm"
      >
        Not in library
      </Badge>
    )
  }

  /**
   * The ONE badge that stays hand-rolled, and the work order predicted it:
   * a two-part chip — a filled "Collection" kind fused to the collection's
   * name, which truncates. `Badge` puts its children inside a single label
   * span that is itself `overflow-hidden text-ellipsis whitespace-nowrap`,
   * so the two halves would collapse into one ellipsised run of text
   * instead of sitting side by side with a divider between them. Getting
   * them back would mean an app rule reaching into that inner span, which
   * is worse than not using the component. Reported to M6f as the missing
   * `Badge` shape rather than worked around here.
   */
  if (item.type === "collection" && face.from) {
    return (
      <Tip
        label={`Plays in order through the “${face.from}” collection`}
      >
        <span className="badge collection">
          <span className="badgekind">Collection</span>
          <span className="badgename">{face.from}</span>
        </span>
      </Tip>
    )
  }

  // A plain show or movie says nothing here — the poster already did. (A collection
  // reaching this line has no member to name, which the member-first tile makes
  // vanishingly rare; it falls through to silence rather than to a lone bare chip.)
  return null
}

/**
 * "Seen N×" read as a delete affordance (Bob) — an inline filled-eye SVG +
 * "N watch(es)" instead, kept muted like the other badges.
 */
export function WatchesBadge({ count }: { count: number }) {
  const n = Number(count) || 0

  return (
    <Tip
      label={`Watched ${n} ${n === 1 ? "time" : "times"}`}
    >
      <Badge
        appearance="outline"
        className="badge watches"
        icon={
          <svg
            aria-hidden="true"
            height="12"
            viewBox="0 0 16 16"
            width="12"
          >
            <path
              d="M8 3.5C4.6 3.5 1.8 5.6.7 8c1.1 2.4 3.9 4.5 7.3 4.5S14.2 10.4 15.3 8C14.2 5.6 11.4 3.5 8 3.5zm0 7.5A3 3 0 1 1 8 5a3 3 0 0 1 0 6zm0-1.6A1.4 1.4 0 1 0 8 6.6a1.4 1.4 0 0 0 0 2.8z"
              fill="currentColor"
            />
          </svg>
        }
        intent="neutral"
        size="sm"
      >
        {`${n} ${n === 1 ? "watch" : "watches"}`}
      </Badge>
    </Tip>
  )
}
