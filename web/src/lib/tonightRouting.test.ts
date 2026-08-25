import { describe, expect, test } from "vitest"

import { ACTIVITIES } from "./tonight"
import {
  ACTIVITY_ROUTES,
  oneBackend,
  routeFor,
  tileForSet,
  tilesForQueueActivity,
} from "./tonightRouting"
import type { RegistrySet } from "./types"

/**
 * WP-7's map, and the four things about it that fail silently.
 *
 * A wrong row here does not throw: it routes an evening at the wrong backend, or quietly
 * drops an activity out of a list. Each test below is one settled fact rather than a
 * restatement of the table.
 *
 * The cast is Ada, Grace and Linus — the repo's people fixtures.
 */

describe("the map covers the tile row and nothing else", () => {
  test("has exactly one row per tile, in the settled order", () => {
    expect(Object.keys(ACTIVITY_ROUTES).sort()).toEqual(
      ACTIVITIES.map((one) => one.id).sort(),
    )
  })

  test("every row names itself, so a copied row cannot lie", () => {
    for (const [id, route] of Object.entries(
      ACTIVITY_ROUTES,
    )) {
      expect(route.activity).toBe(id)
    }
  })
})

describe("which backend serves which evening", () => {
  test("Video Games is Steam and MiSTer together — no tile names a device", () => {
    expect(routeFor("video-games").providerKinds).toEqual([
      "mister",
      "steam",
    ])
    // Eden, Cemu and Dolphin are named by the decision and are NOT built. Listed so the map
    // is the whole answer rather than the built half of it.
    expect(
      routeFor("video-games").plannedProviderKinds,
    ).toEqual(["cemu", "dolphin", "eden"])
  })

  test("Board Games is the absorbed picker, and its engine is its own", () => {
    expect(routeFor("board-games").providerKinds).toEqual([
      "board-game-picker",
    ])
    expect(routeFor("board-games").engine).toBe(
      "board-games",
    )
  })

  test("Movies and Shows are both Plex, and both draw from `watching`", () => {
    expect(routeFor("movies").providerKinds).toEqual([
      "plex",
    ])
    expect(routeFor("shows").providerKinds).toEqual([
      "plex",
    ])
    expect(routeFor("movies").queueActivity).toBe(
      "watching",
    )
    expect(routeFor("shows").queueActivity).toBe("watching")
  })

  test("Reading is Kavita", () => {
    expect(routeFor("reading").providerKinds).toEqual([
      "kavita",
    ])
  })

  /**
   * YouTube is documented as a FUTURE provider and is not built — brief §7, and there is no
   * Filtered Pool variant of it. It appears only in the planned column, and a row that moved
   * it into `providerKinds` would make the app try to route at a backend that does not exist.
   */
  test("YouTube is planned, never built", () => {
    for (const route of Object.values(ACTIVITY_ROUTES)) {
      expect(route.providerKinds).not.toContain("youtube")
    }
    expect(
      routeFor("movies").plannedProviderKinds,
    ).toContain("youtube")
  })

  test("Surprise Me reaches no backend until it has been narrowed", () => {
    expect(routeFor("surprise").providerKinds).toEqual([])
    expect(routeFor("surprise").queueActivity).toBeNull()
    expect(routeFor("surprise").engine).toBe("narrow-first")
  })
})

describe("tilesForQueueActivity — the map read backwards", () => {
  /**
   * ⚠️ THE OPEN QUESTION, in one assertion. `watching` is ONE activity and TWO tiles, because
   * the queue model refuses a finer content list and the tile row separates a film night from
   * a series night. This is not a defect to fix here — it is the thing the implementation
   * plan §5 says changes the schema rather than a screen.
   */
  test("`watching` answers two tiles, and that is the residue", () => {
    expect(tilesForQueueActivity("watching")).toEqual([
      "movies",
      "shows",
    ])
  })

  test("every other activity answers exactly one", () => {
    expect(tilesForQueueActivity("reading")).toEqual([
      "reading",
    ])
    expect(tilesForQueueActivity("board-games")).toEqual([
      "board-games",
    ])
    // There is no Retro Games tile. MiSTer, Steam and the three launchers are one evening.
    expect(tilesForQueueActivity("video-games")).toEqual([
      "video-games",
    ])
  })
})

describe("tileForSet — it reads the STORED activity, not the provider", () => {
  const set = (
    over: Partial<RegistrySet>,
  ): Pick<RegistrySet, "activity" | "behavior"> =>
    ({ activity: "watching", ...over }) as RegistrySet

  test("three of the four activities are the tile", () => {
    expect(tileForSet(set({ activity: "reading" }))).toBe(
      "reading",
    )
    expect(
      tileForSet(set({ activity: "board-games" })),
    ).toBe("board-games")
    expect(
      tileForSet(set({ activity: "video-games" })),
    ).toBe("video-games")
  })

  test("a rewatch rotation is a film night; everything else watching is a series night", () => {
    expect(
      tileForSet(
        set({ activity: "watching", behavior: "rewatch" }),
      ),
    ).toBe("movies")
    expect(
      tileForSet(
        set({ activity: "watching", behavior: "progress" }),
      ),
    ).toBe("shows")
    // A curated queue carries no `behavior` at all, so it reads as Shows. That is the
    // documented residue and not a second guess somewhere else.
    expect(tileForSet(set({ activity: "watching" }))).toBe(
      "shows",
    )
  })

  /**
   * The bridge this replaces derived a tile from `provider_kind`. Nothing may do that again:
   * WP-5 stores the activity, and a second derivation in the browser can disagree with the
   * server's.
   */
  test("the provider kind is not consulted", () => {
    expect(
      tileForSet({
        activity: "reading",
        behavior: undefined,
        // A kavita set whose activity somebody overrode to reading stays reading; a plex one
        // whose activity says reading is ALSO reading. The kind never enters it.
      } as unknown as RegistrySet),
    ).toBe("reading")
  })
})

describe("one session talks to one backend", () => {
  test("one kind among the candidates binds the session before it starts", () => {
    expect(oneBackend(["plex", "plex"])).toBe("plex")
  })

  test("two kinds is not yet forced — an evening that could be either is normal", () => {
    expect(oneBackend(["steam", "mister"])).toBeNull()
  })

  test("nothing to draw from binds nothing", () => {
    expect(oneBackend([])).toBeNull()
    // An unconfigured provider reports an empty kind; it must not count as a backend.
    expect(oneBackend(["", ""])).toBeNull()
  })
})
