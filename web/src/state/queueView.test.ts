import { describe, expect, test } from "vitest"

import type { QueueItem } from "../lib/types"
import {
  applyFilters,
  hasOverrides,
  promotedOrder,
  splitLanes,
} from "./queueView"

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

describe("splitLanes", () => {
  const items = [
    item({ key: "rk:1", title: "Bravo" }),
    item({ key: "rk:2", title: "Alpha" }),
    item({
      key: "rk:3",
      title: "Charlie",
      placement: "priority",
    }),
    item({
      key: "rk:4",
      title: "Delta",
      placement: "random",
    }),
  ]

  test("an ordered queue puts everything in Priority except what was demoted", () => {
    const { priority, random } = splitLanes(
      items,
      "priority",
    )

    // FILE order in the Priority lane — that is what the engine plays, so what you drag is
    // literally what happens.
    expect(priority.map((it) => it.title)).toEqual([
      "Bravo",
      "Alpha",
      "Charlie",
    ])
    expect(random.map((it) => it.title)).toEqual(["Delta"])
  })

  test("a pool queue puts everything in the pool except what was promoted", () => {
    const { priority, random } = splitLanes(items, "random")

    expect(priority.map((it) => it.title)).toEqual([
      "Charlie",
    ])
    // ALPHABETICAL in the pool. Its order changes nothing at playback — the pool is
    // shuffled — so the lane is sorted for lookup instead.
    expect(random.map((it) => it.title)).toEqual([
      "Alpha",
      "Bravo",
      "Delta",
    ])
  })

  test("a queue nobody has promoted anything in is entirely one lane", () => {
    const plain = [
      item({ key: "rk:1" }),
      item({ key: "rk:2" }),
    ]

    expect(splitLanes(plain, "priority").random).toEqual([])
    expect(splitLanes(plain, "random").priority).toEqual([])
  })
})

describe("promotedOrder", () => {
  const items = [
    item({ key: "rk:1", placement: "priority" }),
    item({ key: "rk:2", placement: "priority" }),
    item({ key: "rk:3" }),
    item({ key: "rk:4" }),
  ]

  // The claim the whole helper exists for: a button cannot say WHERE, so it must not pick
  // the head — the Priority lane plays in file order, and landing first would silently
  // change what plays next.
  test("a promoted entry lands at the END of the Priority lane", () => {
    expect(promotedOrder(items, "rk:4", "random")).toEqual([
      "rk:1",
      "rk:2",
      "rk:4",
      "rk:3",
    ])
  })

  test("the queue's own default lane counts as promoted", () => {
    // Every entry inherits `priority` here, so rk:3 is already in the lane and the only
    // thing that moves is where it sits in it.
    expect(
      promotedOrder(items, "rk:3", "priority"),
    ).toEqual(["rk:1", "rk:2", "rk:4", "rk:3"])
  })

  test("an unknown key leaves the order exactly as it was", () => {
    expect(promotedOrder(items, "rk:99", "random")).toEqual(
      ["rk:1", "rk:2", "rk:3", "rk:4"],
    )
  })

  test("the first promote into an empty lane puts it at the head, which is the whole lane", () => {
    const pool = [
      item({ key: "rk:1" }),
      item({ key: "rk:2" }),
    ]

    expect(promotedOrder(pool, "rk:2", "random")).toEqual([
      "rk:2",
      "rk:1",
    ])
  })
})
