import { describe, expect, test } from "vitest"
import {
  plexServerSearch,
  plexServerThumb,
  plexSourcesForToken,
} from "./plexSources.js"

const reply = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })

describe("Plex source discovery", () => {
  test("lists only the account grants and uses each remote server token", async () => {
    const requests: {
      url: string
      token: string | null
    }[] = []
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input)
      const token = new Headers(init?.headers).get(
        "X-Plex-Token",
      )
      requests.push({ url, token })
      if (url.startsWith("https://plex.tv/"))
        return reply([
          {
            name: "Home",
            clientIdentifier: "home-id",
            provides: "server",
            owned: true,
            accessToken: "home-grant",
            connections: [{ uri: "https://home.example" }],
          },
          {
            name: "Friend",
            clientIdentifier: "friend-id",
            provides: "server",
            owned: false,
            accessToken: "friend-grant",
            connections: [
              { uri: "https://offline.example" },
              { uri: "https://friend.example" },
            ],
          },
          {
            name: "Phone",
            clientIdentifier: "phone-id",
            provides: "player",
          },
        ])
      if (url.startsWith("https://offline.example/"))
        throw new Error("unreachable")
      if (url.startsWith("https://home.example/"))
        return reply({
          MediaContainer: {
            Directory: [
              { key: "1", title: "Movies", type: "movie" },
            ],
          },
        })
      if (url.startsWith("https://friend.example/"))
        return reply({
          MediaContainer: {
            Directory: [
              { key: "1", title: "Shows", type: "show" },
              { key: "2", title: "Music", type: "artist" },
            ],
          },
        })
      throw new Error(`unexpected ${url}`)
    }) as typeof fetch

    const sources = await plexSourcesForToken(
      "selected-account",
      { fetchImpl },
    )
    expect(sources).toEqual([
      {
        id: "home-id",
        name: "Home",
        owned: true,
        available: true,
        libraries: [
          { id: "1", title: "Movies", type: "movie" },
        ],
      },
      {
        id: "friend-id",
        name: "Friend",
        owned: false,
        available: true,
        libraries: [
          { id: "1", title: "Shows", type: "show" },
        ],
      },
    ])
    expect(
      requests.find((request) =>
        request.url.startsWith("https://plex.tv/"),
      )?.token,
    ).toBe("selected-account")
    expect(
      requests.find((request) =>
        request.url.startsWith("https://friend.example/"),
      )?.token,
    ).toBe("friend-grant")
    expect(JSON.stringify(sources)).not.toContain("grant")
    expect(JSON.stringify(sources)).not.toContain(
      "friend.example",
    )
  })

  test("does not use the admin token for a shared server without a grant", async () => {
    const requests: string[] = []
    const fetchImpl = (async (
      input: string | URL | Request,
    ) => {
      requests.push(String(input))
      return reply([
        {
          name: "Friend",
          clientIdentifier: "friend-id",
          provides: "server",
          owned: false,
          connections: [{ uri: "https://friend.example" }],
        },
      ])
    }) as typeof fetch
    expect(
      await plexSourcesForToken("selected-account", {
        fetchImpl,
      }),
    ).toEqual([
      {
        id: "friend-id",
        name: "Friend",
        owned: false,
        available: false,
        libraries: [],
      },
    ])
    expect(requests).toHaveLength(1)
  })
})

describe("shared Plex search", () => {
  test("uses the server grant, limits the search to allowed libraries, and scopes each hit", async () => {
    const requests: {
      url: string
      token: string | null
    }[] = []
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      requests.push({
        url: String(input),
        token: new Headers(init?.headers).get(
          "X-Plex-Token",
        ),
      })
      return reply({
        MediaContainer: {
          Metadata: [
            {
              ratingKey: "42",
              title: "Fixture Film",
              year: 2001,
              type: "movie",
              thumb: "/thumb/42",
            },
          ],
        },
      })
    }) as typeof fetch
    const access = {
      id: "friend-id",
      name: "Friend",
      baseUrl: "https://friend.example",
      token: "friend-grant",
      libraries: [
        {
          id: "7",
          title: "Shared Movies",
          type: "movie" as const,
        },
      ],
    }

    const hits = await plexServerSearch(
      access,
      ["7", "999"],
      "Fixture",
      fetchImpl,
    )

    expect(hits).toEqual([
      expect.objectContaining({
        ratingKey: "42",
        title: "Fixture Film",
        sectionId: 7,
        plexServer: "friend-id",
        plexServerName: "Friend",
      }),
    ])
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toContain(
      "/library/sections/7/all?title=Fixture",
    )
    expect(requests[0]?.token).toBe("friend-grant")
  })
})

describe("shared-server posters", () => {
  const access = {
    id: "remote",
    name: "Remote",
    baseUrl: "https://remote.example",
    token: "remote-grant",
    libraries: [],
  }
  const serve = (isTranscodeOk: boolean) => {
    const urls: string[] = []
    const fetchImpl = (async (
      input: string | URL | Request,
    ) => {
      const url = String(input)
      urls.push(url)
      if (url.includes("/library/metadata/"))
        return reply({
          MediaContainer: {
            Metadata: [{ thumb: "/art/7/poster" }],
          },
        })
      if (url.includes("/photo/:/transcode"))
        return isTranscodeOk
          ? new Response("small", {
              headers: { "Content-Type": "image/jpeg" },
            })
          : new Response(null, { status: 500 })
      return new Response("raw", {
        headers: { "Content-Type": "image/png" },
      })
    }) as typeof fetch
    return { urls, fetchImpl }
  }

  test("a JPEG request reads that server's transcoder, and the token stays in a header", async () => {
    const { urls, fetchImpl } = serve(true)
    const image = await plexServerThumb(
      access,
      "7",
      fetchImpl,
      {
        format: "jpeg",
      },
    )
    expect(image?.buffer.toString()).toBe("small")
    expect(urls[1]).toContain(
      "https://remote.example/photo/:/transcode?",
    )
    expect(urls[1]).toContain("format=jpeg")
    expect(urls.join(" ")).not.toContain("remote-grant")
  })

  test("a failed transcode falls back to the raw thumb", async () => {
    const { urls, fetchImpl } = serve(false)
    const image = await plexServerThumb(
      access,
      "7",
      fetchImpl,
      {
        format: "jpeg",
      },
    )
    expect(image?.buffer.toString()).toBe("raw")
    expect(urls.at(-1)).toBe(
      "https://remote.example/art/7/poster",
    )
  })

  test("without a format the raw thumb is read, as before", async () => {
    const { urls, fetchImpl } = serve(true)
    expect(
      (
        await plexServerThumb(access, "7", fetchImpl)
      )?.buffer.toString(),
    ).toBe("raw")
    expect(
      urls.some((url) => url.includes("transcode")),
    ).toBe(false)
  })
})
