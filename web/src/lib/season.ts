/**
 * THE SEASON WINDOW, browser side — and deliberately NOT a second copy of the rule.
 *
 * The server answers `is_in_season` on every set it reports, computed on the read that
 * produced the row, so nothing here compares a date to anything. What lives here is DISPLAY:
 * the words a shelf card prints, and the options the two pickers in the Set editor offer.
 *
 * That split is on purpose. `tonightRouting.ts` is the app's cautionary tale about a table
 * written twice on two sides of the wire — it needs a gate whose whole job is to notice the
 * day the two disagree. A calendar rule written twice would need the same, and it does not
 * have to be written twice
 * (decision `2026-09-08-a-season-window-gates-the-existing-enabled-flag`).
 */

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const

/** The longest each month can be. February is 29: the window repeats every year and carries
 *  no year, so a 29 February boundary is legal and simply does not occur three years in
 *  four. */
const MONTH_LENGTHS = [
  31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
] as const

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

  return `${parsed.day} ${MONTH_NAMES[parsed.month - 1] ?? ""}`.trim()
}

/** `"10-01"`, the one spelling the server stores. */
export function seasonDayValue(
  month: string,
  day: string,
): string {
  if (!month || !day) return ""

  return `${month.padStart(2, "0")}-${day.padStart(2, "0")}`
}

/** The month picker's rows. The blank first row is how a seasonal queue becomes an all-year
 *  one again — clearing either month clears the whole window. */
export const MONTH_OPTIONS = [
  { label: "—", value: "" },
  ...MONTH_NAMES.map((name, index) => ({
    label: name,
    value: String(index + 1),
  })),
]

/** The day picker's rows for one month. Narrowed to that month's own length, so 31 February
 *  is not offerable — the server refuses it and a control that offers a refused value is a
 *  control that looks broken. An unchosen month offers 31, which is what the picker shows
 *  before anybody has picked. */
export function dayOptions(
  month: string,
): { label: string; value: string }[] {
  const index = Number(month) - 1
  const length = MONTH_LENGTHS[index] ?? 31

  return Array.from({ length }, (_unused, i) => ({
    label: String(i + 1),
    value: String(i + 1),
  }))
}
