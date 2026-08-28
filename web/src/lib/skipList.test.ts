import { describe, expect, test } from "vitest"

import {
  isSkipListChanged,
  mergeIncludedSpecials,
  mergeSkipped,
} from "./skipList"

describe("mergeSkipped", () => {
  // The claim this whole module exists for: `skipped` is per SET, so a panel that edits ONE
  // entry must leave every other entry's keys exactly where they were.
  test("another entry's skips survive a save", () => {
    expect(
      mergeSkipped({
        current: ["900", "901"],
        managed: ["100", "200", "300"],
        skipped: ["200"],
      }),
    ).toEqual(["900", "901", "200"])
  })

  test("unticking restores — a managed key that is no longer skipped is dropped", () => {
    expect(
      mergeSkipped({
        current: ["900", "100", "200"],
        managed: ["100", "200", "300"],
        skipped: ["200"],
      }),
    ).toEqual(["900", "200"])
  })

  test("skipping every member is allowed — the entry is then finished, not broken", () => {
    expect(
      mergeSkipped({
        current: [],
        managed: ["100", "200"],
        skipped: ["100", "200"],
      }),
    ).toEqual(["100", "200"])
  })

  // A skip the panel cannot see is not a skip it may drop: a collection member list does not
  // know the episode keys inside a member show, and those keys are not `managed`.
  test("a skipped key outside the panel is neither dropped nor duplicated", () => {
    expect(
      mergeSkipped({
        current: ["410001"],
        managed: ["410000", "420000"],
        skipped: ["420000"],
      }),
    ).toEqual(["410001", "420000"])
  })

  test("a key skipped twice is written once", () => {
    expect(
      mergeSkipped({
        current: ["100"],
        managed: ["100", "100"],
        skipped: ["100"],
      }),
    ).toEqual(["100"])
  })
})

describe("mergeIncludedSpecials", () => {
  test("one show's choices do not replace another show's included specials", () => {
    expect(
      mergeIncludedSpecials({
        current: ["other-show", "old-choice"],
        included: ["new-choice"],
        managed: ["old-choice", "new-choice"],
      }),
    ).toEqual(["other-show", "new-choice"])
  })
})

describe("isSkipListChanged", () => {
  test("the same keys in a different order is not a change", () => {
    expect(isSkipListChanged(["a", "b"], ["b", "a"])).toBe(
      false,
    )
  })

  test("an added or removed key is", () => {
    expect(isSkipListChanged(["a"], ["a", "b"])).toBe(true)
    expect(isSkipListChanged(["a", "b"], ["a"])).toBe(true)
    expect(isSkipListChanged(["a"], ["b"])).toBe(true)
  })
})
