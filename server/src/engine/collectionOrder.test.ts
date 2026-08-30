import { describe, expect, it } from "vitest";

import { orderCollectionChildren } from "./resolve.js";

describe("orderCollectionChildren", () => {
  const children = [
    { ratingKey: "a", title: "A" },
    { ratingKey: "b", title: "B" },
    { ratingKey: "c", title: "C" },
  ];

  it("uses Plex order without an override", () => {
    expect(orderCollectionChildren(children).map((row) => row.ratingKey)).toEqual(["a", "b", "c"]);
  });

  it("uses the custom order and appends new Plex members", () => {
    expect(orderCollectionChildren(children, ["c", "a"]).map((row) => row.ratingKey))
      .toEqual(["c", "a", "b"]);
  });
});
