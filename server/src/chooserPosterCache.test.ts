import { expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  poster: vi.fn(),
  registry: vi.fn(),
  getSet: vi.fn((id: string) =>
    Promise.resolve({ id, provider_kind: "plex" }),
  ),
}))
vi.mock("./chooserPoster.js", () => ({
  chooserPoster: mocks.poster,
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
  const set = (await getSet("generation"))!
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
  const set = (await getSet("removed"))!
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
