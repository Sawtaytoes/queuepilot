import { describe, expect, test } from "vitest"

import {
  countPickerPresets,
  effectiveCount,
  isCountOverride,
  isCountPreset,
  LINEUP_PRESET_COMMON,
} from "./countPicker"

describe("countPickerPresets", () => {
  test("always offers 1 and 2", () => {
    expect(countPickerPresets()).toEqual([1, 2])
    expect(countPickerPresets(1)).toEqual([1, 2])
    expect(countPickerPresets(2)).toEqual([1, 2])
  })

  test("adds a non-1-or-2 default so it is a tagged preset, not Custom", () => {
    expect(countPickerPresets(3)).toEqual([1, 2, 3])
    expect(countPickerPresets(12)).toEqual([1, 2, 12])
  })

  // The lineup picker counts whole items in one sitting, so 1 and 2 must not be on it — a
  // pool editor offering "1 item this evening" is a control with two dead options.
  test("a lineup's common answers replace 1 and 2 entirely", () => {
    expect(
      countPickerPresets(12, LINEUP_PRESET_COMMON),
    ).toEqual([12, 24, 60])
    expect(
      countPickerPresets(undefined, LINEUP_PRESET_COMMON),
    ).toEqual([12, 24, 60])
  })

  test("a moved ROTATION_LENGTH still gets its Default chip, in order", () => {
    expect(
      countPickerPresets(20, LINEUP_PRESET_COMMON),
    ).toEqual([12, 20, 24, 60])
  })
})

describe("isCountPreset", () => {
  test("3 is custom unless it is the default", () => {
    expect(isCountPreset(3)).toBe(false)
    expect(isCountPreset(3, 3)).toBe(true)
    expect(isCountPreset(2, 3)).toBe(true)
  })

  // Against a lineup's list, 2 is Custom and 60 is not — the exact inversion of the entry
  // scale, which is why the list had to become a parameter rather than a constant.
  test("the lineup scale inverts which numbers are presets", () => {
    expect(isCountPreset(2, 12, LINEUP_PRESET_COMMON)).toBe(
      false,
    )
    expect(
      isCountPreset(60, 12, LINEUP_PRESET_COMMON),
    ).toBe(true)
  })
})

describe("effectiveCount", () => {
  test("a missing override follows the set, not the engine floor", () => {
    expect(effectiveCount(null, 2)).toBe(2)
    expect(effectiveCount(undefined, 2)).toBe(2)
    expect(effectiveCount(null, null)).toBe(1)
  })

  test("a stored 1 wins over a set default of 2", () => {
    expect(effectiveCount(1, 2)).toBe(1)
    expect(effectiveCount(3, 2)).toBe(3)
  })
})

describe("isCountOverride", () => {
  test("null/absent follows the set; 1 is a real override", () => {
    expect(isCountOverride(null)).toBe(false)
    expect(isCountOverride(undefined)).toBe(false)
    expect(isCountOverride(1)).toBe(true)
    expect(isCountOverride(2)).toBe(true)
  })
})
