import { afterEach, describe, expect, test } from "vitest"

import { api } from "../lib/api"
import type { QueuesResponse } from "../lib/types"
import { getState, revalidate, setState } from "./store"

/**
 * PHASE 3 MUST NOT UNDO A WRITE IT COULD NOT HAVE SEEN.
 *
 * `revalidate()` asks for `/api/queues?fresh=1`, which re-reads Plex and Kavita and takes
 * about seven seconds. The answer describes the files as they were when the request went out.
 * A promote made inside that window is missing from it, and committing it anyway put the
 * entry back in the lane the user had just moved it out of — while `queues.yaml` kept the
 * move. It read as a tap that undid itself a second later, and it is what
 * `e2e/tile-menu-test` started failing on the day the cache landed
 * (decision `2026-08-27-a-revalidate-never-overwrites-a-write-it-did-not-see`).
 *
 * `fetch` is stubbed rather than `api()` mocked: the write counter lives inside `api()`, so a
 * mock of it would test the mock. The real one runs, and only the socket is fake.
 */
// `revalidate()` also refuses to commit mid-gesture, and that check reads the DOM — three
// search dropdowns owned by three components. These tests run in the `node` environment
// (`web/vitest.config.ts`), so one stub stands in for it; nothing here opens a dropdown.
globalThis.document = {
  querySelector: () => null,
} as unknown as Document

const payload = (label: string) =>
  ({
    sets: { bob: { items: [], label } },
  }) as unknown as QueuesResponse

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  setState({ data: null })
})

/** A `fetch` whose GET is held open until the returned `release` is called. */
const heldFetch = () => {
  let release: (body: unknown) => void = () => {}
  const held = new Promise<unknown>((resolve) => {
    release = resolve
  })

  globalThis.fetch = ((
    _url: string,
    init?: { method?: string },
  ) =>
    (init?.method ?? "GET") === "GET"
      ? held.then((body) => ({
          json: () => Promise.resolve(body),
          ok: true,
        }))
      : Promise.resolve({
          json: () => Promise.resolve({ ok: true }),
          ok: true,
        })) as unknown as typeof fetch

  return { release: (body: unknown) => release(body) }
}

describe("revalidate", () => {
  test("commits the fresh payload when nothing was written while it was in flight", async () => {
    const { release } = heldFetch()
    setState({ data: payload("cached") })

    const pass = revalidate()

    release(payload("fresh"))
    await pass

    expect(getState().data?.sets.bob?.label).toBe("fresh")
  })

  test("drops the payload when a write landed while it was in flight", async () => {
    const { release } = heldFetch()
    setState({ data: payload("cached") })

    const pass = revalidate()

    // The optimistic write: the store's own copy is already correct on screen, and the
    // request that persists it is what the counter sees.
    setState({ data: payload("the user's move") })
    await api(
      "PATCH",
      "/api/queues/bob/items/rk:1/placement",
      {
        placement: "random",
      },
    )

    release(payload("fresh"))
    await pass

    expect(getState().data?.sets.bob?.label).toBe(
      "the user's move",
    )
  })

  test("clears its progress flag either way", async () => {
    const { release } = heldFetch()
    const pass = revalidate()

    release(payload("fresh"))
    await pass

    expect(getState().isRevalidating).toBe(false)
  })
})
