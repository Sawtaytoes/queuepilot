import { describe, expect, it } from "vitest"

import {
  entryTitle,
  groupHits,
  hitLabel,
  poolSections,
} from "./searchGroups"
import type { SearchHit } from "./types"

const hit = (
  ratingKey: string,
  sectionId: number,
  type: SearchHit["type"] = "movie",
  extra: Partial<SearchHit> = {},
): SearchHit => ({
  ratingKey,
  sectionId,
  title: `T${ratingKey}`,
  type,
  ...extra,
})

const LABELS = {
  inPool: "In this pool",
  rest: "Other libraries",
}

describe("groupHits", () => {
  it("puts the pool's own libraries first and everything else after", () => {
    const out = groupHits(
      [
        hit("a", 99),
        hit("b", 5),
        hit("c", 99),
        hit("d", 15),
      ],
      new Set([5, 15]),
      LABELS,
    )
    expect(out.map((g) => g.hit.ratingKey)).toEqual([
      "b",
      "d",
      "a",
      "c",
    ])
  })

  it("keeps collections leading INSIDE each group, not just overall", () => {
    // A collection out of pool must not jump ahead of an in-pool item: the group is the
    // outer sort, collections-first only breaks ties within one.
    const out = groupHits(
      [
        hit("item-in", 5),
        hit("coll-out", 99, "collection"),
        hit("coll-in", 5, "collection"),
      ],
      new Set([5]),
      LABELS,
    )
    expect(out.map((g) => g.hit.ratingKey)).toEqual([
      "coll-in",
      "item-in",
      "coll-out",
    ])
  })

  it("is stable, so Plex's own relevance order survives within a group", () => {
    const out = groupHits(
      [hit("first", 5), hit("second", 5), hit("third", 5)],
      new Set([5]),
      LABELS,
    )
    expect(out.map((g) => g.hit.ratingKey)).toEqual([
      "first",
      "second",
      "third",
    ])
  })

  it("marks only the first row of each group", () => {
    const out = groupHits(
      [
        hit("a", 5),
        hit("b", 5),
        hit("c", 99),
        hit("d", 99),
      ],
      new Set([5]),
      LABELS,
    )
    expect(out.map((g) => g.separator)).toEqual([
      "In this pool",
      null,
      "Other libraries",
      null,
    ])
  })

  it("labels nothing when every hit is in the pool — there is no second group", () => {
    const out = groupHits(
      [hit("a", 5), hit("b", 5)],
      new Set([5]),
      LABELS,
    )
    expect(out.map((g) => g.separator)).toEqual([
      null,
      null,
    ])
  })

  it("still labels the rest when NOTHING is in the pool, so the reason is on screen", () => {
    const out = groupHits(
      [hit("a", 99), hit("b", 99)],
      new Set([5]),
      LABELS,
    )
    expect(out.map((g) => g.separator)).toEqual([
      "Other libraries",
      null,
    ])
  })
})

describe("poolSections", () => {
  it("is the union of show and item libraries", () => {
    expect(
      poolSections({ sections: [5], item_sections: [15] }),
    ).toEqual(new Set([5, 15]))
  })

  it("survives a set that carries neither", () => {
    expect(
      poolSections({
        sections: [],
        item_sections: undefined,
      }),
    ).toEqual(new Set())
  })
})

describe("hitLabel", () => {
  it("names the edition, which is the only thing telling two editions apart", () => {
    expect(
      hitLabel({
        ...hit("1", 15),
        title: "Big Buck Bunny",
        year: 2008,
        editionTitle: "3D",
      }),
    ).toBe("Big Buck Bunny (2008) — 3D")
  })

  it("leaves the plain edition plain — Plex tags only one of the pair", () => {
    expect(
      hitLabel({
        ...hit("2", 15),
        title: "Big Buck Bunny",
        year: 2008,
      }),
    ).toBe("Big Buck Bunny (2008)")
  })

  it("omits a missing year rather than printing an empty bracket", () => {
    expect(
      hitLabel({ ...hit("3", 15), title: "Untitled" }),
    ).toBe("Untitled")
  })
})

describe("entryTitle", () => {
  // The 2026-08-21 defect: the queue add box built this string itself, without the edition,
  // so two editions of one film went into `queues.yaml` under the same title.
  it("tells two editions of one film apart", () => {
    const tagged = entryTitle({
      ...hit("267280", 15),
      title: "Big Buck Bunny",
      year: 2008,
      editionTitle: "3D",
    })
    const plain = entryTitle({
      ...hit("267281", 15),
      title: "Big Buck Bunny",
      year: 2008,
    })

    expect(tagged).toBe("Big Buck Bunny (2008) — 3D")
    expect(plain).toBe("Big Buck Bunny (2008)")
    expect(tagged).not.toBe(plain)
  })

  it("leaves the plain edition plain — Plex tags only one of the pair", () => {
    expect(
      entryTitle({
        ...hit("2", 15),
        title: "Big Buck Bunny",
        year: 2008,
      }),
    ).toBe("Big Buck Bunny (2008)")
  })

  it("stores a COLLECTION by its bare name, with no year and no edition", () => {
    // A collection entry is written as the literal `Collection: <name>` the resolver expands
    // by NAME, so anything appended to the title stops it resolving.
    expect(
      entryTitle({
        ...hit("77", 15, "collection"),
        title: "Blender Open Movies",
        year: 2008,
      }),
    ).toBe("Blender Open Movies")
  })

  it("names a SHOW the same way an item is named", () => {
    expect(
      entryTitle({
        ...hit("9", 5, "show"),
        title: "A Fixture Series",
        year: 2019,
      }),
    ).toBe("A Fixture Series (2019)")
  })
})
