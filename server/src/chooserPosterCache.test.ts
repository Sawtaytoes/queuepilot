import { expect, test, vi } from "vitest"
import { defined } from "./defined.js"

const mocks = vi.hoisted(() => ({
  poster: vi.fn(),
  registry: vi.fn(),
  getSet: vi.fn((id: string) =>
    Promise.resolve({ id, provider_kind: "plex" }),
  ),
}))
vi.mock("./chooserPoster.js", () => ({
  CHOOSER_POSTER_MAX_BYTES: 512_000,
  chooserPoster: mocks.poster,
}))
vi.mock("./providers/blocks.js", () => ({
  providerIdForSet: (set: {
    provider_id?: string
    provider_kind?: string
  }) => set.provider_id || set.provider_kind || "plex",
}))
vi.mock("./providers/config.js", () => ({
  KINDS: [
    "plex",
    "kavita",
    "board-game-picker",
    "steam",
    "mister",
  ],
  definitionFor: (id: string) =>
    id === "unknown" ? null : { id, kind: id },
  isConfigured: (id: string) => id !== "steam",
}))
vi.mock("./sets.js", () => ({
  getRegistry: mocks.registry,
  getSet: mocks.getSet,
}))
vi.mock("./season.js", () => ({
  isSetAvailable: () => true,
}))

import {
  cachedChooserPoster,
  chooserPosterPath,
  chooserPosterPaths,
  hasChooserPoster,
  warmChooserPosters,
} from "./chooserPosterCache.js"
import { getSet } from "./sets.js"

test("warming covers the registry and later image reads never resolve the provider again", async () => {
  mocks.registry.mockResolvedValue({
    sets: [
      { id: "learning", provider_kind: "plex" },
      { id: "movies", provider_kind: "plex" },
    ],
  })
  mocks.poster.mockResolvedValue({
    buffer: Buffer.from("poster"),
    contentType: "image/jpeg",
  })
  await warmChooserPosters()
  expect(mocks.poster).toHaveBeenCalledTimes(2)
  await cachedChooserPoster("learning")
  await cachedChooserPoster("movies")
  expect(mocks.poster).toHaveBeenCalledTimes(2)
  vi.spyOn(Date, "now").mockReturnValue(
    Date.now() + 360_000,
  )
  let complete: (value: unknown) => void = () => {}
  mocks.poster.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  expect(
    (
      await cachedChooserPoster("learning")
    )?.buffer.toString(),
  ).toBe("poster")
  await cachedChooserPoster("learning")
  expect(mocks.poster).toHaveBeenCalledTimes(3)
  complete(null)
  vi.restoreAllMocks()
})

test("refreshing already cached queues keeps provider concurrency bounded", async () => {
  mocks.registry.mockResolvedValue({
    sets: ["one", "two", "three", "four"].map((id) => ({
      id,
      provider_kind: "plex",
    })),
  })
  const image = {
    buffer: Buffer.from("image"),
    contentType: "image/jpeg",
  }
  mocks.poster.mockResolvedValue(image)
  await warmChooserPosters()
  const activity = { count: 0, maximum: 0 }
  mocks.poster.mockImplementation(async () => {
    activity.count += 1
    activity.maximum = Math.max(
      activity.maximum,
      activity.count,
    )
    await new Promise((resolve) => setTimeout(resolve, 1))
    activity.count -= 1
    return image
  })
  await warmChooserPosters()
  expect(activity.maximum).toBe(2)
})

test("configuration changes invalidate URLs and cannot reuse old profile bytes", async () => {
  mocks.poster.mockResolvedValue({
    buffer: Buffer.from("private"),
    contentType: "image/jpeg",
  })
  await cachedChooserPoster("profile-change")
  mocks.getSet.mockImplementationOnce(async () => ({
    id: "profile-change",
    provider_kind: "plex",
    requires_profile: "Other",
  }))
  mocks.poster.mockResolvedValue(null)
  expect(
    await cachedChooserPoster("profile-change"),
  ).toBeNull()
})
test("confirmed unavailable images are cached briefly without provider work on each scan", async () => {
  mocks.poster.mockResolvedValue(null)
  await cachedChooserPoster("empty")
  const calls = mocks.poster.mock.calls.length
  expect(await cachedChooserPoster("empty")).toBeNull()
  expect(mocks.poster).toHaveBeenCalledTimes(calls)
})

test("an obsolete provider request cannot overwrite a newer configuration generation", async () => {
  const set = defined(await getSet("generation"))
  const before = chooserPosterPath(set)
  const deferred = Promise.withResolvers<{
    buffer: Buffer
    contentType: string
  } | null>()
  mocks.poster.mockReturnValueOnce(deferred.promise)
  const calls = mocks.poster.mock.calls.length
  const old = cachedChooserPoster("generation")
  await vi.waitFor(() =>
    expect(mocks.poster).toHaveBeenCalledTimes(calls + 1),
  )
  mocks.getSet.mockImplementationOnce(async () => ({
    id: "generation",
    provider_kind: "plex",
    requires_profile: "Restricted",
  }))
  mocks.poster.mockResolvedValueOnce(null)
  await cachedChooserPoster("generation")
  deferred.resolve({
    buffer: Buffer.from("obsolete"),
    contentType: "image/jpeg",
  })
  expect(await old).toBeNull()
  expect(
    chooserPosterPath({
      ...set,
      requires_profile: "Restricted",
    }),
  ).not.toBe(before)
})

test("a null refresh removes previous artwork and negative results expire", async () => {
  const set = defined(await getSet("removed"))
  mocks.poster.mockResolvedValue({
    buffer: Buffer.from("old"),
    contentType: "image/jpeg",
  })
  await cachedChooserPoster("removed")
  const original = chooserPosterPath(set)
  mocks.poster.mockResolvedValue(null)
  await cachedChooserPoster("removed", true)
  expect(await cachedChooserPoster("removed")).toBeNull()
  expect(chooserPosterPath(set)).not.toBe(original)
  const calls = mocks.poster.mock.calls.length
  const realNow = Date.now()
  vi.spyOn(Date, "now").mockReturnValue(realNow + 31_000)
  await cachedChooserPoster("removed")
  await vi.waitFor(() =>
    expect(mocks.poster).toHaveBeenCalledTimes(calls + 1),
  )
  vi.restoreAllMocks()
})

test("the manifest lists every configured provider's queues, not only Plex", async () => {
  mocks.registry.mockResolvedValue({
    sets: [
      { id: "shows", provider_kind: "plex" },
      { id: "reading", provider_kind: "kavita" },
      { id: "reading-narrow", provider_kind: "kavita" },
      {
        id: "tabletop",
        provider_kind: "board-game-picker",
      },
      { id: "arcade", provider_kind: "mister" },
      { id: "desktop-games", provider_kind: "steam" },
      {
        id: "orphan",
        provider_kind: "",
        provider_id: "unknown",
      },
    ],
  })
  expect(
    (await chooserPosterPaths()).map(({ id }) => id),
  ).toEqual([
    "shows",
    "reading",
    "reading-narrow",
    "tabletop",
    "arcade",
  ])
})

test("a legacy set with no provider kind is still a Plex queue", () => {
  expect(
    hasChooserPoster({
      id: "legacy",
      provider_kind: "",
    } as never),
  ).toBe(true)
})

test("the image route serves a reading queue's poster and refuses an unconfigured provider", async () => {
  mocks.getSet.mockImplementation(async (id: string) => ({
    id,
    provider_kind: id === "games" ? "steam" : "kavita",
  }))
  mocks.poster.mockResolvedValue({
    buffer: Buffer.from("cover"),
    contentType: "image/png",
  })
  expect(
    (await cachedChooserPoster("books"))?.buffer.toString(),
  ).toBe("cover")
  const calls = mocks.poster.mock.calls.length
  expect(await cachedChooserPoster("games")).toBeNull()
  expect(mocks.poster).toHaveBeenCalledTimes(calls)
  mocks.getSet.mockImplementation((id: string) =>
    Promise.resolve({ id, provider_kind: "plex" }),
  )
})

test("an oversized image is never cached or served", async () => {
  mocks.poster.mockResolvedValue({
    buffer: Buffer.alloc(512_001),
    contentType: "image/jpeg",
  })
  expect(await cachedChooserPoster("huge", true)).toBeNull()
})

test("a pull provider's found cover is kept 30 minutes and the warmer does not force it", async () => {
  mocks.getSet.mockImplementation(async (id: string) => ({
    id,
    provider_kind: id === "bookshelf" ? "kavita" : "plex",
  }))
  mocks.registry.mockResolvedValue({
    sets: [
      { id: "bookshelf", provider_kind: "kavita" },
      { id: "screen", provider_kind: "plex" },
    ],
  })
  mocks.poster.mockResolvedValue({
    buffer: Buffer.from("cover"),
    contentType: "image/png",
  })
  await warmChooserPosters()
  await vi.waitFor(() =>
    expect(mocks.poster).toHaveBeenCalledWith("bookshelf"),
  )
  mocks.poster.mockClear()
  await warmChooserPosters()
  // Plex is refreshed on every run; the reading queue's fresh cover is not.
  expect(mocks.poster.mock.calls).toEqual([["screen"]])
  const realNow = Date.now()
  vi.spyOn(Date, "now").mockReturnValue(realNow + 600_000)
  mocks.poster.mockClear()
  await cachedChooserPoster("bookshelf")
  expect(mocks.poster).not.toHaveBeenCalled()
  vi.spyOn(Date, "now").mockReturnValue(realNow + 1_860_000)
  await cachedChooserPoster("bookshelf")
  await vi.waitFor(() =>
    expect(mocks.poster).toHaveBeenCalledWith("bookshelf"),
  )
  vi.restoreAllMocks()
  mocks.getSet.mockImplementation((id: string) =>
    Promise.resolve({ id, provider_kind: "plex" }),
  )
})
