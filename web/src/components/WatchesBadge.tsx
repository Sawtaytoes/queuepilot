import { Badge } from "@charcuterie/ui"
import { Tip } from "./Tip"

/**
 * "Seen N×" read as a delete affordance (Bob) — an inline filled-eye SVG +
 * "N watch(es)" instead, kept muted like the other badges.
 */
export function WatchesBadge({ count }: { count: number }) {
  const watchCount = Number(count) || 0

  return (
    <Tip
      label={`Watched ${watchCount} ${watchCount === 1 ? "time" : "times"}`}
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
        {`${watchCount} ${watchCount === 1 ? "watch" : "watches"}`}
      </Badge>
    </Tip>
  )
}
