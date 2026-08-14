import { describe, expect, test } from "vitest"

import {
  byTitle,
  isStartable,
  seLabel,
  startLabel,
  tileFace,
  titleSortKey,
  withoutCollectionPrefix,
} from "./tileFace"
import type { QueueItem } from "./types"

/**
 * These are the rules the two most recent UX decisions settled, so they are the
 * ones a future refactor is most likely to quietly undo. Everything asserted here
 * has a decision record behind it.
 */

const item = (over: Partial<QueueItem>): QueueItem => ({
  childCount: null,
  done: false,
  episodes: 1,
  key: "rk:1",
  weight: 1,
  nextEp: null,
  ratingKey: "1",
  resolved: true,
  start: null,
  title: "Untitled",
  type: "show",
  year: null,
  ...over,
})

describe("seLabel", () => {
  test("drops the season for a single-season show — every anime is one", () => {
    expect(
      seLabel({
        episode: 12,
        multiSeason: false,
        season: 1,
      }),
    ).toBe("E12")
  })

  test("keeps it for a multi-season show", () => {
    expect(
      seLabel({ episode: 5, multiSeason: true, season: 3 }),
    ).toBe("S3 · E5")
  })
})

describe("withoutCollectionPrefix", () => {
  // The exact example in 2026-07-31-collection-tiles-are-member-first.
  test("strips the collection's name off its member", () => {
    expect(
      withoutCollectionPrefix(
        "Chaika: The Coffin Princess - Avenging Battle",
        "Chaika: The Coffin Princess",
      ),
    ).toBe("Avenging Battle")
  })

  test("leaves a member named exactly for its collection whole", () => {
    expect(
      withoutCollectionPrefix("Chaika", "Chaika"),
    ).toBe("Chaika")
  })

  test("leaves a member that does not lead with the collection whole", () => {
    expect(
      withoutCollectionPrefix("Some Other Show", "Chaika"),
    ).toBe("Some Other Show")
  })

  test("is case-insensitive on the prefix but keeps the member's own casing", () => {
    expect(
      withoutCollectionPrefix(
        "CHAIKA — Avenging Battle",
        "Chaika",
      ),
    ).toBe("Avenging Battle")
  })

  // Regression: a season/sequel member left only a naked number, which the tile
  // rendered as "2 (2026)" — meaningless. Keep the whole show name instead.
  test("keeps the full title when the prefix leaves only a bare season number", () => {
    expect(
      withoutCollectionPrefix(
        "Trapped in a Dating Sim 2",
        "Trapped in a Dating Sim",
      ),
    ).toBe("Trapped in a Dating Sim 2")
  })

  test("keeps the full title for spelled-out season / part / roman ordinals", () => {
    expect(
      withoutCollectionPrefix(
        "Overlord Season 3",
        "Overlord",
      ),
    ).toBe("Overlord Season 3")
    expect(
      withoutCollectionPrefix("Gintama Part 2", "Gintama"),
    ).toBe("Gintama Part 2")
    expect(
      withoutCollectionPrefix(
        "Fate/stay night II",
        "Fate/stay night",
      ),
    ).toBe("Fate/stay night II")
  })

  test("still strips a real subtitle that merely starts with a number", () => {
    expect(
      withoutCollectionPrefix(
        "Evangelion 3.0 You Can (Not) Redo",
        "Evangelion",
      ),
    ).toBe("3.0 You Can (Not) Redo")
  })
})

describe("tileFace", () => {
  test("a series tile reads episode + episode title", () => {
    const face = tileFace(
      item({
        nextEp: {
          episode: 5,
          multiSeason: true,
          season: 3,
          title: "The Duel",
        },
        title: "Bantorra",
      }),
    )

    expect(face.next).toBe("S3 · E5 · The Duel")
    expect(face.from).toBeNull()
  })

  test("a fully-watched series says so, muted", () => {
    const face = tileFace(item({ nextEp: null }))

    expect(face.next).toBe("All watched")
    expect(face.nextDone).toBe(true)
  })

  test("a collection borrows the member's poster, name and episode line", () => {
    const face = tileFace(
      item({
        childCount: 8,
        nextEp: {
          episode: 1,
          kind: "show",
          member:
            "Chaika: The Coffin Princess - Avenging Battle",
          memberRatingKey: "999",
          memberYear: 2014,
          multiSeason: false,
          title: "For Lost Love",
        },
        ratingKey: "1",
        title: "Chaika: The Coffin Princess",
        type: "collection",
      }),
    )

    // Poster + title come from the MEMBER…
    expect(face.ratingKey).toBe("999")
    expect(face.title).toBe("Avenging Battle")
    expect(face.year).toBe(2014)
    // …the episode line never repeats the series name…
    expect(face.next).toBe("E1 · For Lost Love")
    // …and the collection moves to the badge.
    expect(face.from).toBe("Chaika: The Coffin Princess")
    expect(face.fullTitle).toBe(
      "Chaika: The Coffin Princess - Avenging Battle",
    )
  })

  test("a collection whose next member is a MOVIE says where it sits", () => {
    const face = tileFace(
      item({
        childCount: 8,
        nextEp: {
          kind: "movie",
          member: "Ponyo",
          memberRatingKey: "42",
          position: 3,
        },
        title: "Ghibli",
        type: "collection",
      }),
    )

    expect(face.next).toBe("3 of 8")
    expect(face.title).toBe("Ponyo")
  })

  test("a collection with no next-up member falls back to its own identity", () => {
    const face = tileFace(
      item({
        childCount: 8,
        nextEp: null,
        title: "Ghibli",
        type: "collection",
      }),
    )

    expect(face.title).toBe("Ghibli")
    expect(face.next).toBe("8 in order")
    expect(face.from).toBeNull()
  })
})

describe("byTitle", () => {
  test("files a leading article under its next word", () => {
    expect(titleSortKey("The Book of Bantorra")).toBe(
      "Book of Bantorra",
    )
  })

  test("is numeric-aware, so Vol 2 precedes Vol 10", () => {
    expect(
      byTitle({ title: "Vol 2" }, { title: "Vol 10" }),
    ).toBeLessThan(0)
  })
})

describe("startLabel", () => {
  test("omits the season when it is the only one", () => {
    expect(startLabel({ episode: 20, season: 1 })).toBe(
      "Start E20",
    )
  })

  test("names the season when it matters", () => {
    expect(startLabel({ episode: 3, season: 2 })).toBe(
      "Start S2E3",
    )
  })

  test("is empty with no override, so a plain tile shows no chip", () => {
    expect(startLabel(null)).toBe("")
  })
})

describe("isStartable", () => {
  test("shows and collections can carry a start point; a movie cannot", () => {
    expect(isStartable(item({ type: "show" }))).toBe(true)
    expect(isStartable(item({ type: "collection" }))).toBe(
      true,
    )
    expect(isStartable(item({ type: "movie" }))).toBe(false)
  })

  test("an unresolved entry cannot — there is nothing to list episodes from", () => {
    expect(
      isStartable(item({ resolved: false, type: "show" })),
    ).toBe(false)
  })
})
