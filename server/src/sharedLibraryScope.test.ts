import { describe, expect, test } from "vitest"

import { sharedLibraryScope } from "./sharedLibraryScope.js"

describe("sharedLibraryScope", () => {
  test("keeps only named library scopes and deduplicates ids", () => {
    expect(
      sharedLibraryScope({
        "server-one": ["7", 7, " 9 ", "bad"],
        "server-two": [],
        "bad/server": ["1"],
      }),
    ).toEqual({ "server-one": ["7", "9"] })
  })

  test("treats absent or malformed scope as all libraries", () => {
    expect(sharedLibraryScope(null)).toEqual({})
    expect(sharedLibraryScope(["7"])).toEqual({})
  })
})
