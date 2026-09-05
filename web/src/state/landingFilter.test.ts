import { describe, expect, test } from "vitest"

import {
  filterPath,
  parsePeople,
  parseProviders,
  toggleValue,
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

describe("parseProviders", () => {
  test("a comma list, or empty for everything", () => {
    expect(parseProviders("?only=kavita,plex")).toEqual([
      "kavita",
      "plex",
    ])
    expect(parseProviders("")).toEqual([])
  })

  test("EVERY ADDRESS THE SINGLE-SELECT ERA WROTE still parses", () => {
    // The filter was one kind at a time until 2026-09-05, and those URLs are bookmarks,
    // home-screen tiles and NFC targets. A lone kind is a one-item list.
    expect(parseProviders("?only=kavita")).toEqual([
      "kavita",
    ])
    // `all` was that era's spelling of "no filter" and still means it, so the unfiltered
    // page stays ONE address rather than two.
    expect(parseProviders("?only=all")).toEqual([])
    expect(parseProviders("?only=all,kavita")).toEqual([
      "kavita",
    ])
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
      filterPath("/", "?people=ada", { only: ["plex"] }),
    ).toBe("/?people=ada&only=plex")
  })

  test("an omitted key means UNCHANGED, and an empty list means cleared", () => {
    expect(
      filterPath("/", "?people=ada&only=plex", {}),
    ).toBe("/?people=ada&only=plex")
    expect(
      filterPath("/", "?people=ada&only=plex", {
        only: [],
      }),
    ).toBe("/?people=ada")
    expect(
      filterPath("/", "?people=ada&only=plex", {
        people: [],
      }),
    ).toBe("/?only=plex")
  })
})

describe("toggleValue", () => {
  test("adds at the end, and removes in place", () => {
    expect(toggleValue(["ada"], "grace")).toEqual([
      "ada",
      "grace",
    ])
    expect(toggleValue(["ada", "grace"], "ada")).toEqual([
      "grace",
    ])
  })

  test("never mutates the selection it was given", () => {
    const selected = ["ada"]
    toggleValue(selected, "grace")
    expect(selected).toEqual(["ada"])
  })

  test("the SAME function drives both filters", () => {
    // The provider row became multi-select on 2026-09-05 and does exactly this to its own
    // list. Two copies would be two places for the de-duplication to drift.
    expect(toggleValue(["plex"], "kavita")).toEqual([
      "plex",
      "kavita",
    ])
  })
})
