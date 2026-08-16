import { describe, expect, test } from "vitest"

import {
  countPickerPresets,
  effectiveCount,
  isCountOverride,
  isCountPreset,
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
})

describe("isCountPreset", () => {
  test("3 is custom unless it is the default", () => {
    expect(isCountPreset(3)).toBe(false)
    expect(isCountPreset(3, 3)).toBe(true)
    expect(isCountPreset(2, 3)).toBe(true)
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
