import { describe, expect, test } from "vitest"

import { defaultStartPoint, memberPreset, pickOptionValue } from "./startPreset"
import type { NextEp, ShowEpisodes } from "./types"

/**
 * The "Start from…" modal defaults its Episode dropdown to the active series'
 * NEXT-UNWATCHED episode — the same episode the tile shows — for a Collection entry,
 * not to E1. That regression (collection path seeded null → index 0) is what these
 * guard.
 */

// "Red Photon Zillion": E1–E23 watched, E24 next-up (the tile shows E24). A
// single-season anime, so `season` is null on the wire.
const redPhotonZillion: ShowEpisodes = {
  multiSeason: false,
  seasons: [
    {
      episodes: Array.from({ length: 31 }, (_, i) => ({
        episode: i + 1,
        title: `Episode ${i + 1}`,
        watched: i + 1 <= 23,
      })),
      season: 1,
    },
  ],
}

const nextUp: NextEp = {
  episode: 24,
  kind: "show",
  member: "Red Photon Zillion",
  memberRatingKey: "555",
  multiSeason: false,
  season: null,
  title: "They Call Me, J.J.",
}

describe("memberPreset", () => {
  test("collection with no override falls back to the member's next-up episode", () => {
    // The bug: this returned null, so the Episode dropdown fell to E1.
    expect(memberPreset(null, nextUp, "555")).toEqual({
      episode: 24,
      season: undefined,
    })
  })

  test("a stored override for this member wins over next-up", () => {
    expect(
      memberPreset({ episode: 8, season: 1, series: "555" }, nextUp, "555"),
    ).toEqual({ episode: 8, season: 1, series: "555" })
  })

  test("a member that is neither the override target nor next-up has no preset", () => {
    expect(memberPreset(null, nextUp, "999")).toBeNull()
    expect(
      memberPreset({ episode: 8, series: "111" }, nextUp, "999"),
    ).toBeNull()
  })

  // "The Disastrous Life of Saiki K.": 4 member series, #1–#3 finished (their raw
  // viewedLeafCount is BELOW leafCount only because specials inflate the total — the
  // real regular episodes are all watched), #4 "Reawakened" not started. The server's
  // `collectionNext` (which excludes specials the same way) picks #4 as the next-up
  // member and carries its E1, so `nextEp.memberRatingKey` names #4. The modal must
  // therefore seed the ACTIVE series' episode only, and only for #4.
  test("multi-series collection seeds the next-up series' episode, not the first series'", () => {
    const saikiNext: NextEp = {
      episode: 1,
      kind: "show",
      member: "The Disastrous Life of Saiki K.: Reawakened",
      memberRatingKey: "s4",
      multiSeason: false,
      season: null,
    }

    // #4 (the not-fully-watched series) gets its next episode…
    expect(memberPreset(null, saikiNext, "s4")).toEqual({
      episode: 1,
      season: undefined,
    })
    // …and the already-finished #1 is NOT seeded (so opening it wouldn't default to a
    // stale E1 as if it were the start point).
    expect(memberPreset(null, saikiNext, "s1")).toBeNull()
  })
})

describe("defaultStartPoint", () => {
  test("collection member (no override) defaults to next-unwatched E24, not E1", () => {
    const preset = memberPreset(null, nextUp, "555")
    const { season, episode } = defaultStartPoint(redPhotonZillion, preset)

    expect(episode).toBe("24")
    expect(episode).not.toBe("1")
    expect(season).toBe("1")
  })

  test("no preset at all still falls to the first episode (unchanged behavior)", () => {
    expect(defaultStartPoint(redPhotonZillion, null)).toEqual({
      episode: "1",
      season: "1",
    })
  })

  test("a multi-season preset lands on the named season's episode", () => {
    const data: ShowEpisodes = {
      multiSeason: true,
      seasons: [
        { episodes: [{ episode: 1 }, { episode: 2 }], season: 1 },
        { episodes: [{ episode: 1 }, { episode: 2 }, { episode: 3 }], season: 2 },
      ],
    }

    expect(defaultStartPoint(data, { episode: 3, season: 2 })).toEqual({
      episode: "3",
      season: "2",
    })
  })
})

describe("pickOptionValue", () => {
  test("keeps a value that exists, else falls to the first", () => {
    expect(pickOptionValue(["1", "2", "3"], 2)).toBe("2")
    expect(pickOptionValue(["1", "2", "3"], 9)).toBe("1")
    expect(pickOptionValue(["1", "2", "3"], null)).toBe("1")
    expect(pickOptionValue([], 5)).toBe("")
  })
})
