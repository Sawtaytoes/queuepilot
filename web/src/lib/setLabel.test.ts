import { describe, expect, test } from "vitest"

import { accountInGroup, labelInGroup } from "./setLabel"

/**
 * The rule that lets `Bob & Alice — Anime` render as `Anime` inside Bob & Alice.
 * Pinned because it is a STRING rule over labels a person types, and the failure mode is
 * silent: a near-miss just leaves the long label, which looks like the feature never shipped.
 */
describe("labelInGroup", () => {
  test("strips the group's own name and its separator", () => {
    expect(
      labelInGroup("Bob & Alice — Anime", "Bob & Alice"),
    ).toBe("Anime")
    expect(labelInGroup("Family — Movies", "Family")).toBe(
      "Movies",
    )
  })

  test("leaves the label alone with no group in context", () => {
    expect(labelInGroup("Bob — Anime", null)).toBe(
      "Bob — Anime",
    )
  })

  test("leaves a label whose prefix is somebody else", () => {
    expect(labelInGroup("Bob & Dave — Movies", "Bob")).toBe(
      "Bob & Dave — Movies",
    )
    // The trap this exists for: "Bob" IS a prefix of "Bob & Dave" as a substring,
    // so a startsWith() implementation would strip it to "& Dave — Movies".
    expect(labelInGroup("Bob & Carol — Anime", "Bob")).toBe(
      "Bob & Carol — Anime",
    )
  })

  test("leaves a label with no separator at all", () => {
    expect(labelInGroup("Manga & Webtoons", "Bob")).toBe(
      "Manga & Webtoons",
    )
    expect(labelInGroup("Shows & Shorts", "Kids")).toBe(
      "Shows & Shorts",
    )
  })

  test("matches case-insensitively, like a person reading it", () => {
    expect(labelInGroup("BOB — Anime", "Bob")).toBe("Anime")
  })

  test("accepts a hyphen or en dash, not just an em dash", () => {
    expect(labelInGroup("Bob - Movies", "Bob")).toBe(
      "Movies",
    )
    expect(labelInGroup("Bob – Movies", "Bob")).toBe(
      "Movies",
    )
  })

  test("never returns an empty name", () => {
    expect(labelInGroup("Bob — ", "Bob")).toBe("Bob — ")
  })

  test("does not strip a bare match with no separator", () => {
    // A queue literally called "Bob" inside the Bob group keeps its name rather than
    // becoming blank.
    expect(labelInGroup("Bob", "Bob")).toBe("Bob")
  })
})

/**
 * The meta-line twin. Same failure mode as `labelInGroup`: a near-miss silently leaves the
 * redundant name, which reads as the feature never shipping.
 */
describe("accountInGroup", () => {
  test("drops the account while inside that account's own group", () => {
    expect(
      accountInGroup("Younger Kids", "Younger Kids"),
    ).toBeNull()
  })

  test("keeps the account on the All view", () => {
    expect(accountInGroup("Younger Kids", null)).toBe(
      "Younger Kids",
    )
  })

  test("keeps an account that is not the group", () => {
    // The case the exact match exists for: a group holding pools bound to two different
    // accounts must still name the one that is not the group, because that IS the
    // distinction between those two cards.
    expect(
      accountInGroup("Older Kids", "Younger Kids"),
    ).toBe("Older Kids")
    // A substring is not a match, exactly as in labelInGroup.
    expect(accountInGroup("Younger Kids", "Younger")).toBe(
      "Younger Kids",
    )
  })

  test("ignores case and surrounding space, as a person would", () => {
    expect(
      accountInGroup(" younger kids ", "Younger Kids"),
    ).toBeNull()
  })

  test("a pool with no bound account says nothing", () => {
    expect(accountInGroup(null, "Younger Kids")).toBeNull()
    expect(accountInGroup("", null)).toBeNull()
  })
})
