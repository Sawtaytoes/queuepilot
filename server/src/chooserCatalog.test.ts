import { beforeEach, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getRegistry: vi.fn(),
}))
vi.mock("./sets.js", () => ({
  getRegistry: mocks.getRegistry,
}))
vi.mock("./season.js", () => ({
  isSetAvailable: () => true,
}))
vi.mock("./providers/blocks.js", () => ({
  providerIdForSet: () => "plex",
}))
vi.mock("./chooserPosterCache.js", () => ({
  chooserPosterPath: (set: { id: string }) =>
    `/poster/${set.id}`,
}))
vi.mock("./kind.js", () => ({
  wireKindForSet: (set: { kind: string }) => set.kind,
}))
vi.mock("./nativeTv.js", () => ({
  nativeAudience: () => [],
  nativeQueueTitles: async () => new Map<string, string>(),
}))
vi.mock("./queuePeople.js", () => ({
  queueMatchesSelection: () => true,
}))
vi.mock("./store/db/people.js", () => ({
  listPeople: () => [],
}))
vi.mock("./store/db/personPhotos.js", () => ({
  photoVersionsByPerson: () => new Map(),
}))
vi.mock("./store/db/queuePeople.js", () => ({
  membersByQueue: () => new Map(),
}))

import { chooserCatalog } from "./chooserCatalog.js"

beforeEach(() => {
  mocks.getRegistry.mockResolvedValue({
    sets: [
      {
        id: "learning",
        kind: "picks",
        source: "queue",
        requires_profile: "Student",
        plex_user: null,
      },
      {
        id: "films",
        kind: "rules",
        source: "rotation",
        requires_profile: null,
        plex_user: "Ada",
      },
      {
        id: "shared",
        kind: "picks",
        source: "queue",
        requires_profile: null,
        plex_user: null,
      },
    ],
  })
})

test("a tap names the profile a rotation channel plays as, so the scan switches the TV", async () => {
  const queues = await chooserCatalog(["ada"])
  expect(
    queues.map(({ id, profile }) => ({ id, profile })),
  ).toEqual([
    { id: "learning", profile: "Student" },
    { id: "films", profile: "Ada" },
    { id: "shared", profile: undefined },
  ])
  expect(
    queues.find((queue) => queue.id === "shared"),
  ).not.toHaveProperty("profile")
})
