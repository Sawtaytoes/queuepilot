import { beforeEach, expect, test, vi } from "vitest"

const ctl = vi.hoisted(() => ({
  route: { app: "queuepilot-tv", playsAs: "Older Kids" } as
    | { app: "queuepilot-tv"; playsAs: string }
    | { app: "plex"; reason: string },
  // eslint-disable-next-line @typescript-eslint/naming-convention -- the device-command result shape tvAppStart returns
  started: { ok: true } as { ok: boolean; error?: string },
  requests: [] as unknown[],
  starts: [] as string[],
  plexOpened: 0,
  buckets: 0,
  states: [] as Record<string, unknown>[],
  // The order of the steps that touch the Shield and the Plex server's log.
  steps: [] as string[],
  isFsm: true,
}))
vi.mock("./env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./env.js")>()),
  ADB_ENABLED: true,
  get PLAYBACK_FSM() {
    return ctl.isFsm
  },
}))
vi.mock("./mqttc.js", () => ({
  lastState: () => null,
  onNowPlaying: vi.fn(),
  offNowPlaying: vi.fn(),
}))
vi.mock("./engine/routing.js", () => ({
  loadSets: () => ({
    sets: {
      holiday: {
        id: "holiday",
        label: "Holiday",
        source: "queue",
        enabled: true,
        requires_profile: "Older Kids",
      },
    },
  }),
  bindingFor: () => ({}),
}))
vi.mock("./adb.js", () => ({
  ensurePlexOpen: async () => {
    ctl.plexOpened += 1
    ctl.steps.push("open Plex")
    return true
  },
  switchTo: async () => [false, "no picker in this test"],
}))
vi.mock("./playback.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("./playback.js")
  >()),
  currentAccount: async () => null,
}))
vi.mock("./profiles.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("./profiles.js")
  >()),
  // Nothing signs in, so each Plex path stops at its profile check.
  waitForProfile: async () => {
    ctl.steps.push("watch the Plex log")
    return null
  },
}))
vi.mock("./tvAppStart.js", () => ({
  routeStart: async (request: unknown) => {
    ctl.requests.push(request)
    return ctl.route
  },
  startInTvApp: async (setName: string) => {
    ctl.starts.push(setName)
    return ctl.started
  },
  closeBeforePlex: () => {
    ctl.steps.push("close QueuePilot TV")
    return true
  },
}))
vi.mock("./providers/index.js", () => ({
  providerFor: () => ({
    profileBinding: async (binding: object) => binding,
    buckets: async () => {
      ctl.buckets += 1
      throw new Error("stop here: the Plex path was taken")
    },
  }),
}))
vi.mock("./providers/profileToken.js", () => ({
  profileTokenOf: async () => "token",
}))

import {
  SESSION,
  setPublishers,
  startSession,
} from "./session.js"

beforeEach(() => {
  ctl.route = {
    app: "queuepilot-tv",
    playsAs: "Older Kids",
  }
  ctl.started = { ok: true }
  ctl.requests = []
  ctl.starts = []
  ctl.plexOpened = 0
  ctl.buckets = 0
  ctl.states = []
  ctl.steps = []
  ctl.isFsm = true
  // A Plex sitting is running when the card is tapped.
  SESSION.playQueueID = 42
  SESSION.queue = [{ ratingKey: "1" }]
  SESSION.set = "earlier"
  SESSION.queuedTotal = 1
  setPublishers({
    state: (extra) => {
      ctl.states.push(extra as Record<string, unknown>)
    },
  })
})

test("a card for a queue QueuePilot TV plays starts there, and never opens Plex", async () => {
  expect(
    await startSession({
      set: "holiday",
      kind: "picks",
      profile: "Older Kids",
    }),
  ).toEqual({
    ok: true,
    playback: {
      isDispatched: true,
      app: "queuepilot-tv",
      queue: "holiday",
    },
    set: "holiday",
    count: 0,
  })
  expect(ctl.requests).toEqual([
    {
      setName: "holiday",
      cfg: expect.objectContaining({ id: "holiday" }),
      isAuto: false,
      only: null,
      cardProfile: "Older Kids",
    },
  ])
  expect(ctl.starts).toEqual(["holiday"])
  expect(ctl.plexOpened).toBe(0)
  expect(ctl.buckets).toBe(0)
  expect(ctl.steps).toEqual([])
  // The app owns the sitting. No Plex sitting is left for advance or top-up to extend, or for
  // the Plex completion watcher to announce or reconcile.
  expect(SESSION.playQueueID).toBeNull()
  expect(SESSION.queue).toEqual([])
  expect(SESSION.set).toBeNull()
  expect(SESSION.device).toBeNull()
  expect(SESSION.queuedTotal).toBe(0)
  const last = ctl.states.at(-1)
  expect(last).toMatchObject({
    playback: { app: "queuepilot-tv", isDispatched: true },
    set: null,
  })
  // A dispatch is never reported as playing: the app may still ask for the TV PIN.
  expect(last?.playback).not.toHaveProperty("played")
})

test("a start the TV app refused is a stated error, not a silent Plex play", async () => {
  ctl.started = {
    ok: false,
    error: "QueuePilot TV did not come to the front",
  }
  expect(
    await startSession({
      set: "holiday",
      profile: "Older Kids",
    }),
  ).toEqual({ error: "queuepilot tv start" })
  expect(ctl.plexOpened).toBe(0)
  expect(
    ctl.states.some((state) =>
      String(state.error).includes(
        "'Holiday' could not start in QueuePilot TV",
      ),
    ),
  ).toBe(true)
})

test("a start routed to Plex opens Plex and takes the Plex path", async () => {
  ctl.route = { app: "plex", reason: "no remote start" }
  await expect(
    startSession({ set: "holiday", profile: "Older Kids" }),
  ).rejects.toThrow("the Plex path was taken")
  expect(ctl.starts).toEqual([])
  expect(ctl.plexOpened).toBe(1)
  expect(ctl.buckets).toBe(1)
  expect(ctl.steps).toEqual([
    "close QueuePilot TV",
    "open Plex",
  ])
})

// QueuePilot TV signs its Plex requests as a profile, from the Shield's address. Each Plex path
// closes it before Plex opens and before the log watch starts at the log's end, so no request
// the TV app makes can read as Plex signed into a profile.
test("set auto closes QueuePilot TV before it reads the profile from the Plex log", async () => {
  expect(await startSession({ set: "auto" })).toEqual({
    error: "no profile",
  })
  expect(ctl.steps).toEqual([
    "close QueuePilot TV",
    "open Plex",
    "watch the Plex log",
  ])
  expect(ctl.requests).toEqual([])
})

test("the log-based profile gate (PLAYBACK_FSM off) closes QueuePilot TV before it watches", async () => {
  ctl.isFsm = false
  ctl.route = { app: "plex", reason: "no remote start" }
  const result = await startSession({
    set: "holiday",
    profile: "Older Kids",
  })
  expect(result).not.toHaveProperty("ok")
  expect(ctl.steps).toEqual([
    "close QueuePilot TV",
    "open Plex",
    "watch the Plex log",
  ])
  expect(ctl.buckets).toBe(0)
})

test("a card whose profile disagrees with the queue is refused before any app is chosen", async () => {
  expect(
    await startSession({
      set: "holiday",
      profile: "Alice",
    }),
  ).toEqual({ error: "profile mismatch" })
  expect(ctl.requests).toEqual([])
  expect(ctl.plexOpened).toBe(0)
})
