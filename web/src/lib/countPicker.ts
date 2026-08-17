/**
 * Shared count-picker math: which numbers are presets, what a missing override
 * actually means, and whether a stored value is "this entry is different".
 *
 * The set owns a default (`episodes:` / `volumes:` on the queue). An entry that
 * says nothing follows that default — it must not render as 1 just because 1 is
 * the engine floor. A stored `1` is a real override when the set default is 2.
 */

/** The two numbers that always sit in the list, even when the default is neither. */
export const COUNT_PRESET_COMMON = [1, 2] as const

/**
 * A LINEUP's common answers, which are not an entry's.
 *
 * `length` counts whole items in one sitting, so 1 and 2 are not on the map at all: 12 is the
 * app default (four hours of half-hour shows, but only half an hour of shorts), 24 doubles it,
 * and 60 is what the Shorts card was set to by hand the night it ran dry. The env default
 * joins the list on its own when it is none of these, so it can still wear the Default chip.
 */
export const LINEUP_PRESET_COMMON = [12, 24, 60] as const

/**
 * The common answers plus the current default when it is some other number (so a default of 3
 * is pickable rather than hiding behind Custom…).
 *
 * `common` is a parameter and not a constant because the picker is reused for counts that
 * live on different scales — an entry's batch and a channel's lineup — and offering "1 or 2
 * items in this evening's lineup" would be a control whose presets nobody can use.
 */
export function countPickerPresets(
  defaultValue?: number,
  common: readonly number[] = COUNT_PRESET_COMMON,
): number[] {
  const nums = new Set<number>(common)
  if (
    defaultValue != null &&
    Number.isInteger(defaultValue) &&
    defaultValue >= 1
  ) {
    nums.add(defaultValue)
  }
  return [...nums].sort((a, b) => a - b)
}

export function isCountPreset(
  value: number,
  defaultValue?: number,
  common: readonly number[] = COUNT_PRESET_COMMON,
): boolean {
  return countPickerPresets(defaultValue, common).includes(
    value,
  )
}

/** What actually queues: the entry's override, else the set, else the engine floor. */
export function effectiveCount(
  override: number | null | undefined,
  setDefault: number | null | undefined,
): number {
  return override ?? setDefault ?? 1
}

/** A stored number is an override, including 1 against a set default of 2. */
export function isCountOverride(
  override: number | null | undefined,
): override is number {
  return override != null
}
