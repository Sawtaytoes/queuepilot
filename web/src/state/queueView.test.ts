import { describe, expect, test } from "vitest"

import type { QueueItem } from "../lib/types"
import {
  applyFilters,
  effectiveLane,
  hasOverrides,
  orderAfterLaneMove,
  orderAtPriorityPosition,
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

  test("an explicit sort is preserved inside both lanes", () => {
    const recent = [
      item({
        key: "old-priority",
        placement: "priority",
        queuedAt: 10,
      }),
      item({
        key: "new-pool",
        placement: "random",
        queuedAt: 40,
      }),
      item({
        key: "new-priority",
        placement: "priority",
        queuedAt: 30,
      }),
      item({
        key: "old-pool",
        placement: "random",
        queuedAt: 20,
      }),
    ]

    const sorted = applyFilters(recent, {
      sort: "recent",
      state: "",
      text: "",
      type: "",
    })
    const lanes = splitLanes(sorted, "random", "recent")

    expect(lanes.priority.map((it) => it.key)).toEqual([
      "new-priority",
      "old-priority",
    ])
    expect(lanes.random.map((it) => it.key)).toEqual([
      "new-pool",
      "old-pool",
    ])
  })
})

describe("orderAfterLaneMove", () => {
  // Three promoted, three in the pool, on a queue whose own default lane is `random`.
  const items = [
    item({ key: "a", placement: "priority" }),
    item({ key: "b", placement: "priority" }),
    item({ key: "c", placement: "priority" }),
    item({ key: "d" }),
    item({ key: "e" }),
    item({ key: "f" }),
  ]
  const keys = (out: QueueItem[]) => out.map((i) => i.key)

  test("a promote lands at the END of the Priority queue, not at its old file position", () => {
    const moved = items.map((i) =>
      i.key === "e"
        ? { ...i, placement: "priority" as const }
        : i,
    )

    expect(
      keys(
        orderAfterLaneMove(
          moved,
          "random",
          ["e"],
          "priority",
        ),
      ),
    ).toEqual(["a", "b", "c", "e", "d", "f"])
  })

  test('"Play this next" lands at the HEAD of the Priority queue', () => {
    const moved = items.map((i) =>
      i.key === "e"
        ? { ...i, placement: "priority" as const }
        : i,
    )

    expect(
      keys(
        orderAfterLaneMove(
          moved,
          "random",
          ["e"],
          "priority",
          "top",
        ),
      ),
    ).toEqual(["e", "a", "b", "c", "d", "f"])
  })

  test("a demote leaves the Priority queue in its own order and joins the pool", () => {
    const moved = items.map((i) =>
      i.key === "b" ? { ...i, placement: null } : i,
    )

    expect(
      keys(
        orderAfterLaneMove(
          moved,
          "random",
          ["b"],
          "random",
        ),
      ),
    ).toEqual(["a", "c", "d", "e", "f", "b"])
  })

  test("a BULK move keeps the selection's relative order and lands it together", () => {
    const moved = items.map((i) =>
      i.key === "d" || i.key === "f"
        ? { ...i, placement: "priority" as const }
        : i,
    )

    expect(
      keys(
        orderAfterLaneMove(
          moved,
          "random",
          ["d", "f"],
          "priority",
        ),
      ),
    ).toEqual(["a", "b", "c", "d", "f", "e"])
  })

  // Carried over from `promotedOrder`, which this function replaced: a key that is not in
  // the queue must be a no-op rather than a re-sequence. A stale selection is the way it
  // happens — the entry was removed in another tab between the tick and the apply.
  test("a key that is not in the queue leaves the order exactly as it was", () => {
    expect(
      keys(
        orderAfterLaneMove(
          items,
          "random",
          ["nope"],
          "priority",
        ),
      ),
    ).toEqual(["a", "b", "c", "d", "e", "f"])
  })

  test("the file stays ONE sequence — priority first, always", () => {
    const out = orderAfterLaneMove(
      items,
      "random",
      [],
      "priority",
    )

    expect(keys(out)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ])
  })
})

describe("orderAtPriorityPosition", () => {
  const items = [
    item({ key: "a", placement: "priority" }),
    item({ key: "b", placement: "priority" }),
    item({ key: "c", placement: "priority" }),
    item({ key: "d" }),
    item({ key: "e" }),
  ]

  test("moves by one-based position and keeps the pool after Priority", () => {
    expect(
      orderAtPriorityPosition(items, "random", "c", 1).map(
        (entry) => entry.key,
      ),
    ).toEqual(["c", "a", "b", "d", "e"])
  })

  test("clamps positions beyond either end", () => {
    expect(
      orderAtPriorityPosition(items, "random", "a", 99).map(
        (entry) => entry.key,
      ),
    ).toEqual(["b", "c", "a", "d", "e"])
    expect(
      orderAtPriorityPosition(items, "random", "c", 0).map(
        (entry) => entry.key,
      ),
    ).toEqual(["c", "a", "b", "d", "e"])
  })

  test("a key outside Priority is a no-op", () => {
    expect(
      orderAtPriorityPosition(items, "random", "d", 1),
    ).toBe(items)
  })
})

describe("effectiveLane", () => {
  test("the entry's own placement wins", () => {
    expect(
      effectiveLane({ placement: "priority" }, "random"),
    ).toBe("priority")
    expect(
      effectiveLane({ placement: "random" }, "priority"),
    ).toBe("random")
  })

  test("no placement means the queue's own default — the sparse case", () => {
    expect(
      effectiveLane({ placement: null }, "random"),
    ).toBe("random")
    expect(effectiveLane({}, "priority")).toBe("priority")
  })
})
