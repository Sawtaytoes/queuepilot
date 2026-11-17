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
  cover: vi.fn(),
  providerKind: vi.fn(() => "plex"),
  hasCover: vi.fn(() => true),
  pullLineup: vi.fn(),
  curatedEntries: vi.fn(),
  listSet: vi.fn(),
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
  providerFor: () =>
    mocks.providerKind() === "plex"
      ? {
          kind: "plex",
          profileBinding: mocks.profileBinding,
          profileToken: mocks.profileToken,
          buckets: mocks.buckets,
          materialize: mocks.materialize,
          handoff: mocks.handoff,
        }
      : {
          kind: mocks.providerKind(),
          buckets: mocks.buckets,
          materialize: mocks.materialize,
          handoff: mocks.handoff,
          ...(mocks.hasCover()
            ? { cover: mocks.cover }
            : {}),
        },
}))
vi.mock("./providers/blocks.js", () => ({
  providerIdForSet: () => mocks.providerKind(),
}))
vi.mock("./providers/pullLineup.js", () => ({
  pullLineup: mocks.pullLineup,
  curatedEntries: mocks.curatedEntries,
}))
vi.mock("./queues.js", () => ({
  listSet: mocks.listSet,
  splitEntry: (value: Record<string, unknown>) => {
    const {
      ratingKey = null,
      title = null,
      ...extras
    } = value
    return { ratingKey, title, extras }
  },
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

import {
  CHOOSER_POSTER_MAX_BYTES,
  chooserPoster,
  pullItemId,
} from "./chooserPoster.js"

const image = (label: string) => ({
  buffer: Buffer.from(label),
  contentType: "image/jpeg",
})
const metadata = (value: Record<string, unknown>) => ({
  MediaContainer: { Metadata: [value] },
})
const jpeg = { format: "jpeg" }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.providerKind.mockReturnValue("plex")
  mocks.hasCover.mockReturnValue(true)
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
  mocks.listSet.mockResolvedValue([])
  mocks.plexGet.mockResolvedValue(
    metadata({
      type: "episode",
      grandparentRatingKey: "11",
    }),
  )
  mocks.thumb.mockResolvedValue(image("poster"))
  mocks.pullLineup.mockResolvedValue([])
  mocks.curatedEntries.mockResolvedValue([])
})

test("uses the queue profile and show poster without starting or persisting playback", async () => {
  expect(await chooserPoster("learning")).toEqual(
    image("poster"),
  )
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
  expect(mocks.thumb).toHaveBeenCalledWith("11", jpeg)
  expect(mocks.thumb).toHaveBeenCalledTimes(1)
  expect(mocks.materialize).not.toHaveBeenCalled()
  expect(mocks.handoff).not.toHaveBeenCalled()
})

test("a lineup head with no art falls through to the next lineup item", async () => {
  mocks.buckets.mockResolvedValue({
    play: [{ ratingKey: "42" }, { ratingKey: "43" }],
  })
  mocks.plexGet.mockImplementation(async (path: string) =>
    metadata(
      path.endsWith("/42")
        ? { type: "episode", grandparentRatingKey: "11" }
        : { type: "movie" },
    ),
  )
  mocks.thumb.mockImplementation(async (key: string) =>
    key === "11" ? null : image(`poster-${key}`),
  )
  expect(
    (await chooserPoster("learning"))?.buffer.toString(),
  ).toBe("poster-43")
  expect(mocks.thumb.mock.calls).toEqual([
    ["11", jpeg],
    ["43", jpeg],
  ])
})

test("an image over the cache cap counts as missing and the next item is used", async () => {
  mocks.buckets.mockResolvedValue({
    play: [{ ratingKey: "50" }, { ratingKey: "51" }],
  })
  mocks.plexGet.mockResolvedValue(
    metadata({ type: "show" }),
  )
  mocks.thumb.mockImplementation(async (key: string) =>
    key === "50"
      ? {
          buffer: Buffer.alloc(
            CHOOSER_POSTER_MAX_BYTES + 1,
          ),
          contentType: "image/jpeg",
        }
      : image("small"),
  )
  expect(
    (await chooserPoster("learning"))?.buffer.toString(),
  ).toBe("small")
})

test("a failing metadata read on one item moves on to the next", async () => {
  mocks.buckets.mockResolvedValue({
    play: [{ ratingKey: "60" }, { ratingKey: "61" }],
  })
  mocks.plexGet.mockImplementation(async (path: string) => {
    if (path.endsWith("/60")) throw new Error("timeout")
    return metadata({ type: "movie" })
  })
  expect(
    (await chooserPoster("learning"))?.buffer.toString(),
  ).toBe("poster")
  expect(mocks.thumb).toHaveBeenCalledWith("61", jpeg)
})

test("an empty lineup falls back to the queue's own entries, in file order", async () => {
  mocks.buckets.mockResolvedValue({ play: [] })
  mocks.listSet.mockResolvedValue([
    { key: "title:A", value: { title: "Untitled" } },
    { key: "rk:70", value: { ratingKey: "70" } },
    { key: "rk:71", value: { ratingKey: "71" } },
  ])
  mocks.plexGet.mockResolvedValue(
    metadata({ type: "show" }),
  )
  expect(
    (await chooserPoster("learning"))?.buffer.toString(),
  ).toBe("poster")
  expect(mocks.thumb.mock.calls).toEqual([["70", jpeg]])
  expect(mocks.materialize).not.toHaveBeenCalled()
})

test("a lineup that fails to build still falls back to the queue's entries", async () => {
  mocks.buckets.mockRejectedValue(new Error("Plex down"))
  mocks.listSet.mockResolvedValue([
    { key: "rk:80", value: { ratingKey: "80" } },
  ])
  mocks.plexGet.mockResolvedValue(
    metadata({ type: "movie" }),
  )
  expect(await chooserPoster("learning")).not.toBeNull()
  expect(mocks.thumb).toHaveBeenCalledWith("80", jpeg)
})

test("a queue with no art anywhere has no poster", async () => {
  mocks.buckets.mockResolvedValue({ play: [] })
  expect(await chooserPoster("learning")).toBeNull()
  expect(mocks.thumb).not.toHaveBeenCalled()
  mocks.buckets.mockResolvedValue({
    play: [{ ratingKey: "90" }],
  })
  mocks.listSet.mockResolvedValue([
    { key: "rk:91", value: { ratingKey: "91" } },
  ])
  mocks.thumb.mockResolvedValue(null)
  expect(await chooserPoster("learning")).toBeNull()
  expect(mocks.thumb).toHaveBeenCalledTimes(2)
})

test("the search for art is bounded and never repeats an item", async () => {
  mocks.buckets.mockResolvedValue({
    play: Array.from({ length: 20 }, (_value, index) => ({
      ratingKey: String(100 + (index % 12)),
    })),
  })
  mocks.plexGet.mockResolvedValue(
    metadata({ type: "movie" }),
  )
  mocks.thumb.mockResolvedValue(null)
  expect(await chooserPoster("learning")).toBeNull()
  expect(mocks.thumb).toHaveBeenCalledTimes(8)
  expect(
    new Set(mocks.thumb.mock.calls.map(([key]) => key))
      .size,
  ).toBe(8)
})

test("a filtered queue never borrows its parent's entries for art", async () => {
  const cfg = {
    id: "narrow",
    source: "queue",
    filtered_from: "wide",
  }
  mocks.getSet.mockResolvedValue(cfg)
  mocks.loadSets.mockReturnValue({ sets: { narrow: cfg } })
  mocks.buckets.mockResolvedValue({ play: [] })
  mocks.listSet.mockResolvedValue([
    { key: "rk:5", value: { ratingKey: "5" } },
  ])
  expect(await chooserPoster("narrow")).toBeNull()
  expect(mocks.listSet).not.toHaveBeenCalled()
})

test("shared-server keys stay scoped to that server and queue profile", async () => {
  mocks.buckets.mockResolvedValue({
    play: [{ ratingKey: "42", plexServer: "remote" }],
  })
  mocks.profileUser.mockResolvedValue({ uuid: "student" })
  mocks.access.mockResolvedValue({ id: "remote" })
  mocks.sharedGet.mockResolvedValue(
    metadata({
      type: "episode",
      grandparentRatingKey: "99",
    }),
  )
  mocks.sharedThumb.mockResolvedValue(image("shared"))
  await chooserPoster("learning")
  expect(mocks.access).toHaveBeenCalledWith(
    "student",
    "remote",
  )
  expect(mocks.sharedThumb).toHaveBeenCalledWith(
    { id: "remote" },
    "99",
    fetch,
    jpeg,
  )
  expect(mocks.thumb).not.toHaveBeenCalled()
})

test("a shared entry with no grant falls through to a home-server entry", async () => {
  mocks.buckets.mockResolvedValue({ play: [] })
  mocks.listSet.mockResolvedValue([
    {
      key: "server:remote:rk:1",
      value: { ratingKey: "1", plex_server: "remote" },
    },
    { key: "rk:2", value: { ratingKey: "2" } },
  ])
  mocks.profileUser.mockResolvedValue({ uuid: "student" })
  mocks.access.mockResolvedValue(null)
  mocks.plexGet.mockResolvedValue(
    metadata({ type: "movie" }),
  )
  expect(await chooserPoster("learning")).not.toBeNull()
  expect(mocks.sharedThumb).not.toHaveBeenCalled()
  expect(mocks.thumb).toHaveBeenCalledWith("2", jpeg)
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

test("a reading queue shows its lineup head's series cover, read-only", async () => {
  mocks.providerKind.mockReturnValue("kavita")
  mocks.pullLineup.mockResolvedValue([
    { chapterId: 900, seriesId: 31, title: "Chapter 1" },
    { chapterId: 901, seriesId: 32, title: "Chapter 1" },
  ])
  mocks.cover.mockResolvedValue({
    buffer: Buffer.from("series-31"),
    contentType: "image/png",
  })
  expect(
    (await chooserPoster("learning"))?.buffer.toString(),
  ).toBe("series-31")
  expect(mocks.pullLineup).toHaveBeenCalledWith(
    "learning",
    expect.objectContaining({ id: "learning" }),
    expect.objectContaining({ kind: "kavita" }),
    { isReadOnly: true },
  )
  expect(mocks.cover.mock.calls).toEqual([["31"]])
  expect(mocks.materialize).not.toHaveBeenCalled()
  expect(mocks.handoff).not.toHaveBeenCalled()
  expect(mocks.thumb).not.toHaveBeenCalled()
})

test("a reading queue whose head has no cover uses the next series", async () => {
  mocks.providerKind.mockReturnValue("kavita")
  mocks.pullLineup.mockResolvedValue([
    { chapterId: 900, seriesId: 31, title: "Chapter 1" },
    { chapterId: 901, seriesId: 31, title: "Chapter 2" },
    { chapterId: 902, seriesId: 32, title: "Chapter 1" },
  ])
  mocks.cover.mockImplementation(async (id: string) => {
    if (id === "31") throw new Error("HTTP 404")
    return {
      buffer: Buffer.from(`series-${id}`),
      contentType: "image/png",
    }
  })
  expect(
    (await chooserPoster("learning"))?.buffer.toString(),
  ).toBe("series-32")
  expect(mocks.cover.mock.calls).toEqual([["31"], ["32"]])
})

test("a fully read reading queue still shows a series cover from its entries", async () => {
  mocks.providerKind.mockReturnValue("kavita")
  mocks.pullLineup.mockResolvedValue([])
  mocks.curatedEntries.mockResolvedValue([
    { id: "44", placement: null, batch: null },
  ])
  mocks.cover.mockResolvedValue({
    buffer: Buffer.from("series-44"),
    contentType: "image/png",
  })
  expect(
    (await chooserPoster("learning"))?.buffer.toString(),
  ).toBe("series-44")
  // The default — no `isStampingQueued` — is the read-only one.
  expect(mocks.curatedEntries).toHaveBeenCalledWith(
    "learning",
  )
})

test("a provider without covers has no poster", async () => {
  mocks.providerKind.mockReturnValue("kavita")
  mocks.hasCover.mockReturnValue(false)
  mocks.pullLineup.mockResolvedValue([
    { chapterId: 1, seriesId: 2, title: "One" },
  ])
  expect(await chooserPoster("learning")).toBeNull()
  expect(mocks.pullLineup).not.toHaveBeenCalled()
})

test("each pull provider's cover is read by its own id", () => {
  expect(
    pullItemId({ chapterId: 1, seriesId: 7, title: "x" }),
  ).toBe("7")
  expect(pullItemId({ gameId: "g-3", title: "x" })).toBe(
    "g-3",
  )
  expect(pullItemId({ appid: "400", title: "x" })).toBe(
    "400",
  )
  expect(
    pullItemId({ path: "/games/one.rom", title: "x" }),
  ).toBe("/games/one.rom")
  expect(pullItemId({ ratingKey: "5" })).toBeNull()
})
