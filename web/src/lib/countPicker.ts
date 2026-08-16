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

/** 1, 2, and the set default when it is some other number (so 3 is pickable, not Custom). */
export function countPickerPresets(
  defaultValue?: number,
): number[] {
  const nums = new Set<number>(COUNT_PRESET_COMMON)
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
): boolean {
  return countPickerPresets(defaultValue).includes(value)
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
