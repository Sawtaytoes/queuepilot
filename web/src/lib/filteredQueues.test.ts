import { describe, expect, it } from "vitest"

import {
  filteredParent,
  nestFilteredQueues,
} from "./filteredQueues"
import type { RegistrySet } from "./types"

const set = (
  id: string,
  filteredFrom: string | null = null,
): RegistrySet =>
  ({
    blocklist: [],
    filtered_from: filteredFrom,
    id,
    included_specials: [],
    kind: "picks",
    label: id.toUpperCase(),
    sections: [],
    skipped: [],
    source: "queue",
  }) as unknown as RegistrySet

const registry = (...sets: RegistrySet[]) => {
  const byId = new Map(sets.map((s) => [s.id, s]))

  return (id: string) => byId.get(id) ?? null
}

describe("nestFilteredQueues", () => {
  it("moves a filtered queue directly under the queue it views", () => {
    const byId = registry(
      set("reading"),
      set("movies"),
      set("strips", "reading"),
    )

    expect(
      nestFilteredQueues(
        ["reading", "movies", "strips"],
        byId,
      ),
    ).toEqual(["reading", "strips", "movies"])
  })

  it("keeps several views of one queue in their own order", () => {
    const byId = registry(
      set("reading"),
      set("strips", "reading"),
      set("panels", "reading"),
    )

    expect(
      nestFilteredQueues(
        ["panels", "reading", "strips"],
        byId,
      ),
    ).toEqual(["reading", "panels", "strips"])
  })

  it("leaves an ordinary list untouched", () => {
    const byId = registry(set("reading"), set("movies"))

    expect(
      nestFilteredQueues(["reading", "movies"], byId),
    ).toEqual(["reading", "movies"])
  })

  it("keeps an ORPHAN in place rather than dropping it", () => {
    // Its parent is not in this list — filtered out by the people bar, or a typo. Losing a
    // queue quietly is the worse failure.
    const byId = registry(set("strips", "reading"))

    expect(
      nestFilteredQueues(["movies", "strips"], byId),
    ).toEqual(["movies", "strips"])
  })

  it("never repeats or drops an id", () => {
    const byId = registry(
      set("reading"),
      set("movies"),
      set("strips", "reading"),
      set("shorts", "movies"),
    )
    const out = nestFilteredQueues(
      ["strips", "reading", "shorts", "movies"],
      byId,
    )

    expect([...out].sort()).toEqual([
      "movies",
      "reading",
      "shorts",
      "strips",
    ])
    expect(out).toEqual([
      "reading",
      "strips",
      "movies",
      "shorts",
    ])
  })
})

describe("filteredParent", () => {
  it("names the queue a view is a view of", () => {
    const byId = registry(
      set("reading"),
      set("strips", "reading"),
    )

    expect(filteredParent(byId("strips"), byId)).toEqual({
      id: "reading",
      label: "READING",
    })
  })

  it("answers null for an ordinary queue", () => {
    const byId = registry(set("reading"))

    expect(filteredParent(byId("reading"), byId)).toBeNull()
  })

  it("falls back to the id when the parent is missing", () => {
    const byId = registry(set("strips", "reading"))

    expect(filteredParent(byId("strips"), byId)).toEqual({
      id: "reading",
      label: "reading",
    })
  })
})
