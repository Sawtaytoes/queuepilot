import { Badge } from "@charcuterie/ui"
import type { ReactNode } from "react"

import { seasonDayLabel } from "../lib/season"
import type { RegistrySet } from "../lib/types"

/**
 * THE OUT-OF-SEASON MARK, on the card the queue still has.
 *
 * A queue out of its season is not offered on What to Watch/Play and will not start, but it is
 * still HERE, still opens and is still editable — "a queue that vanishes is a support
 * question; a queue that says 'Out of season · returns 1 Oct' is an answer"
 * (decision `2026-09-08-a-season-window-gates-the-existing-enabled-flag`).
 *
 * Three things it deliberately does not do:
 *
 *   * It does NOT re-derive the calendar. `is_in_season` is the server's answer, computed on
 *     the read that produced this row, and there is exactly one implementation of that rule.
 *   * It does NOT mark a queue the owner switched off by hand. `enabled` and the window are
 *     independent gates; blaming the calendar for a flipped switch would send somebody to the
 *     wrong control.
 *   * It says nothing about watched state, because a season boundary changes none.
 *
 * ONE COMPONENT FOR EVERY SCREEN THAT MARKS ONE. Both shelf kinds on `/queues` and every row
 * of `/calendar` — a Rules pool is as seasonal as a Picks queue, and a second copy of a mark
 * is how one of them stops matching the other. It lived inside `QueuesView` until the calendar
 * view became its third caller.
 */
export function SeasonMark({
  set,
}: {
  set: Pick<
    RegistrySet,
    "is_in_season" | "season_start"
  > | null
}): ReactNode {
  if (set?.is_in_season !== false) return null
  const returns = seasonDayLabel(set.season_start)

  return (
    <Badge intent="neutral" size="sm">
      {returns
        ? `Out of season · returns ${returns}`
        : "Out of season"}
    </Badge>
  )
}
