import { describe, expect, it } from "vitest"

import { spliceOrder } from "./useRowReorder"

describe("spliceOrder", () => {
  it("permutes only the slots the shelf's own ids occupy", () => {
    // b and d are one shelf, interleaved with rows from another. Swapping them must leave
    // a, c and e exactly where they were — the shelves are slices of ONE file order.
    expect(
      spliceOrder(["a", "b", "c", "d", "e"], ["d", "b"]),
    ).toEqual(["a", "d", "c", "b", "e"])
  })

  it("returns the full order, because a partial one would sweep the rest to the end", () => {
    // reorderSets ranks what it is told about and appends everything else, so sending a
    // shelf's ids alone is destructive to every other set's position.
    const full = ["a", "b", "c"]
    expect(spliceOrder(full, ["b", "a"])).toHaveLength(
      full.length,
    )
  })

  it("leaves a hidden row alone, which is what makes reordering safe under a group filter", () => {
    // `hidden` is filtered out of the shelf, so it is not in shelfOrder and its slot is
    // never touched — the visible rows shuffle around it.
    expect(
      spliceOrder(["x", "hidden", "y"], ["y", "x"]),
    ).toEqual(["y", "hidden", "x"])
  })

  it("is a no-op when the order did not change", () => {
    expect(
      spliceOrder(["a", "b", "c"], ["a", "b"]),
    ).toEqual(["a", "b", "c"])
  })

  it("ignores an id the full order has never heard of", () => {
    // A row can be removed in another tab between the drag and the drop.
    expect(
      spliceOrder(["a", "b"], ["b", "a", "ghost"]),
    ).toEqual(["b", "a"])
  })
})
