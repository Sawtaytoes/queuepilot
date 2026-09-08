import { describe, expect, it } from "vitest"

import {
  hasSection,
  runtimeMs,
  sectionOf,
  sectionSummary,
  sectionTagLabel,
  startNamesUnit,
  timecode,
  withPositionMs,
  withUnit,
} from "./section"

/**
 * The pure half of the section editor.
 *
 * Every case here is one of the four optionality states or one of the two ways `null` gets
 * confused with `0` — which is the whole class of bug this feature can have, and the class the
 * server's own `hasSection` was bitten by before it shipped.
 */

describe("sectionOf", () => {
  it("answers null when the entry names no section", () => {
    expect(sectionOf({ start: null })).toBeNull()
    expect(
      sectionOf({ end: null, start: { episode: 4 } }),
    ).toBeNull()
    expect(sectionOf(null)).toBeNull()
  })

  it("reads the four states apart", () => {
    expect(
      sectionOf({
        end: { position_ms: 17_000 },
        start: { position_ms: 12_000 },
      }),
    ).toEqual({ endMs: 17_000, startMs: 12_000 })
    expect(
      sectionOf({ start: { position_ms: 12_000 } }),
    ).toEqual({ endMs: null, startMs: 12_000 })
    expect(
      sectionOf({
        end: { position_ms: 17_000 },
        start: null,
      }),
    ).toEqual({ endMs: 17_000, startMs: null })
  })

  // ⚠️ The one that matters. `0` is the first frame — a real place to begin a section — and
  // truthiness reads it as "no section at all".
  it("treats a zero offset as a real mark, not as absent", () => {
    expect(
      sectionOf({
        end: { position_ms: 90_000 },
        start: { position_ms: 0 },
      }),
    ).toEqual({ endMs: 90_000, startMs: 0 })
    expect(hasSection({ start: { position_ms: 0 } })).toBe(
      true,
    )
  })

  it("keeps a section beside the unit the start also names", () => {
    expect(
      sectionOf({
        end: { position_ms: 1_020_000 },
        start: {
          episode: 4,
          position_ms: 750_000,
          season: 2,
        },
      }),
    ).toEqual({ endMs: 1_020_000, startMs: 750_000 })
  })
})

describe("startNamesUnit", () => {
  it("is false for a film section, which names no unit", () => {
    expect(startNamesUnit({ position_ms: 3_660_000 })).toBe(
      false,
    )
    expect(startNamesUnit(null)).toBe(false)
  })

  it("is true for every unit a start can pick", () => {
    expect(startNamesUnit({ episode: 4, season: 2 })).toBe(
      true,
    )
    expect(startNamesUnit({ series: "1001" })).toBe(true)
  })
})

describe("withUnit / withPositionMs", () => {
  // The two writers share one `start` mapping and `PATCH …/start` replaces it whole, so each
  // one has to carry the other's field through or it deletes it invisibly.
  it("a unit edit keeps the section offset", () => {
    expect(
      withUnit(
        { episode: 4, position_ms: 750_000, season: 2 },
        { episode: 6, season: 3 },
      ),
    ).toEqual({
      episode: 6,
      position_ms: 750_000,
      season: 3,
    })
  })

  it("clearing the unit leaves the section behind", () => {
    expect(
      withUnit(
        { episode: 4, position_ms: 750_000, season: 2 },
        null,
      ),
    ).toEqual({ position_ms: 750_000 })
  })

  it("clearing the unit of a plain start answers null, never {}", () => {
    expect(
      withUnit({ episode: 4, season: 2 }, null),
    ).toBeNull()
  })

  it("a section edit keeps the unit", () => {
    expect(
      withPositionMs(
        { episode: 4, position_ms: 750_000, season: 2 },
        900_000,
      ),
    ).toEqual({
      episode: 4,
      position_ms: 900_000,
      season: 2,
    })
  })

  it("clearing the section of a film start answers null", () => {
    expect(
      withPositionMs({ position_ms: 750_000 }, null),
    ).toBeNull()
  })

  it("writes a zero offset rather than dropping it", () => {
    expect(withPositionMs(null, 0)).toEqual({
      position_ms: 0,
    })
  })
})

describe("timecode", () => {
  it("shows the hour only once there is one", () => {
    expect(timecode(750_000)).toBe("12:30")
    expect(timecode(3_723_000)).toBe("01:02:03")
  })

  it("truncates rather than rounding, so a mark is never past what played", () => {
    expect(timecode(1_999)).toBe("00:01")
  })
})

describe("sectionTagLabel", () => {
  it("says nothing at all with no section", () => {
    expect(sectionTagLabel(null)).toBe("")
  })

  it("reads differently in each of the three states", () => {
    expect(
      sectionTagLabel({
        endMs: 1_020_000,
        startMs: 750_000,
      }),
    ).toBe("Section 12:30–17:00")
    expect(
      sectionTagLabel({ endMs: null, startMs: 750_000 }),
    ).toBe("Section from 12:30")
    expect(
      sectionTagLabel({ endMs: 1_020_000, startMs: null }),
    ).toBe("Section to 17:00")
  })

  it("keeps an open start open rather than printing 00:00", () => {
    expect(
      sectionTagLabel({ endMs: 90_000, startMs: null }),
    ).not.toContain("–")
  })
})

describe("sectionSummary", () => {
  it("names the runtime when the item reports one", () => {
    expect(
      sectionSummary(
        { endMs: 1_020_000, startMs: 750_000 },
        1_440_000,
      ),
    ).toBe("12:30 to 17:00 of 24:00")
  })

  it("omits the runtime when nothing knows it", () => {
    expect(
      sectionSummary({ endMs: null, startMs: 750_000 }, 0),
    ).toBe("12:30 to the end")
  })

  // A FRAGMENT, never a sentence — the modal says "Will play …" over the same words, and a
  // built-in "Plays" printed "Plays Plays the whole item."
  it("describes the default as a fragment the caller can put a verb in front of", () => {
    expect(sectionSummary(null)).toBe("the whole item")
  })
})

describe("runtimeMs", () => {
  // `0` on the wire is "not known", and passing it to a `TimecodeInput` as `durationMs` would
  // clamp every typed mark to zero.
  it("reads a zero duration as unknown, not as a bound", () => {
    expect(runtimeMs({ duration: 0 })).toBeNull()
    expect(runtimeMs({})).toBeNull()
    expect(runtimeMs({ duration: 1_440_000 })).toBe(
      1_440_000,
    )
  })
})
