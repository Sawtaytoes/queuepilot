import { describe, expect, test } from "vitest"

import type { QueueItem } from "../lib/types"
import { hasOverrides } from "./queueView"

const item = (over: Partial<QueueItem>): QueueItem => ({
  childCount: null,
  done: false,
  episodes: null,
  key: "rk:1",
  nextEp: null,
  ratingKey: "1",
  resolved: true,
  start: null,
  title: "Untitled",
  type: "show",
  weight: 1,
  year: null,
  ...over,
})

describe("hasOverrides", () => {
  test("a tile that follows the set is not an override, even when the set default is 2", () => {
    expect(hasOverrides(item({ episodes: null }))).toBe(
      false,
    )
    expect(hasOverrides(item({}))).toBe(false)
  })

  test("a stored 1 is an override — the set default may not be 1", () => {
    expect(hasOverrides(item({ episodes: 1 }))).toBe(true)
  })

  test("weight / start / batch-stop still count", () => {
    expect(hasOverrides(item({ weight: 3 }))).toBe(true)
    expect(
      hasOverrides(item({ start: { episode: 4 } })),
    ).toBe(true)
    expect(
      hasOverrides(item({ batch_stops_at: "season" })),
    ).toBe(true)
  })

  test("a stored volume count is an override the same way", () => {
    expect(hasOverrides(item({ volumes: 2 }))).toBe(true)
    expect(hasOverrides(item({ volumes: null }))).toBe(
      false,
    )
  })
})
