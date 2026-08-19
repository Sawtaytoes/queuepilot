import { describe, expect, test } from "vitest"

import {
  ALL_ID,
  findGroup,
  groupPath,
  onlyPath,
} from "./group"

/**
 * The rule these hold: **the URL wins; storage only answers a URL that did not say.**
 *
 * The bug that made this file exist (reported 2026-08-19): "All" was spelled bare `/`, which
 * is precisely the URL that did not say — so `App.tsx` answered it from storage and bounced
 * every tap on the All chip back to the remembered group. The chip looked dead. All has its
 * own address now, and these tests pin the two halves of that: the chip's href says `all`,
 * and resolving `all` still means "no filter".
 * (decision `2026-08-19-all-is-an-address-not-the-absence-of-one`)
 */

const groups = {
  groups: [
    {
      accounts: {},
      id: ALL_ID,
      isAll: true,
      label: "All",
      providerKinds: [],
      setIds: [],
      sets: [],
    },
    {
      accounts: {},
      id: "bob",
      label: "Bob",
      providerKinds: [],
      setIds: [],
      sets: [],
    },
  ],
  unassigned: [],
}

describe("groupPath", () => {
  test("the everything view is an address, not bare /", () => {
    // Bare `/` is what the remembered-group redirect treats as "unspecified", so an All chip
    // pointing at it can never win against a stored group.
    expect(groupPath({ id: ALL_ID, isAll: true })).toBe(
      "/g/all",
    )
  })

  test("a named group is /g/<id>, encoded", () => {
    expect(groupPath({ id: "bob" })).toBe("/g/bob")
    expect(groupPath({ id: "bob & alice" })).toBe(
      "/g/bob%20%26%20alice",
    )
  })
})

describe("findGroup", () => {
  test("`all` resolves to no group, which is what shows everything", () => {
    // Not a lookup failure: the everything view IS the absence of a filter, so `/g/all` and
    // `/` render the same page. PlayView keys off exactly this null.
    expect(findGroup(groups, ALL_ID)).toBeNull()
  })

  test("a real id resolves to its group", () => {
    expect(findGroup(groups, "bob")?.label).toBe("Bob")
  })

  test("a deleted group falls back to everything rather than an empty page", () => {
    expect(findGroup(groups, "gone")).toBeNull()
  })
})

describe("onlyPath", () => {
  test("a provider chip hangs off whatever page it is on, including /g/all", () => {
    // If this returned to bare `/` the provider chips would reproduce the All-chip bug one
    // control over: tapping Plex on the everything view would bounce into a stored group.
    expect(onlyPath("/g/all", "plex")).toBe(
      "/g/all?only=plex",
    )
    expect(onlyPath("/g/all", null)).toBe("/g/all")
  })
})
