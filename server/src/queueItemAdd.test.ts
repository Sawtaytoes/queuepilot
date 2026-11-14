import {
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest"

const mocks = vi.hoisted(() => ({
  findDuplicateItem: vi.fn(),
  addItem: vi.fn(),
  listSet: vi.fn(),
  plexServerAccessForProfile: vi.fn(),
  plexServerGet: vi.fn(),
  routing: {
    watch: { source: "queue", requires_profile: "Ada" },
  } as Record<string, unknown>,
}))
vi.mock("./engine/plex-live.js", () => ({
  liveClient: () => ({}),
}))
vi.mock("./engine/routing.js", () => ({
  loadSets: () => ({ sets: mocks.routing }),
}))
vi.mock("./entryIdentity.js", () => ({
  findDuplicateItem: mocks.findDuplicateItem,
}))
vi.mock("./plex.js", () => ({
  machineIdentifier: async () => "fixture-home-server",
  profileScope: async () => ({ account: "ada-uuid" }),
}))
vi.mock("./plexSources.js", () => ({
  plexServerAccessForProfile:
    mocks.plexServerAccessForProfile,
  plexServerGet: mocks.plexServerGet,
}))
vi.mock("./queues.js", () => ({
  addItem: mocks.addItem,
  listSet: mocks.listSet,
}))

import {
  addQueueItem,
  QueueAddError,
} from "./queueItemAdd.js"

describe("addQueueItem", () => {
  beforeEach(() => {
    for (const spy of [
      mocks.findDuplicateItem,
      mocks.addItem,
      mocks.listSet,
      mocks.plexServerAccessForProfile,
      mocks.plexServerGet,
    ])
      spy.mockReset()
    mocks.listSet.mockResolvedValue([])
    mocks.findDuplicateItem.mockResolvedValue(null)
    mocks.addItem.mockResolvedValue({
      added: true,
      key: "rk:401",
    })
  })

  test("writes a home item where the caller asked", async () => {
    await expect(
      addQueueItem(
        "watch",
        { ratingKey: "401", title: "Glass City" },
        "top",
      ),
    ).resolves.toEqual({ added: true, key: "rk:401" })
    expect(mocks.addItem).toHaveBeenCalledWith(
      "watch",
      { ratingKey: "401", title: "Glass City" },
      "top",
      { isDuplicateAllowed: false },
    )
    expect(mocks.plexServerGet).not.toHaveBeenCalled()
  })

  test("names the line a duplicate repeats, unless a duplicate was asked for", async () => {
    mocks.findDuplicateItem.mockResolvedValue({
      key: "rk:401",
    })
    await expect(
      addQueueItem(
        "watch",
        { ratingKey: "401", title: "Glass City" },
        "top",
      ),
    ).resolves.toEqual({
      added: false,
      key: "rk:401",
      duplicateOf: "rk:401",
    })
    expect(mocks.addItem).not.toHaveBeenCalled()
    await addQueueItem(
      "watch",
      { ratingKey: "401", title: "Glass City" },
      "bottom",
      {
        isDuplicateAllowed: true,
      },
    )
    expect(mocks.addItem).toHaveBeenCalledWith(
      "watch",
      { ratingKey: "401", title: "Glass City" },
      "bottom",
      { isDuplicateAllowed: true },
    )
  })

  test("checks a shared-server item through the queue profile before writing it", async () => {
    mocks.plexServerAccessForProfile.mockResolvedValue({
      baseUrl: "https://shared.example.com",
    })
    mocks.plexServerGet.mockResolvedValue({
      MediaContainer: { Metadata: [{ type: "show" }] },
    })
    const value = {
      ratingKey: "402",
      title: "Orbit Nine",
      plex_server: "fixture-shared",
    }
    await addQueueItem("watch", value, "top")
    expect(
      mocks.plexServerAccessForProfile,
    ).toHaveBeenCalledWith("ada-uuid", "fixture-shared")
    expect(mocks.addItem).toHaveBeenCalled()
  })

  test("refuses a shared-server item it cannot vouch for", async () => {
    const refusal = (value: unknown) =>
      addQueueItem("watch", value as never, "top").catch(
        (error: QueueAddError) => [
          error instanceof QueueAddError,
          error.status,
        ],
      )
    expect(
      await refusal({
        ratingKey: "402",
        title: "x",
        plex_server: "fixture-home-server",
      }),
    ).toEqual([true, 400])
    expect(
      await refusal({
        ratingKey: "x",
        title: "x",
        plex_server: "fixture-shared",
      }),
    ).toEqual([true, 400])
    mocks.plexServerAccessForProfile.mockResolvedValue(null)
    expect(
      await refusal({
        ratingKey: "402",
        title: "x",
        plex_server: "fixture-shared",
      }),
    ).toEqual([true, 403])
    mocks.plexServerAccessForProfile.mockResolvedValue({
      baseUrl: "https://shared.example.com",
    })
    mocks.plexServerGet.mockResolvedValue({
      MediaContainer: { Metadata: [{ type: "episode" }] },
    })
    expect(
      await refusal({
        ratingKey: "402",
        title: "x",
        plex_server: "fixture-shared",
      }),
    ).toEqual([true, 400])
    expect(mocks.addItem).not.toHaveBeenCalled()
  })
})
