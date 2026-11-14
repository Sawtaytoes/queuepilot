import { beforeEach, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getSet: vi.fn(),
  loadSets: vi.fn(),
  bindingFor: vi.fn(),
  profileBinding: vi.fn(),
  buckets: vi.fn(),
  thumb: vi.fn(),
  plexGet: vi.fn(),
  profileUser: vi.fn(),
  access: vi.fn(),
  sharedThumb: vi.fn(),
  sharedGet: vi.fn(),
  profileToken: vi.fn(),
  materialize: vi.fn(),
  handoff: vi.fn(),
}))
vi.mock("./sets.js", () => ({ getSet: mocks.getSet }))
vi.mock("./season.js", () => ({
  isSetAvailable: () => true,
}))
vi.mock("./engine/routing.js", () => ({
  loadSets: mocks.loadSets,
  bindingFor: mocks.bindingFor,
}))
vi.mock("./providers/index.js", () => ({
  providerFor: () => ({
    kind: "plex",
    profileBinding: mocks.profileBinding,
    profileToken: mocks.profileToken,
    buckets: mocks.buckets,
    materialize: mocks.materialize,
    handoff: mocks.handoff,
  }),
}))
vi.mock("./providers/blocks.js", () => ({
  providerIdForSet: () => "plex",
}))
vi.mock("./plex.js", () => ({
  thumb: mocks.thumb,
  plexGet: mocks.plexGet,
  profileUser: mocks.profileUser,
}))
vi.mock("./plexSources.js", () => ({
  plexServerAccessForProfile: mocks.access,
  plexServerThumb: mocks.sharedThumb,
  plexServerGet: mocks.sharedGet,
}))

import { chooserPoster } from "./chooserPoster.js"

beforeEach(() => {
  vi.resetAllMocks()
  const cfg = {
    id: "learning",
    source: "queue",
    requires_profile: "Student",
  }
  mocks.getSet.mockResolvedValue(cfg)
  mocks.loadSets.mockReturnValue({
    sets: { learning: cfg },
  })
  mocks.bindingFor.mockReturnValue({ account_id: null })
  mocks.profileBinding.mockResolvedValue({
    account_id: 12,
    user_uuid: "student",
  })
  mocks.profileToken.mockResolvedValue("restricted-token")
  mocks.buckets.mockResolvedValue({
    play: [{ ratingKey: "42" }],
  })
  mocks.plexGet.mockResolvedValue({
    MediaContainer: {
      Metadata: [
        { type: "episode", grandparentRatingKey: "11" },
      ],
    },
  })
  mocks.thumb.mockResolvedValue({
    buffer: Buffer.from("poster"),
    contentType: "image/jpeg",
  })
})
test("uses the queue profile and show poster without starting or persisting playback", async () => {
  expect(await chooserPoster("learning")).toEqual({
    buffer: Buffer.from("poster"),
    contentType: "image/jpeg",
  })
  expect(mocks.profileBinding).toHaveBeenCalledWith(
    { account_id: null },
    "Student",
  )
  expect(mocks.buckets).toHaveBeenCalledWith(
    expect.objectContaining({
      binding: { account_id: 12, user_uuid: "student" },
      token: "restricted-token",
    }),
  )
  expect(mocks.thumb).toHaveBeenCalledWith("11")
  expect(mocks.materialize).not.toHaveBeenCalled()
  expect(mocks.handoff).not.toHaveBeenCalled()
})
test("an empty queue has no poster", async () => {
  mocks.buckets.mockResolvedValue({ play: [] })
  expect(await chooserPoster("learning")).toBeNull()
  expect(mocks.thumb).not.toHaveBeenCalled()
})
test("shared-server keys stay scoped to that server and queue profile", async () => {
  mocks.buckets.mockResolvedValue({
    play: [{ ratingKey: "42", plexServer: "remote" }],
  })
  mocks.profileUser.mockResolvedValue({ uuid: "student" })
  mocks.access.mockResolvedValue({ id: "remote" })
  mocks.sharedGet.mockResolvedValue({
    MediaContainer: {
      Metadata: [
        { type: "episode", grandparentRatingKey: "99" },
      ],
    },
  })
  mocks.sharedThumb.mockResolvedValue({
    buffer: Buffer.from("shared"),
    contentType: "image/jpeg",
  })
  await chooserPoster("learning")
  expect(mocks.access).toHaveBeenCalledWith(
    "student",
    "remote",
  )
  expect(mocks.sharedThumb).toHaveBeenCalledWith(
    { id: "remote" },
    "99",
  )
  expect(mocks.thumb).not.toHaveBeenCalled()
})
test("unknown queues have no artwork or provider calls", async () => {
  mocks.getSet.mockResolvedValue(null)
  expect(await chooserPoster("missing")).toBeNull()
  expect(mocks.buckets).not.toHaveBeenCalled()
})

test("owner queues use the configured admin token when the profile UUID is null", async () => {
  mocks.profileBinding.mockResolvedValue({
    account_id: null,
    user_uuid: null,
  })
  mocks.profileToken.mockResolvedValue(null)
  expect(await chooserPoster("learning")).not.toBeNull()
  expect(mocks.buckets).toHaveBeenCalledWith(
    expect.objectContaining({ token: null }),
  )
})
test("a missing managed-user token never falls back to the owner token", async () => {
  mocks.profileToken.mockResolvedValue(null)
  expect(await chooserPoster("learning")).toBeNull()
  expect(mocks.buckets).not.toHaveBeenCalled()
})
