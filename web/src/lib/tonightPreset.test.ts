import { describe, expect, test } from "vitest"

import {
  parseTonightPreset,
  type TonightPreset,
  tonightPresetHref,
} from "./tonightPreset"

/**
 * A PRESET CARD's address, and the rule it enforces.
 *
 * The cast is the repo's own — Ada, Grace, Linus — because a person id is what a card carries
 * and this repo is public.
 */
describe("parseTonightPreset", () => {
  test("reads who is here, the activity and the filters", () => {
    const parsed = parseTonightPreset(
      "?activity=board-games&people=ada,linus&guests=1&complexity=medium&fit=ok&interactionType=cooperative&maxPlaytime=60&categories=Cooperative,Deckbuilder",
    )

    expect(parsed.isAccepted).toBe(true)
    expect(parsed.preset).toEqual({
      activity: "board-games",
      filters: {
        categories: "Cooperative,Deckbuilder",
        complexity: "medium",
        fit: "ok",
        interactionType: "cooperative",
        knows: "someone",
        maxPlaytime: "60",
      },
      guestCount: 1,
      personIds: ["ada", "linus"],
    })
  })

  test("does not need the leading question mark", () => {
    expect(
      parseTonightPreset("activity=movies&people=ada")
        .isAccepted,
    ).toBe(true)
  })

  test("reads the old board-game light flag as the new Light choice", () => {
    const parsed = parseTonightPreset(
      "?activity=board-games&people=ada&light=on",
    )
    const neutral = parseTonightPreset(
      "?activity=board-games&people=ada&light=off",
    )

    expect(parsed.preset?.filters).toMatchObject({
      complexity: "light",
    })
    expect(neutral.preset?.filters).toMatchObject({
      complexity: "any",
    })
  })

  // THE RULE (absorb decision §5, fourth row). A card is a fixed string on plastic and
  // cannot ask who walked in, so a preset that names nobody is refused rather than being
  // helpfully read as "everybody" — that would pick for a table whose size nobody stated.
  test("REFUSES a card that names nobody, and says why", () => {
    const parsed = parseTonightPreset(
      "?activity=board-games&light=on",
    )

    expect(parsed.isAccepted).toBe(false)
    expect(parsed).toMatchObject({
      reason: expect.stringContaining("who is here"),
    })
  })

  test("accepts guests alone as who is here — a table with no roster rows still gets a pick", () => {
    const parsed = parseTonightPreset(
      "?activity=board-games&guests=3",
    )

    expect(parsed.isAccepted).toBe(true)
    expect(parsed.preset?.guestCount).toBe(3)
  })

  test("refuses Surprise Me, which narrows on a second screen before it picks", () => {
    const parsed = parseTonightPreset(
      "?activity=surprise&people=ada",
    )

    expect(parsed.isAccepted).toBe(false)
    // It still carries the preset, so the refusal can land on the narrowing screen rather
    // than on a blank one.
    expect(parsed.preset?.activity).toBe("surprise")
  })

  test("refuses an activity that is not a tile, and quotes what the card said", () => {
    const parsed = parseTonightPreset(
      "?activity=retro-games&people=ada",
    )

    expect(parsed.isAccepted).toBe(false)
    expect(parsed).toMatchObject({
      reason: expect.stringContaining("retro-games"),
    })
  })

  test("refuses a card that does not say what the evening is", () => {
    expect(
      parseTonightPreset("?people=ada").isAccepted,
    ).toBe(false)
  })

  // A card is written once and read for years. A typo must behave as the default, never as a
  // third state nothing handles.
  test("falls an unknown filter VALUE back to that filter's default", () => {
    const parsed = parseTonightPreset(
      "?activity=board-games&people=ada&light=onn",
    )

    expect(parsed.preset?.filters.complexity).toBe("light") // board games open with Light
  })

  test("drops a filter id this activity does not declare", () => {
    const parsed = parseTonightPreset(
      "?activity=reading&people=ada&runtime=90",
    )

    expect(parsed.preset?.filters).toEqual({ light: "off" })
  })

  test("reads a nonsense guest count as nought seats rather than failing the card", () => {
    const parsed = parseTonightPreset(
      "?activity=movies&people=ada&guests=-4",
    )

    expect(parsed.isAccepted).toBe(true)
    expect(parsed.preset?.guestCount).toBe(0)
  })

  test("ignores blank entries in the people list", () => {
    const parsed = parseTonightPreset(
      "?activity=movies&people=ada,,%20,grace",
    )

    expect(parsed.preset?.personIds).toEqual([
      "ada",
      "grace",
    ])
  })
})

describe("tonightPresetHref", () => {
  const preset: TonightPreset = {
    activity: "board-games",
    filters: {
      categories: "Cooperative,Deckbuilder",
      complexity: "medium",
      fit: "ok",
      interactionType: "cooperative",
      knows: "someone",
      maxPlaytime: "60",
    },
    guestCount: 2,
    personIds: ["ada", "linus"],
  }

  // The address and the parse are inverses, which is the property that keeps a card written
  // by this app readable by this app.
  test("round-trips through the parser", () => {
    const parsed = parseTonightPreset(
      tonightPresetHref(preset).split("?")[1] ?? "",
    )

    expect(parsed.isAccepted).toBe(true)
    expect(parsed.preset).toEqual(preset)
  })

  test("leaves a filter sitting at its own default out of the address", () => {
    const href = tonightPresetHref({
      ...preset,
      filters: {
        categories: "",
        complexity: "light",
        fit: "best",
        interactionType: "any",
        knows: "someone",
        maxPlaytime: "any",
      },
    })

    expect(href).not.toContain("fit=")
    expect(href).not.toContain("knows=")
    expect(href).not.toContain("light=")
  })

  test("leaves an empty roster and a nought guest count out", () => {
    const href = tonightPresetHref({
      ...preset,
      filters: {
        categories: "",
        complexity: "light",
        fit: "best",
        interactionType: "any",
        knows: "someone",
        maxPlaytime: "any",
      },
      guestCount: 0,
      personIds: [],
    })

    expect(href).toBe(
      "/what-to-watch-play/go?activity=board-games",
    )
  })
})
