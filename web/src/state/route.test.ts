import { describe, expect, test } from "vitest"

import { labelForPath, parsePath } from "./parsePath"

/**
 * The four routes are a settled IA — Play is the landing and the two configurators
 * hang off it (decision `2026-07-21-queues-vs-channels-taxonomy-play-first-ia`) —
 * and they are real paths as of 2026-08-16, not `#/…`
 * (decision `2026-08-16-routing-is-paths-not-hashes`). The e2e suites navigate by
 * `page.goto()`ing these paths, which only works because the server answers them
 * with index.html.
 */

describe("parsePath", () => {
  test("the root path is PLAY, the landing", () => {
    expect(parsePath("/")).toEqual({ view: "play" })
  })

  test("/queues is the shelf configurator", () => {
    expect(parsePath("/queues")).toEqual({
      view: "queues",
    })
  })

  test("/q/<id> opens one set, id-decoded", () => {
    expect(parsePath("/q/bob_anime")).toEqual({
      id: "bob_anime",
      view: "queue",
    })
    expect(parsePath("/q/a%20b")).toEqual({
      id: "a b",
      view: "queue",
    })
  })

  test("/channels names a rotation channel, or none", () => {
    expect(parsePath("/channels")).toEqual({
      id: null,
      view: "channels",
    })
    expect(parsePath("/channels/shows_shorts")).toEqual({
      id: "shows_shorts",
      view: "channels",
    })
  })

  /**
   * A trailing slash was unreachable under the hash router and is reachable now — a
   * proxy rewrite, a pasted link or a typed URL all produce one. Without the strip,
   * `/queues/` fell through to the PLAY fallback and the configurator silently did
   * not open.
   */
  test("a trailing slash is the same route", () => {
    expect(parsePath("/queues/")).toEqual({
      view: "queues",
    })
    expect(parsePath("/channels/")).toEqual({
      id: null,
      view: "channels",
    })
    expect(parsePath("/q/bob_anime/")).toEqual({
      id: "bob_anime",
      view: "queue",
    })
  })

  test("an unknown path falls back to PLAY rather than a blank page", () => {
    expect(parsePath("/nope")).toEqual({ view: "play" })
  })
})

describe("labelForPath", () => {
  test("names where back actually goes", () => {
    expect(labelForPath("/queues")).toBe("‹ Ordered Queues")
    expect(labelForPath("/channels/movies")).toBe("‹ Pools")
    expect(labelForPath("/q/bob")).toBe("‹ Back")
    expect(labelForPath("/")).toBe("‹ Play")
  })
})
