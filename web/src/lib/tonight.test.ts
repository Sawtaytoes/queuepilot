import { describe, expect, test } from "vitest"
import {
  ACTIVITIES,
  defaultModeFor,
  goLabel,
  isProviderWorthNaming,
  queueMatchesPeople,
  queuesForTonight,
  rosterOrder,
  SURPRISE_SCOPES,
  type TonightQueue,
  tonightQueues,
} from "./tonight"
import { tilesForQueueActivity } from "./tonightRouting"
import type { RegistrySet } from "./types"

/**
 * The Tonight surface's two rules and its one settled list.
 *
 * These are unit-tested rather than only driven in the browser because each of them is a
 * thing the owner SETTLED, and each fails silently: a tile quietly reordered, a segment
 * quietly defaulting the other way, a people filter that quietly hides everything.
 *
 * The cast is Ada, Grace and Linus — the repo's people fixtures.
 */

const queue = (
  over: Partial<TonightQueue> & Pick<TonightQueue, "id">,
): TonightQueue => ({
  activity: "movies",
  delivery: "push",
  hasRoster: true,
  name: "Movies",
  optionalPeople: [],
  peopleNames: [],
  providerLabel: "",
  requiredPeople: [],
  ...over,
})

describe("the activity tiles", () => {
  test("are the settled six, in the settled order", () => {
    expect(ACTIVITIES.map((a) => a.id)).toEqual([
      "video-games",
      "board-games",
      "movies",
      "shows",
      "reading",
      "surprise",
    ])
  })

  test("Surprise Me is last", () => {
    expect(ACTIVITIES.at(-1)?.id).toBe("surprise")
  })

  test("there is no Retro Games tile — MiSTer is Video Games", () => {
    expect(ACTIVITIES.map((a) => a.label)).not.toContain(
      "Retro Games",
    )
    // The MiSTer half of the rule, asked of the routing map rather than of a provider
    // kind: everything under the `video-games` queue activity — Steam, MiSTer and the
    // three launchers that are not built — lands on exactly ONE tile.
    expect(tilesForQueueActivity("video-games")).toEqual([
      "video-games",
    ])
  })

  /**
   * The rule this pins is "a tile names the evening, never the backend". A brand landing
   * in a label or a hint is the exact regression, and it is invisible in review because a
   * brand name reads as helpful.
   */
  test("name no provider brand, in a label or a hint", () => {
    const brands = [
      "Plex",
      "Kavita",
      "Steam",
      "MiSTer",
      "YouTube",
      "Jellyfin",
      "Emby",
      "Eden",
      "Cemu",
      "Dolphin",
    ]

    for (const activity of ACTIVITIES) {
      for (const brand of brands) {
        expect(
          `${activity.label} ${activity.hint}`,
        ).not.toContain(brand)
      }
    }
  })
})

describe("the segment's default", () => {
  /** The three the absorb decision fixes. The other three are this file's call. */
  test("board games start on Pick", () => {
    expect(defaultModeFor("board-games")).toBe("pick")
  })

  test("shows and reading start on Queues", () => {
    expect(defaultModeFor("shows")).toBe("queues")
    expect(defaultModeFor("reading")).toBe("queues")
  })

  test("no activity chosen falls back to Pick", () => {
    expect(defaultModeFor(null)).toBe("pick")
  })
})

describe("the people filter", () => {
  /**
   * ⚠️ THE SEAM. A queue written before WP-5 carries no people, and applying the rule to
   * it would hide every queue the moment one person is ticked. Deleting this branch is
   * how the screen goes blank on the live data.
   */
  test("never hides a queue that carries no roster", () => {
    const legacy = queue({ hasRoster: false, id: "legacy" })

    expect(queueMatchesPeople(legacy, [])).toBe(true)
    expect(queueMatchesPeople(legacy, ["ada"])).toBe(true)
    expect(
      queueMatchesPeople(legacy, ["ada", "grace"]),
    ).toBe(true)
  })

  test("every selected person must be on the queue", () => {
    const adaOnly = queue({
      id: "ada-movies",
      requiredPeople: ["ada"],
    })

    expect(queueMatchesPeople(adaOnly, ["ada"])).toBe(true)
    // Grace is not on it, so ticking Grace hides it — the decision's own example.
    expect(
      queueMatchesPeople(adaOnly, ["ada", "grace"]),
    ).toBe(false)
  })

  test("every required person must be selected", () => {
    const both = queue({
      id: "ada-grace",
      requiredPeople: ["ada", "grace"],
    })

    expect(queueMatchesPeople(both, ["ada"])).toBe(false)
    expect(queueMatchesPeople(both, ["ada", "grace"])).toBe(
      true,
    )
    // Nobody ticked is the unfiltered list, not the empty one — a filter with nothing in
    // it matches everything, and the strict reading of the rule gets this backwards.
    expect(queueMatchesPeople(both, [])).toBe(true)
  })

  test("an optional person is the hatch — being there does not remove the queue", () => {
    const withGuest = queue({
      id: "ada-plus",
      optionalPeople: ["linus"],
      requiredPeople: ["ada"],
    })

    expect(
      queueMatchesPeople(withGuest, ["ada", "linus"]),
    ).toBe(true)
    // …but an optional person is not a required one.
    expect(queueMatchesPeople(withGuest, ["ada"])).toBe(
      true,
    )
  })
})

describe("queuesForTonight", () => {
  const all = [
    queue({
      activity: "movies",
      id: "movies-1",
      requiredPeople: ["ada"],
    }),
    queue({
      activity: "shows",
      id: "shows-1",
      optionalPeople: ["grace"],
      requiredPeople: ["ada"],
    }),
    queue({
      activity: "reading",
      id: "reading-1",
      requiredPeople: ["linus"],
    }),
  ]

  test("narrows to the chosen activity", () => {
    expect(
      queuesForTonight(all, "shows", []).map((q) => q.id),
    ).toEqual(["shows-1"])
  })

  test("no activity chosen is no list — not every queue", () => {
    expect(queuesForTonight(all, null, [])).toEqual([])
  })

  test("Surprise Me crosses activities and narrows by people alone", () => {
    // Ada and Grace: the Shows queue lists Grace as optional, so it stays. The Movies
    // queue does not list her at all, so it goes — the decision's own worked example.
    expect(
      queuesForTonight(all, "surprise", [
        "ada",
        "grace",
      ]).map((q) => q.id),
    ).toEqual(["shows-1"])
  })
})

describe("tonightQueues — the registry projection", () => {
  const set = (
    over: Partial<RegistrySet> & Pick<RegistrySet, "id">,
  ) =>
    ({
      // WP-5 stores the activity ON the set, and `tileForSet()` reads it. The projection no
      // longer re-derives it from `provider_kind`, so a fixture has to say what it is.
      activity: "watching",
      activity_default: "watching",
      blocklist: [],
      delivery: "push",
      kind: "picks",
      label: "",
      provider_kind: "plex",
      providers: [],
      sections: [],
      skipped: [],
      source: "queue",
      vocabulary: {
        done: "watched",
        member: "show",
        unit: "episode",
        units: "episodes",
        verb: "Play",
      },
      ...over,
    }) as RegistrySet

  test("reports every queue rosterless until WP-5 fills them in", () => {
    const [projected] = tonightQueues(
      [set({ id: "a", label: "A" })],
      new Map(),
    )

    expect(projected?.hasRoster).toBe(false)
    expect(projected?.requiredPeople).toEqual([])
  })

  test("falls back to the id when a set has no label", () => {
    const [projected] = tonightQueues(
      [set({ id: "unnamed" })],
      new Map(),
    )

    expect(projected?.name).toBe("unnamed")
  })

  test("carries the provider's product name for the card badge", () => {
    const [projected] = tonightQueues(
      [
        set({
          activity: "reading",
          id: "r",
          provider_kind: "kavita",
        }),
      ],
      new Map([["kavita", "Kavita"]]),
    )

    expect(projected?.providerLabel).toBe("Kavita")
    expect(projected?.activity).toBe("reading")
  })
})

describe("isProviderWorthNaming", () => {
  test("is false while one provider serves the activity", () => {
    expect(
      isProviderWorthNaming([
        queue({ id: "a", providerLabel: "Plex" }),
        queue({ id: "b", providerLabel: "Plex" }),
      ]),
    ).toBe(false)
  })

  test("is true once two do", () => {
    expect(
      isProviderWorthNaming([
        queue({ id: "a", providerLabel: "Plex" }),
        queue({ id: "b", providerLabel: "Kavita" }),
      ]),
    ).toBe(true)
  })
})

describe("goLabel", () => {
  test("counts guests as seats, because a guest is one", () => {
    expect(goLabel([], 0)).toBe("Go")
    expect(goLabel(["ada"], 0)).toBe("Go · 1 person")
    expect(goLabel(["ada"], 2)).toBe("Go · 3 people")
    expect(goLabel([], 1)).toBe("Go · 1 person")
  })
})

describe("rosterOrder", () => {
  test("is the stored order, never alphabetical", () => {
    expect(
      rosterOrder([
        { displayName: "Linus", id: "linus", position: 2 },
        { displayName: "Ada", id: "ada", position: 0 },
        { displayName: "Grace", id: "grace", position: 1 },
      ]).map((p) => p.displayName),
    ).toEqual(["Ada", "Grace", "Linus"])
  })
})

describe("the Surprise Me narrowing step", () => {
  /**
   * The groupings are COARSER than the tile row — "media" spans Movies, Shows and
   * YouTube in one entry — and the owner has not stated them yet. An empty list here is
   * the honest state, and this test is what stops somebody filling it in with a guess
   * that looks settled.
   */
  test("has no groupings yet, and they are not guessed", () => {
    expect(SURPRISE_SCOPES).toEqual([])
  })
})
