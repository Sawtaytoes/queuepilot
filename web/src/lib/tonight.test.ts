import { describe, expect, test } from "vitest"
import {
  ACTIVITIES,
  ACTIVITY_FILTERS,
  defaultFilterValues,
  defaultModeFor,
  goLabel,
  isProviderWorthNaming,
  missingRequiredPeople,
  peopleMatch,
  queueMatchesPeople,
  queuesForTonight,
  resolveMembers,
  rosterOrder,
  SURPRISE_SCOPES,
  splitByMatch,
  type TonightMember,
  type TonightQueue,
  tonightQueues,
} from "./tonight"
import { tilesForQueueActivity } from "./tonightRouting"
import type {
  GroupWithRoster,
  QueueMember,
  RegistrySet,
} from "./types"

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
  members: [],
  name: "Movies",
  providerLabel: "",
  ...over,
})

/** One person on a queue. A person is only ever themself, and counts as one. */
const person = (
  id: string,
  role: "optional" | "required" = "required",
): TonightMember => ({
  id,
  kind: "person",
  label: id,
  minPresent: 1,
  people: [id],
  requiredPeople: [id],
  role,
})

/** A whole saved group, carrying its own count. NOT flattened to its people. */
const group = (
  id: string,
  people: readonly string[],
  minPresent: number,
  role: "optional" | "required" = "required",
): TonightMember => ({
  id,
  kind: "group",
  label: id,
  minPresent,
  people,
  requiredPeople: people,
  role,
})

/** A queue with people on it, which is what `hasRoster` means. */
const withPeople = (
  id: string,
  members: readonly TonightMember[],
  over: Partial<TonightQueue> = {},
): TonightQueue =>
  queue({ hasRoster: true, id, members, ...over })

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

describe("the Board Game Picker filter contract", () => {
  test("keeps interaction, playtime and categories in the Tonight form", () => {
    const filters = ACTIVITY_FILTERS["board-games"]

    expect(filters.map((filter) => filter.id)).toEqual([
      "fit",
      "knows",
      "interactionType",
      "maxPlaytime",
      "categories",
      "complexity",
    ])
    expect(
      filters
        .find((filter) => filter.id === "interactionType")
        ?.options.map((option) => option.value),
    ).toEqual([
      "any",
      "competitive",
      "cooperative",
      "semiCooperative",
      "team",
      "traitor",
      "solo",
    ])
    expect(
      filters
        .find((filter) => filter.id === "maxPlaytime")
        ?.options.map((option) => option.value),
    ).toEqual(["any", "30", "60", "90", "120"])
    expect(
      filters.find((filter) => filter.id === "categories")
        ?.control,
    ).toBe("multiPicker")
    expect(
      filters
        .find((filter) => filter.id === "complexity")
        ?.options.map((option) => option.value),
    ).toEqual(["any", "light", "medium", "heavy"])
    expect(
      filters.find((filter) => filter.id === "complexity")
        ?.control,
    ).toBe("picker")
  })

  test("opens those controls at their neutral values", () => {
    expect(
      defaultFilterValues("board-games"),
    ).toMatchObject({
      categories: "",
      complexity: "light",
      interactionType: "any",
      maxPlaytime: "any",
    })
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

  /**
   * The same rule stated the other way round, and the one that bites on the LIVE data:
   * several queues legitimately have nobody filed on them, and hiding those would make
   * them unreachable from this screen.
   */
  test("never hides a queue nobody is filed on", () => {
    const anybody = withPeople("anybody", [])

    expect(queueMatchesPeople(anybody, [])).toBe(true)
    expect(queueMatchesPeople(anybody, ["ada"])).toBe(true)
    expect(
      queueMatchesPeople(anybody, ["ada", "grace"]),
    ).toBe(true)
  })

  test("every selected person must be on the queue", () => {
    const adaOnly = withPeople("ada-movies", [
      person("ada"),
    ])

    expect(queueMatchesPeople(adaOnly, ["ada"])).toBe(true)
    // Grace is not on it, so ticking Grace hides it — the decision's own example.
    expect(
      queueMatchesPeople(adaOnly, ["ada", "grace"]),
    ).toBe(false)
  })

  test("every required person must be selected", () => {
    const both = withPeople("ada-grace", [
      person("ada"),
      person("grace"),
    ])

    expect(queueMatchesPeople(both, ["ada"])).toBe(false)
    expect(queueMatchesPeople(both, ["ada", "grace"])).toBe(
      true,
    )
    // Nobody ticked is the unfiltered list, not the empty one — a filter with nothing in
    // it matches everything, and the strict reading of the rule gets this backwards.
    expect(queueMatchesPeople(both, [])).toBe(true)
  })

  test("an optional person is the hatch — being there does not remove the queue", () => {
    const withGuest = withPeople("ada-plus", [
      person("ada"),
      person("linus", "optional"),
    ])

    expect(
      queueMatchesPeople(withGuest, ["ada", "linus"]),
    ).toBe(true)
    // …but an optional person is not a required one.
    expect(queueMatchesPeople(withGuest, ["ada"])).toBe(
      true,
    )
  })

  /**
   * ⚠️ THE GROUP RULE, and the reason a group may not be flattened into its people.
   *
   * "Younger Kids" is at least ONE of three. Flattened into three person ids it becomes
   * "all three of them", which is the rule inverted — and the queue would then never come
   * up, because the kids are hardly ever all in one room.
   */
  test("a group counts by its own number, not by all of its people", () => {
    const kids = withPeople("kids-movies", [
      group("younger-kids", ["ada", "grace", "linus"], 1),
    ])

    expect(queueMatchesPeople(kids, ["ada"])).toBe(true)
    expect(queueMatchesPeople(kids, ["grace"])).toBe(true)
    expect(queueMatchesPeople(kids, ["ada", "grace"])).toBe(
      true,
    )

    // …and "at least two of them" is a different answer to the same selection.
    const pair = withPeople("kids-pair", [
      group("younger-kids", ["ada", "grace", "linus"], 2),
    ])

    expect(queueMatchesPeople(pair, ["ada"])).toBe(false)
    expect(queueMatchesPeople(pair, ["ada", "grace"])).toBe(
      true,
    )
  })

  test("an all-optional group matches people in its roster", () => {
    const olderKids = withPeople("older-kids-movies", [
      {
        id: "older-kids",
        kind: "group",
        label: "Older Kids",
        minPresent: 0,
        people: ["ada", "grace"],
        requiredPeople: [],
        role: "required",
      },
    ])

    expect(queueMatchesPeople(olderKids, ["ada"])).toBe(
      true,
    )
    expect(queueMatchesPeople(olderKids, ["grace"])).toBe(
      true,
    )
    expect(
      queueMatchesPeople(olderKids, ["ada", "grace"]),
    ).toBe(true)
    expect(queueMatchesPeople(olderKids, ["linus"])).toBe(
      false,
    )
  })

  test("a person beside a group has to be there as well", () => {
    const family = withPeople("family-movies", [
      person("ada"),
      group("kids", ["grace", "linus"], 1),
    ])

    expect(
      queueMatchesPeople(family, ["ada", "grace"]),
    ).toBe(true)
    // Ada is required and is not ticked, so the group being satisfied is not enough.
    expect(queueMatchesPeople(family, ["grace"])).toBe(
      false,
    )
    // …and somebody the queue never names still hides it.
    expect(
      queueMatchesPeople(family, ["ada", "grace", "zoe"]),
    ).toBe(false)
  })
})

describe("the two tiers — exact, then also-in", () => {
  /**
   * The filter answers `exact` / `also` / `none` since 2026-09-05, and the reason is a
   * filter you had to already know the answer to:
   *
   * > "selecting 'Xander' or 'Darius' without selecting both will show the Halloween queue.
   * > It removes the need to 'know' everyone who's required to be in a queue."
   *
   * `queueMatchesPeople` is `exact` and NOTHING ELSE — the server picks on that rule and it
   * did not move. What changed is that the queues it drops are now reported rather than
   * discarded.
   */
  const tier = (
    members: readonly TonightMember[],
    selected: readonly string[],
  ) => peopleMatch(members, selected).tier

  test("EXACT is the old rule, unchanged", () => {
    const both = [person("ada"), person("grace")]

    expect(tier(both, ["ada", "grace"])).toBe("exact")
    // Both empties still answer `exact`, never `also`: an unfiltered page must draw one
    // list, not a list and a rule with everything under it.
    expect(tier(both, [])).toBe("exact")
    expect(tier([], ["ada"])).toBe("exact")
  })

  test("ALSO is a queue that wants somebody you did not tick", () => {
    // THE HALLOWEEN CASE. One of the two children the queue needs, and the queue used to
    // vanish rather than say so.
    const halloween = [person("grace"), person("linus")]

    expect(tier(halloween, ["grace"])).toBe("also")
    expect(tier(halloween, ["linus"])).toBe("also")
    expect(tier(halloween, ["grace", "linus"])).toBe(
      "exact",
    )
  })

  test("ALSO is what stops a person reading as having no queue", () => {
    // The other half of the report: somebody who never has a queue to herself.
    const shared = [person("ada"), person("sven")]

    expect(tier(shared, ["sven"])).toBe("also")
  })

  test("NONE still means the ticked people are not all on it", () => {
    // The one thing `also` does NOT relax. Ticking two people who share no queue keeps
    // answering with nothing, which is true and useful.
    const adaOnly = [person("ada")]

    expect(tier(adaOnly, ["grace"])).toBe("none")
    expect(tier(adaOnly, ["ada", "grace"])).toBe("none")
  })

  test("an OPTIONAL person never makes a queue also-in", () => {
    // "Nice to have" is the hatch it always was: somebody there does not remove the queue,
    // and somebody absent does not make it a near miss either.
    const adaMaybeGrace = [
      person("ada"),
      person("grace", "optional"),
    ]

    expect(tier(adaMaybeGrace, ["ada"])).toBe("exact")
    expect(tier(adaMaybeGrace, ["ada", "grace"])).toBe(
      "exact",
    )
  })

  test("a GROUP is short by its COUNT, not by one", () => {
    // "At least two of these four" with nobody ticked is further away than "at least one",
    // and that distance is what orders the also-in list.
    const twoOfFour = [
      group("kids", ["grace", "linus", "hedy", "alan"], 2),
    ]

    expect(
      peopleMatch(twoOfFour, ["grace"]).missingRequired,
    ).toBe(1)
    expect(
      peopleMatch(
        [group("kids", ["grace", "linus"], 1)],
        [],
      ).missingRequired,
    ).toBe(0)
  })
})

describe("splitByMatch", () => {
  test("keeps the caller's order inside EXACT", () => {
    const split = splitByMatch(
      ["a", "b", "c"],
      () =>
        ({ missingRequired: 0, tier: "exact" }) as const,
    )

    expect(split.exact).toEqual(["a", "b", "c"])
    expect(split.also).toEqual([])
  })

  test("drops NONE and sorts ALSO by how far off it is", () => {
    const distance: Record<string, number> = {
      far: 4,
      near: 1,
      "near-too": 1,
    }
    const split = splitByMatch(
      ["far", "hidden", "near", "keep", "near-too"],
      (id) =>
        id === "hidden"
          ? ({ missingRequired: 0, tier: "none" } as const)
          : id === "keep"
            ? ({
                missingRequired: 0,
                tier: "exact",
              } as const)
            : ({
                missingRequired: distance[id] ?? 0,
                tier: "also",
              } as const),
    )

    expect(split.exact).toEqual(["keep"])
    // Nearest first, and STABLE — `near` was ahead of `near-too` in the caller's order and
    // stays there. That order is the file's, which is the order the owner arranged.
    expect(split.also).toEqual(["near", "near-too", "far"])
  })
})

describe("missingRequiredPeople", () => {
  test("names everybody required and not ticked", () => {
    expect(
      missingRequiredPeople(
        [person("ada"), person("sven")],
        ["sven"],
      ),
    ).toEqual(["ada"])
  })

  test("a GROUP contributes its whole required roster", () => {
    // Looser than the rule the tier was computed with, deliberately: "at least one of Grace
    // or Linus" wants EITHER, and the divider's job is to say which two to consider.
    expect(
      missingRequiredPeople(
        [group("kids", ["grace", "linus"], 1)],
        [],
      ),
    ).toEqual(["grace", "linus"])
  })

  test("says nothing about a satisfied member, or an optional one", () => {
    expect(
      missingRequiredPeople(
        [
          person("ada"),
          person("grace", "optional"),
          group("kids", ["linus", "hedy"], 1),
        ],
        ["ada", "linus"],
      ),
    ).toEqual([])
  })
})

describe("resolveMembers", () => {
  const people = [
    { displayName: "Ada", id: "ada", position: 0 },
    { displayName: "Grace", id: "grace", position: 1 },
    { displayName: "Linus", id: "linus", position: 2 },
  ]
  const groups: GroupWithRoster[] = [
    {
      id: "kids",
      label: "Kids",
      minPresent: 1,
      roster: [
        { personId: "ada", position: 0, role: "required" },
        {
          personId: "grace",
          position: 1,
          role: "required",
        },
        {
          personId: "linus",
          position: 2,
          role: "optional",
        },
      ],
    },
    {
      id: "all-of-them",
      label: "All Of Them",
      minPresent: null,
      roster: [
        { personId: "ada", position: 0, role: "required" },
        {
          personId: "grace",
          position: 1,
          role: "required",
        },
      ],
    },
  ]

  const member = (
    kind: "group" | "person",
    id: string,
  ): QueueMember => ({
    id,
    kind,
    position: 0,
    role: "required",
  })

  test("a person is themself, and counts as one", () => {
    expect(
      resolveMembers(
        [member("person", "ada")],
        people,
        groups,
      ),
    ).toEqual([
      {
        id: "ada",
        kind: "person",
        label: "Ada",
        minPresent: 1,
        people: ["ada"],
        requiredPeople: ["ada"],
        role: "required",
      },
    ])
  })

  test("a group carries its full roster and its required count", () => {
    const [resolved] = resolveMembers(
      [member("group", "kids")],
      people,
      groups,
    )

    expect(resolved?.label).toBe("Kids")
    expect(resolved?.minPresent).toBe(1)
    expect(resolved?.people).toEqual([
      "ada",
      "grace",
      "linus",
    ])
    expect(resolved?.requiredPeople).toEqual([
      "ada",
      "grace",
    ])
  })

  test("an all-optional group has a usable people filter", () => {
    const [resolved] = resolveMembers(
      [member("group", "older-kids")],
      people,
      [
        ...groups,
        {
          id: "older-kids",
          label: "Older Kids",
          minPresent: null,
          roster: [
            {
              personId: "grace",
              position: 0,
              role: "optional",
            },
            {
              personId: "linus",
              position: 1,
              role: "optional",
            },
          ],
        },
      ],
    )

    expect(resolved).toMatchObject({
      minPresent: 0,
      people: ["grace", "linus"],
      requiredPeople: [],
    })

    const queueWithGroup = withPeople("older-kids", [
      resolved!,
    ])
    expect(
      queueMatchesPeople(queueWithGroup, ["grace"]),
    ).toBe(true)
    expect(
      queueMatchesPeople(queueWithGroup, ["linus"]),
    ).toBe(true)
    expect(
      queueMatchesPeople(queueWithGroup, ["ada"]),
    ).toBe(false)
  })

  test("no number means ALL of them, never one", () => {
    const [resolved] = resolveMembers(
      [member("group", "all-of-them")],
      people,
      groups,
    )

    expect(resolved?.minPresent).toBe(2)
    expect(resolved?.requiredPeople).toEqual([
      "ada",
      "grace",
    ])
  })

  /**
   * The safe direction, and the server's. A queue that should have been offered and was
   * not is visible on the screen; a queue offered to people it is not for is not.
   */
  test("a group nothing knows about takes the queue out of the list", () => {
    const ghost = queue({
      hasRoster: true,
      id: "ghost",
      members: resolveMembers(
        [member("group", "gone")],
        people,
        groups,
      ),
    })

    expect(queueMatchesPeople(ghost, ["ada"])).toBe(false)
    // …but nobody ticked is still no filter at all.
    expect(queueMatchesPeople(ghost, [])).toBe(true)
  })
})

describe("queuesForTonight", () => {
  const all = [
    withPeople("movies-1", [person("ada")], {
      activity: "movies",
    }),
    withPeople(
      "shows-1",
      [person("ada"), person("grace", "optional")],
      { activity: "shows" },
    ),
    withPeople("reading-1", [person("linus")], {
      activity: "reading",
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

  test("reports a queue nobody is filed on as rosterless, so it is never filtered", () => {
    const [projected] = tonightQueues(
      [set({ id: "a", label: "A" })],
      new Map(),
    )

    expect(projected?.hasRoster).toBe(false)
    expect(projected?.members).toEqual([])
  })

  test("carries the queue's own trays, people and groups alike", () => {
    const [projected] = tonightQueues(
      [set({ id: "a", label: "A" })],
      new Map(),
      {
        a: [
          {
            id: "ada",
            kind: "person",
            position: 0,
            role: "required",
          },
          {
            id: "kids",
            kind: "group",
            position: 1,
            role: "required",
          },
        ],
      },
      [{ displayName: "Ada", id: "ada", position: 0 }],
      [
        {
          id: "kids",
          label: "Kids",
          minPresent: 1,
          roster: [
            {
              personId: "grace",
              position: 0,
              role: "required",
            },
            {
              personId: "linus",
              position: 1,
              role: "required",
            },
          ],
        },
      ],
    )

    expect(projected?.hasRoster).toBe(true)
    expect(projected?.members.map((m) => m.label)).toEqual([
      "Ada",
      "Kids",
    ])
    // The group is ONE member with a count, never two people.
    expect(projected?.members[1]?.minPresent).toBe(1)
    expect(projected?.members[1]?.people).toEqual([
      "grace",
      "linus",
    ])
  })

  test("a set with no name reads its ACTIVITY, never its id", () => {
    // It fell back to the id until 2026-08-26, which put a slug on the card. A name is
    // optional now and the activity is what fills in
    // (decision `2026-08-26-a-queue-name-is-optional-and-the-activity-fills-in`).
    const [projected] = tonightQueues(
      [set({ id: "unnamed" })],
      new Map(),
    )

    expect(projected?.name).toBe("Movies & Shows")
  })

  test("…and keeps a name somebody typed", () => {
    const [projected] = tonightQueues(
      [
        set({
          has_explicit_label: true,
          id: "manga_webtoons",
          label: "Manga & Webtoons",
        }),
      ],
      new Map(),
    )

    expect(projected?.name).toBe("Manga & Webtoons")
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
  test("uses the three approved groupings, coarser than the activity row", () => {
    expect(SURPRISE_SCOPES).toEqual([
      {
        activities: ["movies", "shows"],
        hint: "Movies, shows and YouTube when it arrives",
        id: "media",
        label: "Media",
      },
      {
        activities: ["video-games", "board-games"],
        hint: "Video games and board games",
        id: "games",
        label: "Games",
      },
      {
        activities: ["reading"],
        hint: "Comics, manga and books",
        id: "reading",
        label: "Reading",
      },
    ])
  })
})
