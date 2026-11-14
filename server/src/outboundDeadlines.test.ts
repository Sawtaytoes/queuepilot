// Pins the 2026-11-13 decision: no process-wide TLS bypass, a self-signed LAN Plex is reached
// only through its scoped agent, and every outbound call carries a deadline.
import { readFileSync } from "node:fs"
import {
  afterEach,
  describe,
  expect,
  test,
  vi,
} from "vitest"

type UndiciCall = {
  url: string
  opts: { dispatcher?: unknown; signal?: unknown }
}
const undiciCalls = vi.hoisted(() => [] as UndiciCall[])
vi.mock("undici", async (original) => ({
  ...(await original<typeof import("undici")>()),
  request: vi.fn(
    async (url: string, opts: UndiciCall["opts"]) => {
      undiciCalls.push({ url, opts })
      const dump = async () => {}
      const metadata = /\/library\/metadata\/(\d+)$/.exec(
        url,
      )
      if (metadata) {
        const body = {
          MediaContainer: {
            Metadata: [
              {
                thumb: `/library/metadata/${metadata[1]}/thumb/1`,
              },
            ],
          },
        }
        return {
          statusCode: 200,
          headers: {},
          body: { json: async () => body, dump },
        }
      }
      const transcode =
        /\/photo\/:\/transcode.*metadata%2F(\d+)%2F/.exec(
          url,
        )
      // Item 7: the transcode fails, so the raw art fallback is exercised as well.
      if (transcode?.[1] === "7")
        return {
          statusCode: 500,
          headers: {},
          body: { dump },
        }
      // Item 8: a redirect that stays on PLEX_URL. Item 9: a redirect to another origin.
      if (transcode?.[1] === "8") {
        return {
          statusCode: 302,
          headers: { location: "/redirected/poster-8.png" },
          body: { dump },
        }
      }
      if (transcode?.[1] === "9") {
        return {
          statusCode: 302,
          headers: {
            location:
              "https://cdn.example.net/poster-9.png",
          },
          body: { dump },
        }
      }
      return {
        statusCode: 200,
        headers: { "content-type": "image/png" },
        body: {
          arrayBuffer: async () =>
            new Uint8Array([1, 2, 3]).buffer,
        },
      }
    },
  ),
}))

import { PLEX_URL } from "./config.js"
import { thumb } from "./plex.js"
import { plextv } from "./plexTv.js"
import { boardGamesHttpClient } from "./providers/board-game-picker-client.js"
import { kavitaClient } from "./providers/kavita-client.js"
import { misterClient } from "./providers/mister-client.js"
import { steamClient } from "./providers/steam-client.js"

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  })

afterEach(() => {
  vi.unstubAllGlobals()
  undiciCalls.length = 0
})

describe("TLS", () => {
  test("the runtime image sets no process-wide certificate bypass", () => {
    const dockerfile = readFileSync(
      new URL("../../Dockerfile", import.meta.url),
      "utf8",
    )
    const settings = dockerfile
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
    expect(settings.join("\n")).not.toMatch(
      /NODE_TLS_REJECT_UNAUTHORIZED/,
    )
  })

  test("the cast sidecar checks the Plex certificate", () => {
    const sidecar = readFileSync(
      new URL("../../cast_sidecar/service.py", import.meta.url),
      "utf8",
    )
    const code = sidecar
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n")
    // CI has no Python, so this reads the source. It refuses every way the
    // sidecar could turn the check off: any line that pairs `verify` with
    // `False` (`verify=False`, `.verify = False`, `setattr(s, "verify",
    // False)`), an unverified SSL context, and a session handed to PlexServer
    // in place of plexapi's own verifying one.
    expect(code).not.toMatch(/verify[^\n]*False/)
    expect(code).not.toMatch(/CERT_NONE|_create_unverified_context/)
    expect(code).not.toMatch(/PlexServer\([^)]*session\s*=/)
  })

  test("poster reads from PLEX_URL go through the scoped Plex agent, with a deadline", async () => {
    const poster = await thumb("7")
    expect(poster?.contentType).toBe("image/png")
    expect(poster?.buffer).toEqual(Buffer.from([1, 2, 3]))
    const posterCalls = undiciCalls.filter(
      (c) => !c.url.endsWith("/library/metadata/7"),
    )
    expect(
      posterCalls.map((c) =>
        c.url.includes("/photo/:/transcode"),
      ),
    ).toEqual([true, false])
    const plexAgent = undiciCalls[0]!.opts.dispatcher
    expect(plexAgent).toBeDefined()
    for (const call of posterCalls) {
      expect(call.opts.dispatcher).toBe(plexAgent)
      expect(call.opts.signal).toBeInstanceOf(AbortSignal)
    }
  })

  test("a poster redirect on PLEX_URL keeps the scoped agent", async () => {
    const poster = await thumb("8")
    expect(poster?.buffer).toEqual(Buffer.from([1, 2, 3]))
    const hop = undiciCalls.at(-1)!
    expect(hop.url).toBe(
      `${new URL(PLEX_URL).origin}/redirected/poster-8.png`,
    )
    expect(hop.opts.dispatcher).toBe(
      undiciCalls[0]!.opts.dispatcher,
    )
    expect(hop.opts.signal).toBeInstanceOf(AbortSignal)
  })

  test("a poster redirect to another origin leaves the scoped agent for verified fetch", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(new Uint8Array([9]), {
          headers: { "content-type": "image/webp" },
        }),
    )
    vi.stubGlobal("fetch", fetchMock)
    const poster = await thumb("9")
    expect(poster).toEqual({
      contentType: "image/webp",
      buffer: Buffer.from([9]),
    })
    expect(
      undiciCalls.some((c) =>
        c.url.includes("cdn.example.net"),
      ),
    ).toBe(false)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://cdn.example.net/poster-9.png")
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(
      (init as { dispatcher?: unknown }).dispatcher,
    ).toBeUndefined()
  })
})

describe("every outbound call has a deadline", () => {
  test("plex.tv uses the one shared helper, verified TLS, and a timeout", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        jsonResponse({ ok: 1 }),
    )
    vi.stubGlobal("fetch", fetchMock)
    await expect(
      plextv("/api/v2/devices", "fixture-token"),
    ).resolves.toEqual({ ok: 1 })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://plex.tv/api/v2/devices")
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    // No custom dispatcher: plex.tv must never borrow the LAN agent's rejectUnauthorized:false.
    expect(
      (init as { dispatcher?: unknown }).dispatcher,
    ).toBeUndefined()
  })

  test("Kavita: auth, API calls and covers", async () => {
    const fetchImpl = vi.fn(
      async (url: string, _init?: RequestInit) =>
        url.includes("/authenticate")
          ? jsonResponse({ token: "jwt", username: "Ada" })
          : jsonResponse({ id: 1 }),
    )
    const client = kavitaClient({
      baseUrl: "https://kavita.example.com",
      apiKey: "k",
      fetchImpl,
    })
    await client.series(1)
    await client.cover(1)
    expect(fetchImpl.mock.calls.length).toBe(3)
    for (const [, init] of fetchImpl.mock.calls)
      expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  test("MiSTer: the API", async () => {
    const fetchImpl = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        jsonResponse({ data: [] }),
    )
    await misterClient({
      baseUrl: "http://mister.example.com",
      fetchImpl,
    }).search("zelda")
    expect(
      fetchImpl.mock.calls[0]![1]?.signal,
    ).toBeInstanceOf(AbortSignal)
  })

  test("board-game picker: the API and covers", async () => {
    const fetchImpl = vi.fn(
      async (url: string, _init?: RequestInit) =>
        url.endsWith(".png")
          ? new Response(new Uint8Array([1]))
          : jsonResponse({
              id: "g1",
              imagePath: "/images/g1.png",
            }),
    )
    await boardGamesHttpClient({
      baseUrl: "https://picker.example.com",
      fetchImpl,
    }).cover("g1")
    expect(fetchImpl.mock.calls.length).toBe(2)
    for (const [, init] of fetchImpl.mock.calls)
      expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  test("Steam: the owned-games read", async () => {
    const fetchImpl = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        jsonResponse({ response: { games: [] } }),
    )
    await steamClient({
      apiKey: "k",
      steamId: "1",
      fetchImpl,
    }).library()
    expect(
      fetchImpl.mock.calls[0]![1]?.signal,
    ).toBeInstanceOf(AbortSignal)
  })
})
