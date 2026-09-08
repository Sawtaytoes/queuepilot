import { describe, expect, test } from "vitest"

import {
  COMPLETION_MODES,
  type CompletionMode,
  completionFlagsFor,
  completionModeOf,
} from "./completionMode"

describe("completionModeOf", () => {
  test("nothing set is Consume — the default", () => {
    expect(completionModeOf({})).toBe("consume")
    expect(completionModeOf(null)).toBe("consume")
    expect(completionModeOf(undefined)).toBe("consume")
  })

  test("each flag names its own mode", () => {
    expect(
      completionModeOf({ restart_when_exhausted: true }),
    ).toBe("restart")
    expect(completionModeOf({ keep_completed: true })).toBe(
      "playlist",
    )
    expect(
      completionModeOf({
        keep_completed: true,
        reel: true,
      }),
    ).toBe("reel")
  })

  // The precedence rule, which is the engine's own: `reel` implies `keep_completed`, and a set
  // that never marks an entry done can never run out of them. A hand-written contradiction is
  // RESOLVED here, never refused.
  test("reel wins over everything a hand edit can write beside it", () => {
    expect(
      completionModeOf({
        keep_completed: true,
        reel: true,
        restart_when_exhausted: true,
      }),
    ).toBe("reel")
    expect(
      completionModeOf({
        reel: true,
        restart_when_exhausted: true,
      }),
    ).toBe("reel")
  })

  test("keep_completed wins over restart_when_exhausted", () => {
    expect(
      completionModeOf({
        keep_completed: true,
        restart_when_exhausted: true,
      }),
    ).toBe("playlist")
  })
})

describe("completionFlagsFor", () => {
  test("Consume writes nothing on — every key drops out of the file", () => {
    expect(completionFlagsFor("consume")).toEqual({
      keep_completed: false,
      reel: false,
      restart_when_exhausted: false,
    })
  })

  test("Start over is its own boolean, and neither of the other two", () => {
    expect(completionFlagsFor("restart")).toEqual({
      keep_completed: false,
      reel: false,
      restart_when_exhausted: true,
    })
  })

  test("Playlist mode is keep_completed alone", () => {
    expect(completionFlagsFor("playlist")).toEqual({
      keep_completed: true,
      reel: false,
      restart_when_exhausted: false,
    })
  })

  // The engine implies it; the file says it, so a hand-reader sees the non-consuming intent
  // without having to know the implication.
  test("Demo reel still carries keep_completed", () => {
    expect(completionFlagsFor("reel")).toEqual({
      keep_completed: true,
      reel: true,
      restart_when_exhausted: false,
    })
  })
})

// The picker replaced two checkboxes with four rows, and the claim that made that safe is that
// the rows COVER the space and lose nothing. Round-tripping every one of them is that claim.
describe("the four rows are the whole space", () => {
  test("every mode survives a save and a re-open", () => {
    for (const mode of COMPLETION_MODES) {
      expect(
        completionModeOf(completionFlagsFor(mode)),
      ).toBe(mode)
    }
  })

  test("the picker offers exactly four, default first", () => {
    const expected: CompletionMode[] = [
      "consume",
      "restart",
      "playlist",
      "reel",
    ]
    expect([...COMPLETION_MODES]).toEqual(expected)
  })
})
