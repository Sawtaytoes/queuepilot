/**
 * THE MONTH AND DAY PICKERS' OPTIONS — one source, for every date-shaped setting.
 *
 * Three features arrived within a day of each other and each brought its own copy of this
 * list: the season window's `MONTH_OPTIONS` + `dayOptions` in `lib/season.ts`, the seasonal
 * reset's `RESET_MONTH_OPTIONS` + `RESET_MONTH_DAYS` inside `SetModal.tsx`, and then the
 * calendar view, which edits both. Three copies of a twelve-row list is three chances for one
 * of them to offer 31 February.
 *
 * Two rules are carried across from those copies unchanged, and neither is decoration:
 *
 *   * **NAMED MONTHS, NEVER NUMBERS.** `11` is 1 November here and 11 January in half the
 *     world, and these are the settings whose value is next read a YEAR after it was chosen —
 *     with nobody at the keyboard when it is read
 *     (decision `2026-09-08-adopting-a-reset-date-settles-the-past-occurrence-and-clears-nothing`).
 *     The two callers spell them differently on purpose: the reset row has one picker per line
 *     and can afford "January", the season row has four pickers on one line and takes "Jan".
 *     That is a LENGTH difference, not a second vocabulary.
 *   * **THE DAY LIST IS BUILT FROM THE MONTH**, so 31 February cannot be expressed. The month
 *     is therefore the day's SECOND WRITER, which is what every day picker in the app is keyed
 *     on (decision `2026-08-02-uncontrolled-components-are-keyed-on-their-second-writer`), and
 *     `clampDay` is what a month change owes the day it just narrowed.
 *
 * February is 29 and not 28. These windows repeat every year and carry no year, so a 29
 * February boundary is legal; `seasonalReset.mostRecentOccurrence` lands it on 1 March in a
 * common year rather than skipping the year.
 */

/** For a control with several pickers on one line. */
export const MONTH_NAMES_SHORT = [
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

/** For a control with room for the whole word. */
export const MONTH_NAMES_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const

/** The longest each month can be. Mirrors `server/src/season.ts` and
 *  `server/src/seasonalReset.ts daysInMonth`, which the web workspace cannot import. The pair
 *  cannot drift far: a day this list offers and the server refuses is refused on Save, loudly,
 *  rather than stored. */
export const MONTH_LENGTHS = [
  31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
] as const

export type MonthDayOption = {
  label: string
  value: string
}

/**
 * The month picker's rows, with the caller's own word for OFF in the first one.
 *
 * The empty row is how a dated queue becomes an undated one again — clearing the month clears
 * the whole setting — so the label is the caller's: "—" reads as a blank in a four-picker
 * line, and "Never — this queue does not reset" is the sentence a lone control owes the
 * reader.
 */
export function monthOptions({
  emptyLabel,
  isLongName = false,
}: {
  emptyLabel: string
  isLongName?: boolean
}): MonthDayOption[] {
  const names = isLongName
    ? MONTH_NAMES_LONG
    : MONTH_NAMES_SHORT

  return [
    { label: emptyLabel, value: "" },
    ...names.map((label, index) => ({
      label,
      value: String(index + 1),
    })),
  ]
}

/** How many days the chosen month has. An unchosen month answers 31, so a control nobody has
 *  touched offers a full list rather than an empty one. */
export function daysInMonth(month: string): number {
  return MONTH_LENGTHS[Number(month) - 1] ?? 31
}

/** The day picker's rows for one month. */
export function dayOptions(
  month: string,
): MonthDayOption[] {
  return Array.from(
    { length: daysInMonth(month) },
    (_unused, index) => ({
      label: String(index + 1),
      value: String(index + 1),
    }),
  )
}

/**
 * The day a month change leaves behind. Choosing February cannot hold the 31 January that was
 * already there, and a value the picker no longer offers reads as an empty control.
 *
 * A blank day stays blank — "nothing chosen yet" is a real state on the season row, where both
 * ends are blank on a queue that is available all year.
 */
export function clampDay(
  month: string,
  day: string,
): string {
  if (!day) return day
  const longest = daysInMonth(month)

  return Number(day) > longest ? String(longest) : day
}
