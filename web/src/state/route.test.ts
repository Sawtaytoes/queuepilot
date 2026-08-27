import { describe, expect, test } from "vitest"

import {
  canonicalPath,
  labelForPath,
  parsePath,
} from "./parsePath"

/**
 * The routes are a settled IA — the root is a mode landing, with Admin and What to
 * Watch/Play as the two top-level choices — and they are real paths as of 2026-08-16, not
 * `#/…`
 * (decision `2026-08-16-routing-is-paths-not-hashes`). The e2e suites navigate by
 * `page.goto()`ing these paths, which only works because the server answers them
 * with index.html.
 *
 * `/g/<group>` joined them on 2026-08-17. It is the ADMIN landing with a filter, not a fifth
 * view, which is why it parses to `{view: "play"}` carrying a group. Everything else stays
 * group-agnostic: a queue has one canonical address even when three groups hold it.
 */

describe("parsePath", () => {
  test("the root path is the mode landing", () => {
    expect(parsePath("/")).toEqual({
      view: "home",
    })
  })

  test("/admin opens the administrative landing", () => {
    expect(parsePath("/admin")).toEqual({
      view: "admin",
    })
  })

  test("/g/<group> is the landing filtered, id-decoded", () => {
    expect(parsePath("/g/bob")).toEqual({
      group: "bob",
      view: "play",
    })
    expect(parsePath("/g/bob%20%26%20alice")).toEqual({
      group: "bob & alice",
      view: "play",
    })
    // Trailing slash is the same page, like every other route.
    expect(parsePath("/g/bob/")).toEqual({
      group: "bob",
      view: "play",
    })
  })

  test("a bare /g is the unfiltered Play page, not an empty group", () => {
    expect(parsePath("/g")).toEqual({
      group: null,
      view: "play",
    })
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

  /**
   * The three What to Watch/Play addresses. `/tonight/go` is a PRESET CARD's — the answers the form
   * would have collected, in the query string — and it must not be swallowed by the bare
   * `/tonight`, or a tapped card opens the empty form it exists to skip.
   */
  test("What to Watch/Play and its two steps", () => {
    expect(parsePath("/what-to-watch-play")).toEqual({
      step: null,
      view: "tonight",
    })
    expect(
      parsePath("/what-to-watch-play/surprise"),
    ).toEqual({
      step: "surprise",
      view: "tonight",
    })
    expect(parsePath("/what-to-watch-play/go")).toEqual({
      step: "go",
      view: "tonight",
    })
    expect(parsePath("/tonight")).toEqual({
      step: null,
      view: "tonight",
    })
    expect(parsePath("/tonight/surprise")).toEqual({
      step: "surprise",
      view: "tonight",
    })
    expect(parsePath("/tonight/go")).toEqual({
      step: "go",
      view: "tonight",
    })
    // The query string is not part of the path, and the step survives it.
    expect(parsePath("/tonight/go")).toEqual({
      step: "go",
      view: "tonight",
    })
    expect(parsePath("/tonight/go/")).toEqual({
      step: "go",
      view: "tonight",
    })
  })

  test("/result is tonight's pick, and /result/<id> is a queue arrival", () => {
    expect(parsePath("/result")).toEqual({
      gameId: null,
      view: "result",
    })
    expect(parsePath("/result/catan")).toEqual({
      gameId: "catan",
      view: "result",
    })
  })

  /**
   * The board-game shelf. It is `/board-game-collection` and not `/collection` because
   * "collection" is ALREADY Plex's word here — `type: "collection"` is a row of films —
   * and because a Steam or Kavita shelf would want the same generic path
   * (decision `2026-08-25-the-board-game-shelf-is-board-game-collection`).
   */
  test("/board-game-collection is the board-game shelf", () => {
    expect(parsePath("/board-game-collection")).toEqual({
      view: "boardGameCollection",
    })
    expect(parsePath("/board-game-collection/")).toEqual({
      view: "boardGameCollection",
    })
  })

  /**
   * The old address still RENDERS the shelf. `canonicalPath` rewrites the URL, and that
   * takes a frame — if this fell through to the PLAY fallback instead, an old link would
   * flash the landing on the way, which reads as a broken bookmark.
   */
  test("the legacy /collection still resolves to the same view", () => {
    expect(parsePath("/collection")).toEqual({
      view: "boardGameCollection",
    })
    expect(parsePath("/collection/")).toEqual({
      view: "boardGameCollection",
    })
  })

  test("an unknown path falls back to the mode landing rather than a blank page", () => {
    expect(parsePath("/nope")).toEqual({
      view: "home",
    })
  })
})

/**
 * The REDIRECT half of the rename. `/collection` was live for a few hours on 2026-08-25,
 * so it is rewritten rather than 404'd — and a path that never moved must answer `null`,
 * or `App` would navigate on every render.
 */
describe("canonicalPath", () => {
  test("a moved path names where it lives now", () => {
    expect(canonicalPath("/collection")).toBe(
      "/board-game-collection",
    )
    expect(canonicalPath("/collection/")).toBe(
      "/board-game-collection",
    )
    expect(canonicalPath("/tonight")).toBe(
      "/what-to-watch-play",
    )
    expect(canonicalPath("/tonight/surprise/")).toBe(
      "/what-to-watch-play/surprise",
    )
  })

  test("the new path is already canonical", () => {
    expect(
      canonicalPath("/board-game-collection"),
    ).toBeNull()
    expect(canonicalPath("/what-to-watch-play")).toBeNull()
  })

  test("every other route is left alone", () => {
    expect(canonicalPath("/")).toBeNull()
    expect(canonicalPath("/admin")).toBeNull()
    expect(canonicalPath("/queues")).toBeNull()
    expect(canonicalPath("/q/bob")).toBeNull()
    expect(canonicalPath("/collections")).toBeNull()
  })
})

describe("labelForPath", () => {
  test("names where back actually goes", () => {
    expect(labelForPath("/queues")).toBe("‹ Picks")
    expect(labelForPath("/channels/movies")).toBe("‹ Rules")
    expect(labelForPath("/q/bob")).toBe("‹ Back")
    expect(labelForPath("/board-game-collection")).toBe(
      "‹ Collection",
    )
    // The legacy path keeps the same label, so a redirect in flight never
    // paints "‹ Play" for a frame.
    expect(labelForPath("/collection")).toBe("‹ Collection")
    expect(labelForPath("/what-to-watch-play")).toBe(
      "‹ What to Watch/Play",
    )
    expect(labelForPath("/tonight")).toBe(
      "‹ What to Watch/Play",
    )
    expect(labelForPath("/admin")).toBe("‹ Admin")
    expect(labelForPath("/")).toBe("‹ QueuePilot")
  })
})
