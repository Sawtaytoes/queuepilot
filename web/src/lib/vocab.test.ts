import { describe, expect, test } from "vitest"

import type { ProviderVocabulary } from "./types"
import {
  applyVocab,
  PLEX_WORDS,
  replacementTable,
  vocabForSet,
} from "./vocab"

const KAVITA: ProviderVocabulary = {
  done: "read",
  member: "series",
  name: "Kavita",
  unit: "chapter",
  units: "chapters",
  verb: "Read",
}

describe("replacementTable", () => {
  test("is empty for Plex's own words — applying them is a no-op", () => {
    expect(replacementTable(PLEX_WORDS)).toEqual([])
  })

  test("lists Kavita swaps longest-first so episodes beats episode", () => {
    const keys = replacementTable(KAVITA).map(
      ([from]) => from,
    )

    expect(keys.indexOf("episodes")).toBeLessThan(
      keys.indexOf("episode"),
    )
    expect(keys.indexOf("unwatched")).toBeLessThan(
      keys.indexOf("watched"),
    )
    expect(keys).toContain("Plex")
    expect(keys).toContain("Playback")
  })
})

describe("applyVocab", () => {
  test("leaves a Plex string alone when the vocab is Plex", () => {
    const src =
      "Playback begins here. Earlier episodes are skipped — nothing is marked watched on Plex."

    expect(applyVocab(src, PLEX_WORDS)).toBe(src)
    expect(applyVocab(src, null)).toBe(src)
  })

  test("rewrites the start-modal paragraph for Kavita", () => {
    expect(
      applyVocab(
        "Playback begins here and keeps going automatically. Earlier episodes are skipped — nothing is marked watched on Plex.",
        KAVITA,
      ),
    ).toBe(
      "Reading begins here and keeps going automatically. Earlier chapters are skipped — nothing is marked read on Kavita.",
    )
  })

  test("rewrites the load-failure note", () => {
    expect(
      applyVocab(
        "Could not read this series’ episodes from Plex.",
        KAVITA,
      ),
    ).toBe(
      "Could not read this series’ chapters from Kavita.",
    )
  })

  test("rewrites the tile-menu actions and repairs a/an", () => {
    expect(
      applyVocab("Start from an episode…", KAVITA),
    ).toBe("Start from a chapter…")
    expect(
      applyVocab("Change start episode…", KAVITA),
    ).toBe("Change start chapter…")
    expect(applyVocab("an episode", KAVITA)).toBe(
      "a chapter",
    )
  })

  test("capitalises the swapped word the way the source did", () => {
    expect(applyVocab("Episode", KAVITA)).toBe("Chapter")
    expect(applyVocab("Watched", KAVITA)).toBe("Read")
    expect(applyVocab("Loading episodes…", KAVITA)).toBe(
      "Loading chapters…",
    )
    expect(applyVocab("the next unwatched", KAVITA)).toBe(
      "the next unread",
    )
  })

  test("does not rewrite a word that merely CONTAINS a Plex noun", () => {
    expect(
      applyVocab("showing episodic Playback", KAVITA),
    ).toBe("showing episodic Reading")
    expect(applyVocab("the show", KAVITA)).toBe(
      "the series",
    )
    expect(applyVocab("the shows", KAVITA)).toBe(
      "the series",
    )
  })

  test("does not touch a string with nothing to swap", () => {
    expect(applyVocab("Cancel", KAVITA)).toBe("Cancel")
    expect(applyVocab("", KAVITA)).toBe("")
  })
})

describe("vocabForSet", () => {
  test("returns the named set's vocabulary, else Plex", () => {
    const sets = [
      { id: "tv", vocabulary: PLEX_WORDS },
      { id: "manga", vocabulary: KAVITA },
    ]

    expect(vocabForSet(sets, "manga")).toBe(KAVITA)
    expect(vocabForSet(sets, "missing")).toBe(PLEX_WORDS)
    expect(vocabForSet(sets, null)).toBe(PLEX_WORDS)
    expect(vocabForSet(undefined, "manga")).toBe(PLEX_WORDS)
  })
})
