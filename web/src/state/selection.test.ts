import { beforeEach, describe, expect, test } from "vitest"

import {
  clearSelection,
  getSelected,
  toggleSelectThrough,
} from "./selection"

const keys = () =>
  [...getSelected().values()].map((entry) => entry.key)

describe("queue entry selection", () => {
  beforeEach(clearSelection)

  test("a normal item click toggles one entry and establishes the range anchor", () => {
    toggleSelectThrough(
      "movies",
      "b",
      ["a", "b", "c"],
      false,
    )
    expect(keys()).toEqual(["b"])

    toggleSelectThrough(
      "movies",
      "b",
      ["a", "b", "c"],
      false,
    )
    expect(keys()).toEqual([])
  })

  test("Shift-click adds the inclusive visible range from the prior anchor", () => {
    toggleSelectThrough(
      "movies",
      "b",
      ["a", "b", "c", "d"],
      false,
    )
    toggleSelectThrough(
      "movies",
      "d",
      ["a", "b", "c", "d"],
      true,
    )

    expect(keys()).toEqual(["b", "c", "d"])
  })

  test("a range can run backwards and does not select filtered-out entries", () => {
    toggleSelectThrough(
      "movies",
      "d",
      ["a", "c", "d"],
      false,
    )
    toggleSelectThrough(
      "movies",
      "a",
      ["a", "c", "d"],
      true,
    )

    expect(keys()).toEqual(["d", "a", "c"])
  })
})
