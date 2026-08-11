import { describe, expect, test } from "vitest"

import { labelForHash, parseHash } from "./parseHash"

/**
 * The four routes are a settled IA — Play is the landing and the two configurators
 * hang off it (decision `2026-07-21-queues-vs-channels-taxonomy-play-first-ia`) —
 * and the e2e suites navigate by assigning these hashes directly.
 */

describe("parseHash", () => {
  test("the empty hash is PLAY, the landing", () => {
    expect(parseHash("")).toEqual({ view: "play" })
    expect(parseHash("#/")).toEqual({ view: "play" })
  })

  test("#/queues is the shelf configurator", () => {
    expect(parseHash("#/queues")).toEqual({
      view: "queues",
    })
  })

  test("#/q/<id> opens one set, id-decoded", () => {
    expect(parseHash("#/q/bob_anime")).toEqual({
      id: "bob_anime",
      view: "queue",
    })
    expect(parseHash("#/q/a%20b")).toEqual({
      id: "a b",
      view: "queue",
    })
  })

  test("#/channels names a rotation channel, or none", () => {
    expect(parseHash("#/channels")).toEqual({
      id: null,
      view: "channels",
    })
    expect(parseHash("#/channels/shows_shorts")).toEqual({
      id: "shows_shorts",
      view: "channels",
    })
  })

  test("an unknown hash falls back to PLAY rather than a blank page", () => {
    expect(parseHash("#/nope")).toEqual({ view: "play" })
  })
})

describe("labelForHash", () => {
  test("names where back actually goes", () => {
    expect(labelForHash("#/queues")).toBe("‹ Queues")
    expect(labelForHash("#/channels/movies")).toBe(
      "‹ Channels",
    )
    expect(labelForHash("#/q/bob")).toBe("‹ Back")
    expect(labelForHash("#/")).toBe("‹ Play")
  })
})
