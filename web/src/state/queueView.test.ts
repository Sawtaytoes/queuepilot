import { describe, expect, test } from "vitest"

import type { QueueItem } from "../lib/types"
import { applyFilters, hasOverrides } from "./queueView"

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

  test("a promote is an override — the entry says something its queue did not", () => {
    expect(
      hasOverrides(item({ placement: "priority" })),
    ).toBe(true)
    // A DEMOTE is one too: on an ordered queue, `random` is the entry disagreeing with
    // every other entry in the file.
    expect(
      hasOverrides(item({ placement: "random" })),
    ).toBe(true)
    // Inherited is not. Every entry of an ordered queue is in the Priority lane, and none
    // of them is an override.
    expect(hasOverrides(item({ placement: null }))).toBe(
      false,
    )
  })

  test("a stored volume count is an override the same way", () => {
    expect(hasOverrides(item({ volumes: 2 }))).toBe(true)
    expect(hasOverrides(item({ volumes: null }))).toBe(
      false,
    )
  })
})

describe("applyFilters — the Priority lane", () => {
  const base = {
    sort: "queue" as const,
    text: "",
    type: "" as const,
  }
  const items = [
    item({
      key: "rk:1",
      title: "Promoted",
      placement: "priority",
    }),
    item({ key: "rk:2", title: "Inherited" }),
    item({
      key: "rk:3",
      title: "Demoted",
      placement: "random",
    }),
  ]

  test("matches what was PROMOTED, not what the queue defaults to", () => {
    // The queue this list belongs to may well be `add_as: priority`, which makes "Inherited"
    // a Priority entry at playback. It is still not what the filter is for: an ordered queue
    // would match every row and answer nothing.
    expect(
      applyFilters(items, {
        ...base,
        state: "priority",
      }).map((it) => it.title),
    ).toEqual(["Promoted"])
  })

  test("an empty state filter keeps every row", () => {
    expect(
      applyFilters(items, { ...base, state: "" }),
    ).toHaveLength(3)
  })
})
