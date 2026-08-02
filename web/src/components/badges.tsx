import { Badge } from "@charcuterie/ui"

import type { TileFace } from "../lib/tileFace"
import type { TileEntry } from "../lib/types"

/**
 * The type badge. A collection whose tile shows a MEMBER names the collection here
 * — that is how you see which collection the series comes from (and that playback
 * rolls on into the next series in it). Unborrowed collections keep the plain word.
 * (decision `2026-07-31-collection-tiles-are-member-first`)
 */
export function TypeBadge({
  face,
  item,
}: {
  face: TileFace
  item: TileEntry
}) {
  if (!item.resolved) {
    return (
      <Badge appearance="outline" className="badge warn" intent="danger" size="sm">
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
      <span
        className="badge collection"
        title={`Plays in order through the “${face.from}” collection`}
      >
        <span className="badgekind">Collection</span>
        <span className="badgename">{face.from}</span>
      </span>
    )
  }

  return (
    <Badge
      appearance="outline"
      className={`badge ${item.type}`}
      intent={
        item.type === "show"
          ? "accent"
          : item.type === "collection"
            ? "success"
            : "info"
      }
      size="sm"
    >
      {item.type === "show"
        ? "Series"
        : item.type === "collection"
          ? "Collection"
          : "Movie"}
    </Badge>
  )
}

/**
 * "Seen N×" read as a delete affordance (Bob) — an inline filled-eye SVG +
 * "N watch(es)" instead, kept muted like the other badges.
 */
export function WatchesBadge({ count }: { count: number }) {
  const n = Number(count) || 0

  return (
    <Badge
      appearance="outline"
      className="badge watches"
      icon={
        <svg aria-hidden="true" height="12" viewBox="0 0 16 16" width="12">
          <path
            d="M8 3.5C4.6 3.5 1.8 5.6.7 8c1.1 2.4 3.9 4.5 7.3 4.5S14.2 10.4 15.3 8C14.2 5.6 11.4 3.5 8 3.5zm0 7.5A3 3 0 1 1 8 5a3 3 0 0 1 0 6zm0-1.6A1.4 1.4 0 1 0 8 6.6a1.4 1.4 0 0 0 0 2.8z"
            fill="currentColor"
          />
        </svg>
      }
      intent="neutral"
      size="sm"
      title={`Watched ${n} ${n === 1 ? "time" : "times"}`}
    >
      {`${n} ${n === 1 ? "watch" : "watches"}`}
    </Badge>
  )
}
