import { describe, expect, test } from "vitest"

import { titleWithYear } from "./mediaTitle"

describe("titleWithYear", () => {
  test("does not repeat a release year already in Plex's title", () => {
    expect(titleWithYear("Fire Force (2020)", 2020)).toBe(
      "Fire Force (2020)",
    )
  })

  test("keeps a different parenthetical year and adds the release year", () => {
    expect(titleWithYear("Fire Force (2019)", 2020)).toBe(
      "Fire Force (2019) (2020)",
    )
  })

  test("omits an unavailable year", () => {
    expect(titleWithYear("Fire Force", null)).toBe(
      "Fire Force",
    )
  })
})
