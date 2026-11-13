import { describe, expect, test } from "vitest"
import { isPlayingItem } from "./nowPlaying"
import type { QueueItem } from "./types"

describe("mixed-server now-playing attribution", () => {
  const local = {
    ratingKey: "42",
    type: "movie",
  } as QueueItem
  const shared = {
    ratingKey: "42",
    plexServer: "friend-server",
    type: "movie",
  } as QueueItem

  test("does not confuse matching rating keys on different servers", () => {
    const now = {
      now: {
        state: "playing",
        ratingKey: "42",
        plexServer: "friend-server",
      },
      set: "movies",
    }
    expect(isPlayingItem(now, local)).toBe(false)
    expect(isPlayingItem(now, shared)).toBe(true)
  })

  test("highlights neither entry when the source is ambiguous", () => {
    const now = {
      now: {
        state: "playing",
        ratingKey: "42",
        plexServer: "",
      },
      set: "movies",
    }
    expect(isPlayingItem(now, local)).toBe(false)
    expect(isPlayingItem(now, shared)).toBe(false)
  })
})
