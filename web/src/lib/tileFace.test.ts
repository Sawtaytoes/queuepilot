import { describe, expect, test } from "vitest"

import {
  byTitle,
  isCompleted,
  isStartable,
  runtimeLabel,
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

  test("a reading queue counts chapters", () => {
    expect(
      seLabel(
        { episode: 113, multiSeason: false, season: null },
        "chapter",
      ),
    ).toBe("Ch 113")
  })

  // A volume-based manga has NO chapter numbering at all — Kavita gives every one of its
  // chapters the -100000 "no subdivision" sentinel — so the item IS the volume and has to
  // say so. Labelling it "Ch 1" would name a chapter that does not exist.
  test("a volume-based manga counts volumes", () => {
    expect(
      seLabel(
        { episode: 1, multiSeason: false, season: null },
        "volume",
      ),
    ).toBe("Vol 1")
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

  /**
   * Reported live 2026-08-17 on the first Steam queue: a tile headed ELDEN RING whose
   * next-up line read "Play 1 of 1 · ELDEN RING" — the name twice, and a count whose
   * numerator and denominator can only ever be 1.
   *
   * Both halves are properties of a ONE-UNIT entry rather than of Steam, so a one-play
   * board game reads the same way and is fixed by the same change.
   */
  test("a single-play game reports its state, not a count of one", () => {
    const face = tileFace(
      item({
        nextEp: {
          episode: 1,
          multiSeason: false,
          of: 1,
          season: null,
          title: "ELDEN RING",
        },
        title: "ELDEN RING",
        unit: "play",
      }),
    )

    expect(face.next).toBe("Not played yet")
  })

  test("a multi-play game still counts, and drops the duplicated name", () => {
    const face = tileFace(
      item({
        nextEp: {
          episode: 2,
          multiSeason: false,
          of: 3,
          season: null,
          title: "Wingspan",
        },
        title: "Wingspan",
        unit: "play",
      }),
    )

    expect(face.next).toBe("Play 2 of 3")
  })

  test("an episode title that is NOT the show name is still shown", () => {
    // The dedupe must not swallow a real episode title — the whole point of the line.
    const face = tileFace(
      item({
        nextEp: {
          episode: 5,
          multiSeason: false,
          season: 1,
          title: "The Duel",
        },
        title: "Bantorra",
      }),
    )

    expect(face.next).toBe("E5 · The Duel")
  })

  test("a fully-watched series says so, muted", () => {
    const face = tileFace(item({ nextEp: null }))

    expect(face.next).toBe("All watched")
    expect(face.nextDone).toBe(true)
  })

  /**
   * A reading queue's entries are counted in CHAPTERS, and the tile is the same tile —
   * so the wording is the only thing that may differ. "E113" on a manga tile is wrong in
   * the way that reads as a bug in the data rather than in the label.
   */
  test("a reading entry counts chapters, not episodes", () => {
    const face = tileFace(
      item({
        nextEp: {
          episode: 113,
          multiSeason: false,
          season: null,
          title: "The Tower's Bottom",
        },
        title: "Tower Dungeon",
        unit: "chapter",
      }),
    )

    expect(face.next).toBe("Ch 113 · The Tower's Bottom")
  })

  test("a chapter titled after its own number does not say it twice", () => {
    // Kavita names most chapters after themselves, which rendered "Ch 113 · Chapter 113".
    for (const title of ["113", "Chapter 113", "Ch. 113"]) {
      const face = tileFace(
        item({
          nextEp: {
            episode: 113,
            multiSeason: false,
            season: null,
            title,
          },
          unit: "chapter",
        }),
      )

      expect(face.next).toBe("Ch 113")
    }
  })

  test("…but a chapter RANGE says something the number does not", () => {
    const face = tileFace(
      item({
        nextEp: {
          episode: 1,
          multiSeason: false,
          season: null,
          title: "Chapter 1-19",
        },
        unit: "chapter",
      }),
    )

    expect(face.next).toBe("Ch 1 · Chapter 1-19")
  })

  test("a finished reading entry is read, not watched", () => {
    const face = tileFace(
      item({ nextEp: null, unit: "chapter" }),
    )

    expect(face.next).toBe("All read")
    expect(face.nextDone).toBe(true)
  })

  /**
   * A VOLUME-based manga (Alice in Borderland and friends): Kavita gives every one of its
   * chapters the `-100000` "no subdivision" sentinel, so the item is the VOLUME. The tile
   * has to name it as one — "Ch 1" would point at a chapter that does not exist — and
   * Kavita's own name for it is "Volume 1", which must not then be printed twice.
   */
  test("a volume-based entry counts volumes and does not say it twice", () => {
    const face = tileFace(
      item({
        nextEp: {
          episode: 1,
          multiSeason: false,
          season: null,
          title: "Volume 1",
        },
        title: "Alice in Borderland",
        unit: "volume",
      }),
    )

    expect(face.next).toBe("Vol 1")
  })

  test("a volume with a REAL name still shows it", () => {
    const face = tileFace(
      item({
        nextEp: {
          episode: 3,
          multiSeason: false,
          season: null,
          title: "The Beach",
        },
        unit: "volume",
      }),
    )

    expect(face.next).toBe("Vol 3 · The Beach")
  })

  test("a finished volume-based entry is read, not watched", () => {
    const face = tileFace(
      item({ nextEp: null, unit: "volume" }),
    )

    expect(face.next).toBe("All read")
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

  test("a finished collection reads like a finished show, not as its size", () => {
    const face = tileFace(
      item({
        childCount: 8,
        nextEp: null,
        title: "Ghibli",
        type: "collection",
      }),
    )

    expect(face.title).toBe("Ghibli")
    expect(face.next).toBe("All watched")
    expect(face.nextDone).toBe(true)
    expect(face.from).toBeNull()
  })

  test("a finished reading collection is read, not watched", () => {
    expect(
      tileFace(
        item({
          childCount: 8,
          nextEp: null,
          title: "Berserk",
          type: "collection",
          unit: "chapter",
        }),
      ).next,
    ).toBe("All read")
  })

  // "All watched" is a claim about watch state; a failed next-up lookup knows nothing
  // about it. Only THAT case still falls back to the collection's own identity + size.
  test("a collection whose next-up lookup failed falls back to its size", () => {
    const face = tileFace(
      item({
        childCount: 8,
        isNextEpFailed: true,
        nextEp: null,
        title: "Ghibli",
        type: "collection",
      }),
    )

    expect(face.title).toBe("Ghibli")
    expect(face.next).toBe("8 in order")
    expect(face.nextDone).toBe(false)
  })

  test("an unresolved collection falls back to its size", () => {
    expect(
      tileFace(
        item({
          childCount: 8,
          nextEp: null,
          resolved: false,
          title: "Ghibli",
          type: "collection",
        }),
      ).next,
    ).toBe("8 in order")
  })

  test("a show whose next-up lookup failed does not claim All watched", () => {
    expect(
      tileFace(
        item({
          isNextEpFailed: true,
          nextEp: null,
          title: "Frieren",
        }),
      ).next,
    ).toBe("")
  })

  /**
   * The edition, which is what makes two tiles of one film distinguishable. Two library
   * items share a title AND a year and differ only here, so the pair below is the whole
   * point: the tagged one names itself, the plain one stays plain.
   * (decision `2026-08-21-a-tile-names-the-edition-plex-gave-it`)
   */
  test("a tagged edition reaches the face", () => {
    expect(
      tileFace(
        item({
          editionTitle: "Director's Cut",
          title: "Ulysses",
          type: "movie",
          year: 1954,
        }),
      ).edition,
    ).toBe("Director's Cut")
  })

  // Plex tags only the NON-DEFAULT item of a pair, so its twin has no label at all. The
  // face must not invent a "Standard" Plex never wrote — the same rule the search row's
  // `EditionBadge` follows.
  test("the plain edition of a pair stays plain", () => {
    expect(
      tileFace(
        item({
          title: "Ulysses",
          type: "movie",
          year: 1954,
        }),
      ).edition,
    ).toBeNull()
  })

  // A server that sends the key explicitly null is the same as one that omits it. Every
  // non-Plex provider tile omits it, and the shelf SKELETON omits it too.
  test("an explicit null edition is null, not undefined", () => {
    expect(
      tileFace(
        item({
          editionTitle: null,
          title: "Ulysses",
          type: "movie",
        }),
      ).edition,
    ).toBeNull()
  })

  // A long label must still reach the face WHOLE — the truncation is the chip's job (the
  // `Badge` cap plus its ellipsis), never a substring cut here, or the hover readout would
  // repeat the clipped text instead of completing it.
  test("a long edition is not shortened on the way to the face", () => {
    expect(
      tileFace(
        item({
          editionTitle: "Original TV Version – 16mm scan",
          title: "Ulysses",
          type: "movie",
        }),
      ).edition,
    ).toBe("Original TV Version – 16mm scan")
  })

  /**
   * A COLLECTION face borrows its next-up MEMBER's identity, and the next-up payload carries
   * no edition for that member — so the face says null. Lending it the collection's own
   * `editionTitle` would label a member tile with something that is not the member's.
   */
  test("a collection's borrowed face claims no edition", () => {
    const face = tileFace(
      item({
        childCount: 3,
        editionTitle: "Director's Cut",
        nextEp: {
          episode: null,
          kind: "movie",
          member: "Ulysses",
          memberRatingKey: "77",
          memberYear: 1954,
          multiSeason: false,
          position: 1,
          season: null,
        },
        title: "Ulysses Collection",
        type: "collection",
      }),
    )

    expect(face.title).toBe("Ulysses")
    expect(face.edition).toBeNull()
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

  test("a reading start names a chapter, not an episode", () => {
    expect(
      startLabel({ episode: 88, season: 1 }, "chapter"),
    ).toBe("Start Ch 88")
  })

  test("a volume start names the volume", () => {
    expect(
      startLabel({ episode: 3, season: 1 }, "volume"),
    ).toBe("Start Vol 3")
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

describe("isCompleted", () => {
  test("the file's flag says Completed, as it always has", () => {
    expect(isCompleted(item({ done: true }))).toBe(true)
  })

  test("so does a live-finished entry the last scan never saw", () => {
    expect(
      isCompleted(item({ done: false, isFinished: true })),
    ).toBe(true)
  })

  test("an entry with something left to play is neither", () => {
    expect(isCompleted(item({ done: false }))).toBe(false)
  })
})

describe("runtimeLabel", () => {
  test("an episode reads in whole minutes", () => {
    // 1,421,852 ms — the live runtime of the .hack//SIGN episode that first showed this line.
    expect(runtimeLabel(1421852)).toBe("24 min")
  })

  test("a film past the hour splits the hours out", () => {
    expect(runtimeLabel(107 * 60000)).toBe("1 h 47 min")
  })

  test("a whole number of hours drops the empty minutes", () => {
    expect(runtimeLabel(120 * 60000)).toBe("2 h")
  })

  test("a batch multiplies, and says the total is an estimate", () => {
    // Only the NEXT episode's runtime is known, so the total is "about" by construction.
    expect(runtimeLabel(24 * 60000, 2)).toBe(
      "2 x 24 min · about 48 min",
    )
  })

  test("a batch of one is just the one runtime", () => {
    expect(runtimeLabel(24 * 60000, 1)).toBe("24 min")
  })

  test("no runtime is no line — a chapter, a board game, an empty next-up", () => {
    expect(runtimeLabel(0)).toBeNull()
    expect(runtimeLabel(null)).toBeNull()
    expect(runtimeLabel(undefined, 3)).toBeNull()
  })

  test("under a minute is not a runtime worth printing", () => {
    expect(runtimeLabel(20_000)).toBeNull()
  })
})
