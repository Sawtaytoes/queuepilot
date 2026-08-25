// The pick survives leaving the screen — and does not survive to the next evening.
import { describe, expect, test } from "vitest"

import {
  clearPickSession,
  PICK_SESSION_KEY,
  PICK_SESSION_MAX_AGE_MS,
  type PickSession,
  readPickSession,
  writePickSession,
} from "./pickSession"

/** A `Storage` that is a plain object — this suite runs in a Node environment. */
function fakeStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed))
  return {
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size
    },
    removeItem: (key: string) => map.delete(key),
    setItem: (key: string, value: string) => map.set(key, value),
  } as Storage
}

const NOW = new Date("2026-08-25T21:00:00.000Z")

const session = (over: Partial<PickSession> = {}): PickSession => ({
  activity: "board-games",
  candidates: [
    {
      game: {
        bestWith: [3],
        boxes: [],
        id: "harbour-lantern",
        imagePath: null,
        interactionTypes: ["competitive"],
        isExcluded: false,
        lastPlayedAt: null,
        links: [],
        maxPlayers: 5,
        maxPlaytime: 60,
        minAge: 10,
        minPlayers: 2,
        minPlaytime: 30,
        modules: [],
        name: "Harbour Lantern",
        notes: null,
        ownerCategories: [],
        playCount: 0,
        playedBy: [],
        publishers: [],
        rating: null,
        recommendedWith: [],
        weight: 2.4,
        yearPublished: 2019,
      },
      playCount: 0,
      verdict: "best",
    },
  ],
  criteria: {
    excludedGameIds: [],
    fitness: "bestOnly",
    maxWeight: null,
    personIds: ["ada"],
    playerCount: 3,
    rulesKnown: "someone",
  },
  excludedGameIds: [],
  guestCount: 2,
  origin: "pick",
  personIds: ["ada"],
  savedAt: NOW.toISOString(),
  ...over,
})

describe("the pick survives leaving the screen", () => {
  test("writes and reads the whole session back", () => {
    const storage = fakeStorage()
    writePickSession(session(), storage)

    expect(readPickSession(storage, NOW)).toEqual(session())
  })

  test("keeps reroll's memory, which is the half that was lost", () => {
    const storage = fakeStorage()
    writePickSession(
      session({ excludedGameIds: ["quarry-duel", "tidewright"] }),
      storage,
    )

    expect(readPickSession(storage, NOW)?.excludedGameIds).toEqual([
      "quarry-duel",
      "tidewright",
    ])
  })

  test("clearing removes it", () => {
    const storage = fakeStorage()
    writePickSession(session(), storage)
    clearPickSession(storage)

    expect(readPickSession(storage, NOW)).toBeNull()
  })
})

describe("what counts as no pick at all", () => {
  test("nothing stored", () => {
    expect(readPickSession(fakeStorage(), NOW)).toBeNull()
  })

  test("no storage at all — a browser that denies it", () => {
    expect(readPickSession(null, NOW)).toBeNull()
    // And writing to one that is not there is not an error either.
    expect(() => writePickSession(session(), null)).not.toThrow()
  })

  test("a value that is not JSON", () => {
    expect(
      readPickSession(fakeStorage({ [PICK_SESSION_KEY]: "{{{" }), NOW),
    ).toBeNull()
  })

  test("a session with no candidates", () => {
    const storage = fakeStorage()
    writePickSession(session({ candidates: [] }), storage)

    expect(readPickSession(storage, NOW)).toBeNull()
  })

  test("last night's pick, once the evening is over", () => {
    const storage = fakeStorage()
    writePickSession(session(), storage)

    const tooLate = new Date(
      NOW.getTime() + PICK_SESSION_MAX_AGE_MS + 1000,
    )
    expect(readPickSession(storage, tooLate)).toBeNull()

    // Still tonight, an hour before the cut-off.
    const stillTonight = new Date(
      NOW.getTime() + PICK_SESSION_MAX_AGE_MS - 60 * 60 * 1000,
    )
    expect(readPickSession(storage, stillTonight)).not.toBeNull()
  })
})

describe("where the card came from", () => {
  test("a queue arrival is remembered as one — it is what removes reroll", () => {
    const storage = fakeStorage()
    writePickSession(session({ origin: "queue" }), storage)

    expect(readPickSession(storage, NOW)?.origin).toBe("queue")
  })

  test("anything unrecognised reads as a pick, which is the one with a reroll", () => {
    const storage = fakeStorage()
    writePickSession(
      session({ origin: "nonsense" as unknown as "pick" }),
      storage,
    )

    expect(readPickSession(storage, NOW)?.origin).toBe("pick")
  })
})
