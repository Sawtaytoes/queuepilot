import { describe, expect, test } from "vitest"

import {
  filterPath,
  parseOnly,
  parsePeople,
  togglePerson,
} from "./landingFilter"

/**
 * The landing's two filters, as URLs.
 *
 * These are pure string functions and they are worth a test for one reason: every chip on the
 * bar is a real `<a href>`, so a wrong answer here is not a wrong render — it is a wrong
 * ADDRESS, which survives a bookmark, a share and the back button. The failure this pins is
 * the boring one that keeps happening in filter bars: changing one filter silently drops the
 * other.
 */

describe("parsePeople", () => {
  test("no parameter is nobody, which is NO FILTER", () => {
    expect(parsePeople("")).toEqual([])
    expect(parsePeople("?only=plex")).toEqual([])
    // An empty value is the same as an absent one, not a person called "".
    expect(parsePeople("?people=")).toEqual([])
  })

  test("a comma list, in the order the URL gives it", () => {
    expect(parsePeople("?people=ada,grace")).toEqual([
      "ada",
      "grace",
    ])
  })

  test("blanks and repeats are dropped, first spelling wins", () => {
    // Hand-edited URLs and a double-tap on a chip both produce these.
    expect(
      parsePeople("?people=ada,,grace, ada ,linus"),
    ).toEqual(["ada", "grace", "linus"])
  })
})

describe("parseOnly", () => {
  test("a kind, or null for everything", () => {
    expect(parseOnly("?only=kavita")).toBe("kavita")
    expect(parseOnly("")).toBeNull()
  })

  test("`all` is spelled as the ABSENCE of the parameter", () => {
    // So the All chip and a URL that never mentioned a provider are one address, not two.
    expect(parseOnly("?only=all")).toBeNull()
  })
})

describe("filterPath", () => {
  test("no filters is the bare path, with no dangling ?", () => {
    expect(filterPath("/", "", { people: [] })).toBe("/")
  })

  test("each filter keeps the other", () => {
    // THE FAILURE THIS EXISTS FOR. Ticking a second person must not drop the Kavita chip,
    // and switching provider must not clear who you were looking for.
    expect(
      filterPath("/", "?only=kavita", {
        people: ["ada", "grace"],
      }),
    ).toBe("/?people=ada%2Cgrace&only=kavita")
    expect(
      filterPath("/", "?people=ada", { only: "plex" }),
    ).toBe("/?people=ada&only=plex")
  })

  test("an omitted key means UNCHANGED, and null means cleared", () => {
    expect(
      filterPath("/", "?people=ada&only=plex", {}),
    ).toBe("/?people=ada&only=plex")
    expect(
      filterPath("/", "?people=ada&only=plex", {
        only: null,
      }),
    ).toBe("/?people=ada")
    expect(
      filterPath("/", "?people=ada&only=plex", {
        people: [],
      }),
    ).toBe("/?only=plex")
  })
})

describe("togglePerson", () => {
  test("adds at the end, and removes in place", () => {
    expect(togglePerson(["ada"], "grace")).toEqual([
      "ada",
      "grace",
    ])
    expect(togglePerson(["ada", "grace"], "ada")).toEqual([
      "grace",
    ])
  })

  test("never mutates the selection it was given", () => {
    const selected = ["ada"]
    togglePerson(selected, "grace")
    expect(selected).toEqual(["ada"])
  })
})
