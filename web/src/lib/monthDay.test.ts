// The one month/day option source, shared by the season window, the seasonal reset and the
// calendar view. Two behaviours are pinned here because they are the two a re-implementation
// drops: a month is NAMED, and the day list is narrowed by the month.
import { describe, expect, it } from "vitest"

import {
  clampDay,
  dayOptions,
  daysInMonth,
  monthOptions,
} from "./monthDay"

describe("the month picker", () => {
  it("puts the caller's own word for OFF in the first row", () => {
    // "—" reads as a blank in the season row's four-picker line; the reset row has space for
    // the sentence, and both are the same list underneath.
    expect(monthOptions({ emptyLabel: "—" })[0]).toEqual({
      label: "—",
      value: "",
    })
    expect(
      monthOptions({ emptyLabel: "Never" })[0],
    ).toEqual({ label: "Never", value: "" })
  })

  it("offers twelve named months and the blank", () => {
    const short = monthOptions({ emptyLabel: "—" })

    expect(short).toHaveLength(13)
    expect(short[1]).toEqual({ label: "Jan", value: "1" })
    expect(short[12]).toEqual({ label: "Dec", value: "12" })
  })

  it("spells them out when the caller has the room", () => {
    const long = monthOptions({
      emptyLabel: "Never",
      isLongName: true,
    })

    expect(long[1]).toEqual({
      label: "January",
      value: "1",
    })
    expect(long[11]).toEqual({
      label: "November",
      value: "11",
    })
  })

  it("never offers a number, in either spelling", () => {
    // `11` is 1 November here and 11 January in half the world, and this value is next read a
    // year after it was chosen.
    for (const options of [
      monthOptions({ emptyLabel: "—" }),
      monthOptions({ emptyLabel: "—", isLongName: true }),
    ]) {
      for (const option of options.slice(1)) {
        expect(option.label).not.toMatch(/^\d+$/)
      }
    }
  })
})

describe("the day picker", () => {
  it("narrows the day list to the month's own length", () => {
    // A control that offers a value the server refuses is a control that looks broken.
    expect(dayOptions("2")).toHaveLength(29)
    expect(dayOptions("4")).toHaveLength(30)
    expect(dayOptions("1")).toHaveLength(31)
  })

  it("gives February 29 rather than 28", () => {
    // The window repeats every year and carries none, so the leap day is a legal boundary; it
    // simply does not occur in three years out of four.
    expect(daysInMonth("2")).toBe(29)
  })

  it("offers 31 before a month is chosen", () => {
    expect(dayOptions("")).toHaveLength(31)
    expect(daysInMonth("")).toBe(31)
  })
})

describe("what a month change owes the day", () => {
  it("clamps a day the new month cannot hold", () => {
    expect(clampDay("2", "31")).toBe("29")
    expect(clampDay("4", "31")).toBe("30")
  })

  it("leaves a day the month can hold", () => {
    expect(clampDay("1", "31")).toBe("31")
    expect(clampDay("10", "1")).toBe("1")
  })

  it("leaves a blank day blank", () => {
    // "Nothing chosen yet" is a real state: both ends of a season are blank on a queue that is
    // available all year.
    expect(clampDay("2", "")).toBe("")
  })
})
