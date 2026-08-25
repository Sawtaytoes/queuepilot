// The Tonight form as a pick request, and the words a card says.
//
// The cast is Ada, Grace and Linus and every title is invented — this repo is public.
import { describe, expect, test } from "vitest"

import {
  boxArtUrl,
  criteriaFromTonight,
  filterCollection,
  knownHowFor,
  knownHowLabel,
  knownHowProposal,
  LIGHT_MAX_WEIGHT,
  playCountLabel,
  playerCountLine,
  playtimeLabel,
  tableSize,
  weightLabel,
} from "./boardGames"
import type { BoardGameCard } from "./types"

const card = (over: Partial<BoardGameCard> = {}): BoardGameCard => ({
  bestWith: [3, 4],
  id: "harbour-lantern",
  imagePath: null,
  interactionTypes: ["competitive"],
  isExcluded: false,
  lastPlayedAt: null,
  maxPlayers: 5,
  maxPlaytime: 60,
  minPlayers: 2,
  minPlaytime: 30,
  name: "Harbour Lantern",
  ownerCategories: [],
  playCount: 0,
  playedBy: [],
  weight: 2.4,
  ...over,
})

describe("the table", () => {
  test("counts the people ticked plus the anonymous seats", () => {
    expect(tableSize(["ada", "grace"], 2)).toBe(4)
  })

  test("a negative guest count cannot shrink the table", () => {
    expect(tableSize(["ada"], -3)).toBe(1)
  })
})

describe("criteriaFromTonight", () => {
  test("maps the three board-game filters, one field each", () => {
    expect(
      criteriaFromTonight({
        filters: { fit: "best", knows: "someone", light: "on" },
        guestCount: 1,
        personIds: ["ada", "grace"],
      }),
    ).toEqual({
      excludedGameIds: [],
      fitness: "bestOnly",
      maxWeight: LIGHT_MAX_WEIGHT,
      personIds: ["ada", "grace"],
      playerCount: 3,
      rulesKnown: "someone",
    })
  })

  test("OK widens the fit, and Keep it light Off lifts the ceiling", () => {
    expect(
      criteriaFromTonight({
        filters: { fit: "ok", knows: "any", light: "off" },
        guestCount: 0,
        personIds: ["linus"],
      }),
    ).toMatchObject({
      fitness: "bestOrRecommended",
      maxWeight: null,
      rulesKnown: "any",
    })
  })

  test("All is the engine's `everyone` — the word the decision uses", () => {
    expect(
      criteriaFromTonight({
        filters: { knows: "all" },
        guestCount: 0,
        personIds: ["ada"],
      }).rulesKnown,
    ).toBe("everyone")
  })

  test("carries the ticked people through, not only the count", () => {
    // Their complexity ceilings and their shared history are what this is for. A number
    // alone would offer somebody a game they will not play.
    expect(
      criteriaFromTonight({
        filters: {},
        guestCount: 3,
        personIds: ["ada"],
      }),
    ).toMatchObject({ personIds: ["ada"], playerCount: 4 })
  })
})

describe("known-how", () => {
  test("is called something different per activity", () => {
    expect(knownHowLabel("board-games")).toBe("Knows the rules")
    expect(knownHowLabel("video-games")).toBe("Knows how to play")
  })

  test("proposes everybody who was at the table", () => {
    expect(knownHowProposal(["ada", "grace"])).toEqual(["ada", "grace"])
  })

  test("reads the existing claims for one game and no other", () => {
    const claims = [
      { confirmedAt: "2026-01-01T00:00:00.000Z", gameId: "harbour-lantern", personId: "ada" },
      { confirmedAt: "2026-01-01T00:00:00.000Z", gameId: "quarry-duel", personId: "grace" },
    ]
    expect(knownHowFor(claims, "harbour-lantern")).toEqual(["ada"])
  })
})

describe("what a card says", () => {
  test("names the complexity band, and unrated is not light", () => {
    expect(weightLabel(1.2)).toBe("Light (1.2)")
    expect(weightLabel(2.4)).toBe("Medium-light (2.4)")
    expect(weightLabel(4.5)).toBe("Heavy (4.5)")
    expect(weightLabel(null)).toBe("Complexity unrated")
  })

  test("the player-count line", () => {
    expect(playerCountLine(card())).toBe("2–5 players · best with 3–4")
    expect(playerCountLine(card({ bestWith: [] }))).toBe("2–5 players")
    expect(
      playerCountLine(card({ bestWith: [2, 5], maxPlayers: 5, minPlayers: 2 })),
    ).toBe("2–5 players · best with 2, 5")
    expect(
      playerCountLine(card({ bestWith: [], maxPlayers: 1, minPlayers: 1 })),
    ).toBe("1 player")
  })

  test("the playtime, or nothing when the box never said", () => {
    expect(playtimeLabel(card())).toBe("30–60 min")
    expect(playtimeLabel(card({ maxPlaytime: 45, minPlaytime: 45 }))).toBe("45 min")
    expect(
      playtimeLabel(card({ maxPlaytime: null, minPlaytime: null })),
    ).toBeNull()
  })

  test("the play count, in a sentence", () => {
    expect(playCountLabel(0)).toBe("Never played")
    expect(playCountLabel(1)).toBe("Played once")
    expect(playCountLabel(12)).toBe("Played 12 times")
  })
})

describe("box art comes off THIS app's origin", () => {
  test("rewrites the absorbed app's own path", () => {
    expect(boxArtUrl("/images/aaaa-600.webp")).toBe(
      "/api/board-games/images/aaaa-600.webp",
    )
  })

  test("leaves an absolute URL alone and answers null for nothing", () => {
    expect(boxArtUrl("https://example.test/a.png")).toBe(
      "https://example.test/a.png",
    )
    expect(boxArtUrl(null)).toBeNull()
    expect(boxArtUrl("")).toBeNull()
  })
})

describe("the shelf, filtered", () => {
  const shelf = [
    card(),
    card({ id: "quarry-duel", name: "Quarry Duel" }),
    card({ id: "tidewright", isExcluded: true, name: "Tidewright" }),
  ]

  test("an empty term is the whole shelf — this screen IS the shelf", () => {
    expect(filterCollection(shelf, {}).map((g) => g.id)).toEqual([
      "harbour-lantern",
      "quarry-duel",
    ])
  })

  test("a game taken off the shelf is hidden until it is asked for", () => {
    expect(
      filterCollection(shelf, { isExcludedShown: true }).map((g) => g.id),
    ).toContain("tidewright")
  })

  test("matches part of a name, ignoring case", () => {
    expect(filterCollection(shelf, { query: "quarry" }).map((g) => g.id)).toEqual([
      "quarry-duel",
    ])
  })
})
