import { beforeEach, expect, test, vi } from "vitest"

// The real manifest and cache, over invented queues: only the provider work is stubbed.
const mocks = vi.hoisted(() => ({
  poster: vi.fn(),
  queues: [] as {
    id: string
    provider_kind: string
    // eslint-disable-next-line @typescript-eslint/naming-convention -- a sets.yaml field
    enabled?: boolean
  }[],
}))
vi.mock("../chooserPoster.js", () => ({
  CHOOSER_POSTER_MAX_BYTES: 512_000,
  chooserPoster: mocks.poster,
}))
vi.mock("../sets.js", () => ({
  getRegistry: async () => ({ sets: mocks.queues }),
  getSet: async (id: string) =>
    mocks.queues.find((queue) => queue.id === id) ?? null,
}))
vi.mock("../providers/blocks.js", () => ({
  providerIdForSet: (set: { provider_kind?: string }) =>
    set.provider_kind || "plex",
  resolveSingle: () => ({
    provider: "plex",
    libraries: [],
  }),
}))
vi.mock("../providers/config.js", () => ({
  KINDS: [
    "plex",
    "kavita",
    "board-game-picker",
    "steam",
    "mister",
  ],
  definitionFor: (id: string) => ({ id, kind: id }),
  isConfigured: () => true,
}))
vi.mock("../devices.js", () => ({ known: () => null }))
vi.mock("../mqttc.js", () => ({
  lastState: () => null,
  connected: () => true,
}))
vi.mock("../playback.js", () => ({}))

import { playbackRoutes } from "./playbackRoutes.js"

const get = (path: string) => playbackRoutes().request(path)

beforeEach(() => {
  mocks.poster.mockReset()
  mocks.queues = [
    { id: "evening_shows", provider_kind: "plex" },
    { id: "night_reading", provider_kind: "kavita" },
    { id: "tabletop", provider_kind: "board-game-picker" },
    {
      id: "paused_shows",
      provider_kind: "plex",
      enabled: false,
    },
  ]
})

test("GET /chooser/posters lists Plex and reading queues, never an unavailable one", async () => {
  const response = await get("/chooser/posters")
  expect(response.status).toBe(200)
  const { posters } = (await response.json()) as {
    posters: { id: string; artworkPath: string }[]
  }
  expect(posters.map(({ id }) => id)).toEqual([
    "evening_shows",
    "night_reading",
    "tabletop",
  ])
  for (const { id, artworkPath } of posters)
    expect(artworkPath).toMatch(
      new RegExp(`^/api/chooser/poster/${id}\\?v=`),
    )
})

test("GET /chooser/poster/:id serves a reading queue's cover bytes", async () => {
  mocks.poster.mockResolvedValue({
    buffer: Buffer.from("series-cover"),
    contentType: "image/png",
  })
  const response = await get(
    "/chooser/poster/night_reading",
  )
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toBe(
    "image/png",
  )
  expect(await response.text()).toBe("series-cover")
  expect(mocks.poster).toHaveBeenCalledWith("night_reading")
})

test("a queue with no art anywhere answers 404, and its manifest path says none", async () => {
  mocks.poster.mockResolvedValue(null)
  expect(
    (await get("/chooser/poster/evening_shows")).status,
  ).toBe(404)
  const { posters } = (await (
    await get("/chooser/posters")
  ).json()) as {
    posters: { id: string; artworkPath: string }[]
  }
  expect(
    posters.find(({ id }) => id === "evening_shows")
      ?.artworkPath,
  ).toMatch(/-none$/)
})

test("unknown and unavailable queues answer 404 without provider work", async () => {
  expect(
    (await get("/chooser/poster/no_such")).status,
  ).toBe(404)
  expect(
    (await get("/chooser/poster/paused_shows")).status,
  ).toBe(404)
  expect(mocks.poster).not.toHaveBeenCalled()
})
