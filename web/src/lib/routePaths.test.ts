import { matchRoutes, type RouteObject } from "react-router"
import { describe, expect, test } from "vitest"

import {
  canonicalCollectionPath,
  canonicalWatchPlayPath,
  labelForPath,
  ROUTE_PATHS,
} from "./routePaths"

/**
 * The routes are a settled IA — the mode landing is the front door and everything else hangs
 * off it — and they are real paths as of 2026-08-16, not `#/…`
 * (decision `2026-08-16-routing-is-paths-not-hashes`). The e2e suites navigate by
 * `page.goto()`ing these paths, which only works because the server answers them with
 * index.html.
 *
 * MATCHED HERE BY REACT-ROUTER ITSELF, not by a hand-written parser: `matchRoutes` is the
 * same pure function `<Routes>` uses, so this file pins what the app will really do with a
 * pathname (decision `2026-08-27-the-route-table-is-react-router-not-a-parsed-pathname`).
 * The patterns come from `ROUTE_PATHS`, which is what `App.tsx` renders — one source, and no
 * second table to drift.
 *
 * `/g/<id>` and `/collection` and `/tonight` are still LIVE addresses. Each one matches its
 * own legacy route, which paints the page it moved to and rewrites the URL underneath; the
 * rewrite itself is pinned by `e2e/routing-test.ts`, because it needs a browser.
 */

const routes: RouteObject[] = Object.entries(
  ROUTE_PATHS,
).map(([id, path]) => ({ id, path }))

/** The route key a pathname lands on, plus whatever it captured. */
function match(pathname: string) {
  const matches = matchRoutes(routes, pathname)
  const last = matches?.[matches.length - 1]

  return {
    params: last?.params ?? {},
    route: last?.route.id ?? null,
  }
}

describe("the route table", () => {
  test("the root path is the mode landing", () => {
    expect(match("/").route).toBe("home")
  })

  test("/admin is the management page", () => {
    expect(match("/admin").route).toBe("admin")
  })

  test("a retired group page is its own legacy route", () => {
    expect(match("/g/bob").route).toBe("legacyGroup")
    expect(match("/g").route).toBe("legacyGroup")
    expect(match("/g/bob/").route).toBe("legacyGroup")
  })

  test("/picks is the shelf configurator", () => {
    expect(match("/picks").route).toBe("picks")
  })

  test("the retired /queues path has its own redirect route", () => {
    expect(match("/queues").route).toBe("legacyQueues")
  })

  test("/q/<id> opens one set, id-decoded", () => {
    expect(match("/q/bob_anime")).toEqual({
      params: { setId: "bob_anime" },
      route: "queue",
    })
    expect(match("/q/a%20b").params.setId).toBe("a b")
  })

  test("/channels names a rotation channel, or none", () => {
    expect(match("/channels")).toEqual({
      params: {},
      route: "channels",
    })
    expect(match("/channels/shows_shorts").params).toEqual({
      channelId: "shows_shorts",
    })
  })

  /**
   * A trailing slash was unreachable under the hash router and is reachable now — a proxy
   * rewrite, a pasted link or a typed URL all produce one. The parser this replaced had to
   * strip it by hand; react-router matches through it.
   */
  test("a trailing slash is the same route", () => {
    expect(match("/picks/").route).toBe("picks")
    expect(match("/channels/").route).toBe("channels")
    expect(match("/q/bob_anime/").params.setId).toBe(
      "bob_anime",
    )
  })

  /**
   * What to Watch/Play and its two STEPS. The step is where a `startsWith` router goes wrong
   * in the direction that never fails loudly — it answers "yes, this is the view" and drops
   * which screen of it you asked for.
   */
  test("What to Watch/Play carries its step", () => {
    expect(match("/what-to-watch-play")).toEqual({
      params: {},
      route: "watchPlay",
    })
    expect(
      match("/what-to-watch-play/surprise").params.step,
    ).toBe("surprise")
    expect(
      match("/what-to-watch-play/go").params.step,
    ).toBe("go")
  })

  test("the legacy /tonight keeps its step too", () => {
    expect(match("/tonight").route).toBe("legacyTonight")
    expect(match("/tonight/go").params.step).toBe("go")
    expect(match("/tonight/go/").params.step).toBe("go")
  })

  test("/result is the pick, named or not", () => {
    expect(match("/result")).toEqual({
      params: {},
      route: "result",
    })
    expect(match("/result/catan").params.gameId).toBe(
      "catan",
    )
  })

  test("the board-game shelf answers to its long name", () => {
    expect(match("/board-game-collection").route).toBe(
      "boardGameCollection",
    )
    expect(match("/board-game-collection/").route).toBe(
      "boardGameCollection",
    )
  })

  test("the old /collection is its own legacy route", () => {
    expect(match("/collection").route).toBe(
      "legacyCollection",
    )
    expect(match("/collection/").route).toBe(
      "legacyCollection",
    )
    // …and a longer word that merely starts the same way is NOT the shelf.
    expect(match("/collections").route).toBe("fallback")
  })

  test("an unknown path falls back rather than 404ing", () => {
    expect(match("/nope").route).toBe("fallback")
  })
})

describe("the legacy rewrites", () => {
  test("a moved path keeps its tail", () => {
    expect(canonicalWatchPlayPath("surprise")).toBe(
      "/what-to-watch-play/surprise",
    )
    expect(canonicalWatchPlayPath()).toBe(
      "/what-to-watch-play",
    )
    expect(canonicalCollectionPath("x")).toBe(
      "/board-game-collection/x",
    )
    expect(canonicalCollectionPath()).toBe(
      "/board-game-collection",
    )
  })
})

describe("labelForPath", () => {
  test("names where back actually goes", () => {
    expect(labelForPath("/picks")).toBe("‹ Picks")
    expect(labelForPath("/queues")).toBe("‹ Picks")
    expect(labelForPath("/channels/movies")).toBe("‹ Rules")
    expect(labelForPath("/q/bob")).toBe("‹ Back")
    expect(labelForPath("/board-game-collection")).toBe(
      "‹ Collection",
    )
    // The old address, which is still a live link and still names the same page.
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
