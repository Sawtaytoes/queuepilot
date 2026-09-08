/**
 * THE SEASON WINDOW, browser side — and deliberately NOT a second copy of the rule.
 *
 * The server answers `is_in_season` on every set it reports, computed on the read that
 * produced the row, so nothing here compares a date to anything. What lives here is DISPLAY:
 * the words a shelf card prints, and the two spellings of a `MM-DD` the editors read and
 * write. The month and day pickers' OPTIONS moved to `lib/monthDay.ts` on 2026-09-08, when the
 * calendar view became the third caller of the same twelve-row list.
 *
 * That split is on purpose. `tonightRouting.ts` is the app's cautionary tale about a table
 * written twice on two sides of the wire — it needs a gate whose whole job is to notice the
 * day the two disagree. A calendar rule written twice would need the same, and it does not
 * have to be written twice
 * (decision `2026-09-08-a-season-window-gates-the-existing-enabled-flag`).
 */

import {
  MONTH_LENGTHS,
  MONTH_NAMES_SHORT,
} from "./monthDay"

/** `"10-01"` → `{month: 10, day: 1}`. Null for absent or unreadable, which is what the server
 *  reports as "no window". */
export function parseSeasonDay(
  value: string | null | undefined,
): { month: number; day: number } | null {
  const match = /^(\d{1,2})-(\d{1,2})$/.exec(
    (value ?? "").trim(),
  )
  if (!match) return null
  const month = Number(match[1])
  const day = Number(match[2])
  if (month < 1 || month > 12) return null
  if (day < 1 || day > (MONTH_LENGTHS[month - 1] ?? 31))
    return null

  return { day, month }
}

/** `"10-01"` → `"1 Oct"` — the words on an out-of-season shelf card. Empty for no window, so
 *  a caller can render the mark on truthiness alone. */
export function seasonDayLabel(
  value: string | null | undefined,
): string {
  const parsed = parseSeasonDay(value)
  if (!parsed) return ""

  return `${parsed.day} ${MONTH_NAMES_SHORT[parsed.month - 1] ?? ""}`.trim()
}

/** `"10-01"`, the one spelling the server stores. */
export function seasonDayValue(
  month: string,
  day: string,
): string {
  if (!month || !day) return ""

  return `${month.padStart(2, "0")}-${day.padStart(2, "0")}`
}
