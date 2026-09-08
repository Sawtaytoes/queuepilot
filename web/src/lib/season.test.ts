// The browser half of the season window is DISPLAY only — the words on a card, and the two
// spellings of a `MM-DD`. The calendar rule itself is the server's `is_in_season`, and is
// deliberately not written twice. The PICKERS' options moved to `monthDay.test.ts` when a
// third caller wanted the same twelve rows.
import { describe, expect, it } from "vitest"

import {
  parseSeasonDay,
  seasonDayLabel,
  seasonDayValue,
} from "./season"

describe("the words on an out-of-season card", () => {
  it("names the day and the month", () => {
    expect(seasonDayLabel("10-01")).toBe("1 Oct")
    expect(seasonDayLabel("12-25")).toBe("25 Dec")
  })

  it("says nothing at all about a queue with no window", () => {
    // Empty rather than a placeholder, so a card can render the mark on truthiness alone.
    expect(seasonDayLabel(null)).toBe("")
    expect(seasonDayLabel(undefined)).toBe("")
    expect(seasonDayLabel("")).toBe("")
    expect(seasonDayLabel("october")).toBe("")
  })
})

describe("the stored MM-DD", () => {
  it("joins the pair into the one padded spelling the server stores", () => {
    expect(seasonDayValue("10", "1")).toBe("10-01")
    expect(seasonDayValue("1", "1")).toBe("01-01")
  })

  it("joins a half-chosen pair into nothing", () => {
    // The writer refuses a half-written window by name; sending "" for both is what clears it.
    expect(seasonDayValue("10", "")).toBe("")
    expect(seasonDayValue("", "1")).toBe("")
  })

  it("splits a stored value back into the two controls", () => {
    expect(parseSeasonDay("10-01")).toEqual({
      day: 1,
      month: 10,
    })
    expect(parseSeasonDay("13-01")).toBeNull()
    expect(parseSeasonDay("02-30")).toBeNull()
  })
})
