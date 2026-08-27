import { describe, expect, it } from "vitest"

import {
  byTray,
  candidates,
  describeRule,
  hueFor,
  initials,
  moveToTray,
  queueNumbers,
  queuePeopleLabel,
  queueTitle,
  trayOf,
} from "./people"
import type {
  GroupWithRoster,
  Person,
  QueueMember,
} from "./types"

/** The cast is Ada, Grace and Linus — new people fixtures are invented, never captured. */
const person = (
  id: string,
  displayName: string,
): Person => ({ displayName, id, position: 0 })

const people = [
  person("ada", "Ada"),
  person("grace", "Grace Hopper"),
  person("linus", "Linus"),
]

/** "At least one of Ada or Grace; Linus may join" — the Older Kids rule, invented cast. */
const kids: GroupWithRoster = {
  id: "kids",
  label: "Kids",
  minPresent: 1,
  roster: [
    { personId: "ada", position: 0, role: "required" },
    { personId: "grace", position: 1, role: "required" },
    { personId: "linus", position: 0, role: "optional" },
  ],
}

describe("a face is how you find somebody on a card", () => {
  it("takes two initials from two words and one from one", () => {
    expect(initials("Grace Hopper")).toBe("GH")
    expect(initials("Ada")).toBe("A")
    expect(initials("  ")).toBe("?")
  })

  it("derives the hue from the ID, so a rename never moves a colour", () => {
    expect(hueFor("ada")).toBe(hueFor("ada"))
    expect(hueFor("ada")).not.toBe(hueFor("grace"))
    for (const id of ["ada", "grace", "linus", "kids"]) {
      expect(hueFor(id)).toBeGreaterThanOrEqual(0)
      expect(hueFor(id)).toBeLessThan(360)
    }
  })
})

describe("the whole house is one pool of cards", () => {
  it("offers every person and every group side by side", () => {
    const all = candidates(people, [kids])
    expect(all.map((c) => c.id)).toEqual([
      "ada",
      "grace",
      "linus",
      "kids",
    ])
    expect(all.at(-1)).toMatchObject({
      kind: "group",
      size: 3,
    })
  })

  it("labels a group with its own rule, in words", () => {
    const nameOf = (id: string) =>
      people.find((p) => p.id === id)?.displayName ?? id
    expect(describeRule(kids, nameOf)).toBe(
      "At least one of Ada, Grace Hopper. Linus may join.",
    )
    expect(
      describeRule({ ...kids, minPresent: null }, nameOf),
    ).toBe("All of Ada, Grace Hopper. Linus may join.")
  })

  it('does not say "All of Ada" about a group of one', () => {
    // One person is not a quantity, and a group of one is most of them. It was on every card
    // in the roster tray before this.
    expect(
      describeRule(
        {
          id: "solo",
          label: "Solo",
          minPresent: null,
          roster: [
            {
              personId: "ada",
              position: 0,
              role: "required",
            },
          ],
        },
        (id) => id,
      ),
    ).toBe("ada")
  })
})

describe("three trays, and Everyone else is the absence of a row", () => {
  const members: QueueMember[] = [
    {
      id: "ada",
      kind: "person",
      position: 0,
      role: "required",
    },
    {
      id: "grace",
      kind: "person",
      position: 0,
      role: "optional",
    },
  ]

  it("puts anybody with no member row in Everyone else", () => {
    const all = candidates(people, [kids])
    expect(trayOf(all[0] as never, members)).toBe(
      "required",
    )
    expect(trayOf(all[1] as never, members)).toBe(
      "optional",
    )
    expect(trayOf(all[2] as never, members)).toBe("roster")
    expect(trayOf(all[3] as never, members)).toBe("roster")
  })

  it("splits the pool into the three lanes", () => {
    const lanes = byTray(
      candidates(people, [kids]),
      members,
    )
    expect(lanes.required.map((c) => c.id)).toEqual(["ada"])
    expect(lanes.optional.map((c) => c.id)).toEqual([
      "grace",
    ])
    expect(lanes.roster.map((c) => c.id)).toEqual([
      "linus",
      "kids",
    ])
  })

  it("tells a person and a group with the same id apart", () => {
    const twin: QueueMember[] = [
      {
        id: "kids",
        kind: "group",
        position: 0,
        role: "required",
      },
    ]
    const all = candidates(
      [person("kids", "Kids the person")],
      [kids],
    )
    expect(trayOf(all[0] as never, twin)).toBe("roster")
    expect(trayOf(all[1] as never, twin)).toBe("required")
  })
})

describe("moving a person is one action, and it is the whole list that is written", () => {
  const members: QueueMember[] = [
    {
      id: "ada",
      kind: "person",
      position: 0,
      role: "required",
    },
  ]

  it("adds somebody to a tray", () => {
    expect(
      moveToTray(
        members,
        { id: "grace", kind: "person" },
        "optional",
      ),
    ).toEqual([
      {
        id: "ada",
        kind: "person",
        position: 0,
        role: "required",
      },
      {
        id: "grace",
        kind: "person",
        position: 0,
        role: "optional",
      },
    ])
  })

  it("DROPS the row when somebody goes back to Everyone else", () => {
    // There is no third role — a person with no row is in Everyone else, which is what makes
    // "everybody out" expressible as an empty list.
    expect(
      moveToTray(
        members,
        { id: "ada", kind: "person" },
        "roster",
      ),
    ).toEqual([])
  })

  it("moves between the two trays without leaving a duplicate", () => {
    const moved = moveToTray(
      members,
      { id: "ada", kind: "person" },
      "optional",
    )
    expect(moved).toEqual([
      {
        id: "ada",
        kind: "person",
        position: 0,
        role: "optional",
      },
    ])
  })

  it("honours the drop index inside a tray, and renumbers per tray", () => {
    const three: QueueMember[] = [
      {
        id: "ada",
        kind: "person",
        position: 0,
        role: "required",
      },
      {
        id: "grace",
        kind: "person",
        position: 1,
        role: "required",
      },
      {
        id: "linus",
        kind: "person",
        position: 0,
        role: "optional",
      },
    ]
    const moved = moveToTray(
      three,
      { id: "linus", kind: "person" },
      "required",
      1,
    )
    expect(
      moved.map((m) => [m.id, m.role, m.position]),
    ).toEqual([
      ["ada", "required", 0],
      ["linus", "required", 1],
      ["grace", "required", 2],
    ])
  })

  it("keeps a group as a group when it moves", () => {
    const moved = moveToTray(
      [],
      { id: "kids", kind: "group" },
      "required",
    )
    expect(moved).toEqual([
      {
        id: "kids",
        kind: "group",
        position: 0,
        role: "required",
      },
    ])
  })
})

describe("a queue's name is optional, and the activity fills in", () => {
  it("calls a NAMELESS watching queue Movies & Shows", () => {
    expect(queueTitle({ activity: "watching" }, null)).toBe(
      "Movies & Shows",
    )
    expect(queueTitle({ activity: "reading" }, null)).toBe(
      "Reading",
    )
  })

  it("keeps a name somebody typed, verbatim", () => {
    // The case that made this a rule: the shelf printed "Reading" over the one Kavita queue
    // the owner had deliberately named.
    expect(
      queueTitle(
        {
          activity: "reading",
          has_explicit_label: true,
          label: "Manga & Webtoons",
        },
        null,
      ),
    ).toBe("Manga & Webtoons")
  })

  it("ignores `label` when no name was typed — it is the ID then", () => {
    // The server makes `label` printable by falling back to the id, so trusting it here
    // would put `movies_shows` on the card.
    expect(
      queueTitle(
        { activity: "watching", label: "movies_shows" },
        null,
      ),
    ).toBe("Movies & Shows")
  })

  it("never numbers a name somebody typed", () => {
    // Two queues called "Movies" are the owner's own doing and he can tell them apart. Two
    // called "Movies & Shows" are the app's, and numbering them is the app's job.
    expect(
      queueTitle(
        {
          activity: "watching",
          has_explicit_label: true,
          label: "Movies",
        },
        2,
      ),
    ).toBe("Movies")
  })

  it("numbers the second of two identical cards and not the first", () => {
    const numbers = queueNumbers(
      [
        {
          activity: "watching",
          id: "a",
          source: "queue" as const,
        },
        {
          activity: "watching",
          id: "b",
          source: "queue" as const,
        },
        {
          activity: "reading",
          id: "c",
          source: "queue" as const,
        },
      ],
      {
        a: [
          {
            id: "ada",
            kind: "person",
            position: 0,
            role: "required",
          },
        ],
        b: [
          {
            id: "ada",
            kind: "person",
            position: 0,
            role: "required",
          },
        ],
        c: [
          {
            id: "ada",
            kind: "person",
            position: 0,
            role: "required",
          },
        ],
      },
    )
    expect(numbers.get("a")).toBeNull()
    expect(numbers.get("b")).toBe(2)
    expect(numbers.get("c")).toBeNull()
    expect(
      queueTitle(
        { activity: "watching" },
        numbers.get("b") ?? null,
      ),
    ).toBe("Movies & Shows 2")
  })

  it("does not let a filtered POOL eat a curated queue's number", () => {
    // They are two different things on two different pages and never sit beside each other.
    // Before this, the landing fixture's first three curated Movies queues came out 3, 4, 5.
    const numbers = queueNumbers(
      [
        {
          activity: "watching",
          id: "pool",
          source: "rotation" as const,
        },
        {
          activity: "watching",
          id: "a",
          source: "queue" as const,
        },
      ],
      { a: [], pool: [] },
    )
    expect(numbers.get("pool")).toBeNull()
    expect(numbers.get("a")).toBeNull()
  })

  it("does not collide two queues with different people", () => {
    const numbers = queueNumbers(
      [
        {
          activity: "watching",
          id: "a",
          source: "queue" as const,
        },
        {
          activity: "watching",
          id: "b",
          source: "queue" as const,
        },
      ],
      {
        a: [
          {
            id: "ada",
            kind: "person",
            position: 0,
            role: "required",
          },
        ],
        b: [
          {
            id: "grace",
            kind: "person",
            position: 0,
            role: "required",
          },
        ],
      },
    )
    expect([...numbers.values()]).toEqual([null, null])
  })
})

describe("a dropdown row says who the queue is for, in words", () => {
  const member = (
    id: string,
    role: "required" | "optional" = "required",
  ): QueueMember => ({
    id,
    kind: id === "kids" ? "group" : "person",
    position: 0,
    role,
  })

  it("names the required members, a group by its own label", () => {
    expect(
      queuePeopleLabel(
        [member("ada"), member("kids")],
        people,
        [kids],
      ),
    ).toBe("Ada, Kids")
  })

  it("drops the nice-to-have tray — a line of text cannot say dashed", () => {
    expect(
      queuePeopleLabel(
        [member("ada"), member("linus", "optional")],
        people,
        [kids],
      ),
    ).toBe("Ada")
  })

  it("says Anybody rather than nothing, so a blank never reads as a failed load", () => {
    expect(queuePeopleLabel([], people, [kids])).toBe(
      "Anybody",
    )
    // Optional-only is the same fact: nobody HAS to be here.
    expect(
      queuePeopleLabel(
        [member("linus", "optional")],
        people,
        [kids],
      ),
    ).toBe("Anybody")
  })

  it("counts past three, so the chip cannot push the row into a wrap", () => {
    expect(
      queuePeopleLabel(
        [
          member("ada"),
          member("grace"),
          member("linus"),
          member("kids"),
          member("nobody"),
        ],
        people,
        [kids],
      ),
    ).toBe("Ada, Grace Hopper, Linus +2")
  })

  it("falls back to the id when the roster has not loaded yet", () => {
    expect(queuePeopleLabel([member("ada")], [], [])).toBe(
      "ada",
    )
  })
})
