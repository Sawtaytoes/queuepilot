import { describe, expect, it } from "vitest"

import { SURPRISE_SCOPES } from "./tonight"
import { drawSurprise, drawTonight } from "./tonightDraw"
import type { TonightPreset } from "./tonightPreset"
import type {
  BoardGame,
  PickResponse,
  TonightPickResponse,
  TonightPickWire,
} from "./types"

/**
 * The one draw behind BOTH the Go button and a preset card's address.
 *
 * Every request is stubbed, so this asserts the two things that would otherwise only be
 * visible on a live screen: which door each activity knocks on, and what shape of session
 * comes back for the result card to read.
 */

const call = (): {
  calls: { method: string; url: string; body: unknown }[]
  request: <T>(
    method: string,
    url: string,
    body?: unknown,
  ) => Promise<T>
  reply: (answer: unknown) => void
} => {
  const calls: {
    method: string
    url: string
    body: unknown
  }[] = []
  let answer: unknown = null

  return {
    calls,
    reply: (next: unknown) => {
      answer = next
    },
    request: <T>(
      method: string,
      url: string,
      body?: unknown,
    ): Promise<T> => {
      calls.push({ body, method, url })

      return Promise.resolve(answer as T)
    },
  }
}

const game = (id: string): BoardGame =>
  ({ id, name: `Game ${id}` }) as BoardGame

const boardGames: TonightPreset = {
  activity: "board-games",
  filters: {
    categories: "",
    complexity: "light",
    fit: "best",
    interactionType: "any",
    knows: "someone",
    maxPlaytime: "any",
  },
  guestCount: 0,
  personIds: ["ada", "linus"],
}

const movies: TonightPreset = {
  activity: "movies",
  filters: { runtime: "120", seen: "any" },
  guestCount: 0,
  personIds: ["ada"],
}

const queuePick = (setId: string): TonightPickWire =>
  ({
    delivery: "push",
    setId,
    setLabel: `Queue ${setId}`,
    source: "rotation",
  }) as TonightPickWire

describe("drawTonight", () => {
  it("draws board games off the SHELF and returns a board-game session", async () => {
    const stub = call()
    stub.reply({
      result: null,
      shortlist: [
        { game: game("a"), playCount: 0, verdict: "best" },
      ],
    } satisfies PickResponse)

    const outcome = await drawTonight(
      boardGames,
      stub.request,
    )

    expect(stub.calls[0]?.url).toBe("/api/board-games/pick")
    expect(outcome).toMatchObject({
      isDrawn: true,
      session: {
        activity: "board-games",
        kind: "board-game",
        // A pick made HERE is rerollable. `queue` origin is a queue arrival, and that one has
        // no reroll because the queue already chose.
        origin: "pick",
        personIds: ["ada", "linus"],
      },
    })
  })

  it("carries the filters into the criteria rather than dropping them", async () => {
    const stub = call()
    stub.reply({
      result: null,
      shortlist: [
        { game: game("a"), playCount: 0, verdict: "best" },
      ],
    } satisfies PickResponse)

    await drawTonight(
      {
        ...boardGames,
        filters: {
          categories: "",
          complexity: "any",
          fit: "ok",
          interactionType: "any",
          knows: "all",
          maxPlaytime: "any",
        },
      },
      stub.request,
    )

    expect(stub.calls[0]?.body).toMatchObject({
      fitness: "bestOrRecommended",
      maxWeight: null,
      playerCount: 2,
      rulesKnown: "everyone",
    })
  })

  // A shelf pick is chosen BY table size, so an unstated table is refused rather than
  // defaulted. This is the same rule a preset card's parser holds, one layer down.
  it("refuses a board-game draw for a table nobody stated", async () => {
    const stub = call()

    const outcome = await drawTonight(
      { ...boardGames, guestCount: 0, personIds: [] },
      stub.request,
    )

    expect(outcome).toMatchObject({ isDrawn: false })
    expect(stub.calls).toHaveLength(0)
  })

  it("draws every other tile from the QUEUES and returns a queue session", async () => {
    const stub = call()
    stub.reply({
      backend: "plex",
      notes: ["a note"],
      pick: queuePick("movie_night"),
      shortlist: [queuePick("movie_night")],
    } satisfies TonightPickResponse)

    const outcome = await drawTonight(movies, stub.request)

    expect(stub.calls[0]?.url).toBe("/api/tonight/pick")
    expect(stub.calls[0]?.body).toMatchObject({
      activity: "movies",
      excludedSetIds: [],
      personIds: ["ada"],
    })
    expect(outcome).toMatchObject({
      isDrawn: true,
      session: {
        backend: "plex",
        kind: "queue",
        notes: ["a note"],
        origin: "pick",
      },
    })
  })

  it("passes an empty draw's own REASON through rather than inventing one", async () => {
    const stub = call()
    stub.reply({
      backend: null,
      pick: null,
      reason:
        "No queue matches that activity and the people you ticked.",
      shortlist: [],
    } satisfies TonightPickResponse)

    const outcome = await drawTonight(movies, stub.request)

    expect(outcome).toEqual({
      isDrawn: false,
      reason:
        "No queue matches that activity and the people you ticked.",
    })
  })

  // A preset card still cannot answer the second-screen question for somebody standing in
  // front of it. The interactive screen calls `drawSurprise` after the person chooses.
  it("refuses bare Surprise Me without asking any backend", async () => {
    const stub = call()

    const outcome = await drawTonight(
      {
        activity: "surprise",
        filters: {},
        guestCount: 0,
        personIds: ["ada"],
      },
      stub.request,
    )

    expect(outcome).toMatchObject({ isDrawn: false })
    expect(stub.calls).toHaveLength(0)
  })

  it("chooses an activity inside Media, then uses that activity's existing engine", async () => {
    const stub = call()
    stub.reply({
      backend: "plex",
      notes: [],
      pick: queuePick("shows"),
      shortlist: [queuePick("shows")],
    } satisfies TonightPickResponse)
    const media = SURPRISE_SCOPES.find(
      (scope) => scope.id === "media",
    )!

    const outcome = await drawSurprise(
      {
        guestCount: 0,
        personIds: ["ada"],
        scope: media,
      },
      stub.request,
      // Swaps the two rows, so Shows is the deterministic first choice.
      () => 0,
    )

    expect(stub.calls[0]?.body).toMatchObject({
      activity: "shows",
      personIds: ["ada"],
    })
    expect(outcome).toMatchObject({
      isDrawn: true,
      session: { activity: "shows", kind: "queue" },
    })
  })

  it("tries the other Games activity when the first one has no answer", async () => {
    const calls: { body: unknown; url: string }[] = []
    const games = SURPRISE_SCOPES.find(
      (scope) => scope.id === "games",
    )!
    const request = <T>(
      _method: string,
      url: string,
      body?: unknown,
    ): Promise<T> => {
      calls.push({ body, url })
      if (url === "/api/tonight/pick") {
        return Promise.resolve({
          backend: null,
          pick: null,
          reason: "No video-game queue matches.",
          shortlist: [],
        } as T)
      }
      return Promise.resolve({
        result: null,
        shortlist: [
          {
            game: game("compile"),
            playCount: 0,
            verdict: "best",
          },
        ],
      } as T)
    }

    const outcome = await drawSurprise(
      {
        guestCount: 0,
        personIds: ["ada", "linus"],
        scope: games,
      },
      request,
      // Leaves Video Games before Board Games.
      () => 0.999,
    )

    expect(calls.map((one) => one.url)).toEqual([
      "/api/tonight/pick",
      "/api/board-games/pick",
    ])
    expect(outcome).toMatchObject({
      isDrawn: true,
      session: {
        activity: "board-games",
        kind: "board-game",
      },
    })
  })
})
