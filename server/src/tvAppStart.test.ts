import {
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest"

const ctl = vi.hoisted(() => ({
  connected: true,
  awake: true as boolean | null,
  resolveOutput: "" as string | null,
  startOutput: "Starting: Intent { }" as string | null,
  foreground: "",
  profile: null as unknown,
  refusal: null as string | null,
  authorized: [] as unknown[][],
  calls: [] as string[][],
  pressed: [] as string[],
  pid: "" as string | null,
}))
vi.mock("./env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./env.js")>()),
  ADB_ENABLED: true,
  ADB_TARGET: "192.0.2.30:5555",
  TV_APP_START: true,
}))
vi.mock("./adb.js", () => ({
  connect: () => ctl.connected,
  isAwake: () => ctl.awake,
  press: async (key: string) => {
    ctl.pressed.push(key)
    return true
  },
  foregroundActivity: () => ctl.foreground,
  run: (args: string[]) => {
    ctl.calls.push(args)
    if (args.includes("resolve-activity"))
      return ctl.resolveOutput
    if (args.includes("pidof")) return ctl.pid
    if (args.includes("force-stop")) return ""
    if (args.includes("am")) {
      ctl.foreground =
        "dev.queuepilot.player.prototype/dev.queuepilot.player.MainActivity"
      return ctl.startOutput
    }
    return ""
  },
}))
vi.mock("./nativeAccess.js", () => ({
  authorizeQueue: async (...args: unknown[]) => {
    ctl.authorized.push(args)
    if (ctl.refusal) throw new Error(ctl.refusal)
    return { profile: ctl.profile }
  },
}))
// The provider's KIND decides, as in `authorizeQueue`: `library-two` is a second Plex server.
vi.mock("./providers/index.js", () => ({
  providerFor: (id: string) => ({
    kind: id === "kavita" ? "kavita" : "plex",
  }),
}))

import {
  closeBeforePlex,
  profileRoute,
  queueRefusal,
  routeStart,
  startInTvApp,
  TV_APP_PACKAGE,
  TV_APP_QUEUE_EXTRA,
  TV_APP_START_ACTION,
} from "./tvAppStart.js"
import type { RoutingSetCfg } from "./types.js"

const owner = {
  id: 1,
  uuid: null,
  admin: true,
  restricted: false,
  name: "Alice",
  username: "alice",
}
const kids = {
  id: 7,
  uuid: "kids-uuid",
  admin: false,
  restricted: true,
  name: "Older Kids",
  username: "",
}
const gated = {
  source: "queue",
  enabled: true,
  requires_profile: "Older Kids",
} as unknown as RoutingSetCfg
const kavita = {
  source: "queue",
  enabled: true,
  providers: [{ provider: "kavita", library: "1" }],
} as unknown as RoutingSetCfg
const secondPlexServer = {
  source: "queue",
  enabled: true,
  providers: [{ provider: "library-two", library: "1" }],
} as unknown as RoutingSetCfg
const request = (
  overrides: Partial<Parameters<typeof queueRefusal>[0]>,
): Parameters<typeof queueRefusal>[0] => ({
  setName: "holiday",
  cfg: gated,
  isAuto: false,
  only: null,
  cardProfile: null,
  ...overrides,
})
const resolved = `priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false\n${TV_APP_PACKAGE}/dev.queuepilot.player.MainActivity\n`

beforeEach(() => {
  ctl.connected = true
  ctl.awake = true
  ctl.resolveOutput = resolved
  ctl.startOutput = "Starting: Intent { }"
  ctl.foreground = ""
  ctl.profile = kids
  ctl.refusal = null
  ctl.authorized = []
  ctl.calls = []
  ctl.pressed = []
  ctl.pid = ""
})

describe("which starts QueuePilot TV can take", () => {
  test("a named Plex queue, including one on a Plex server with its own provider id", () => {
    expect(queueRefusal(request({}))).toBeNull()
    expect(
      queueRefusal(request({ cfg: secondPlexServer })),
    ).toBeNull()
  })
  test.each([
    ["set auto", { isAuto: true }],
    ["a single-entry start", { only: "rk:1" }],
    ["a non-Plex queue", { cfg: kavita }],
    [
      "a queue that mixes providers",
      {
        cfg: {
          source: "queue",
          providers: [
            { provider: "plex", library: "1" },
            { provider: "kavita", library: "2" },
          ],
        } as unknown as RoutingSetCfg,
      },
    ],
    ["an id a shell would read", { setName: "a;reboot" }],
    ["an id with a space", { setName: "a b" }],
  ])("%s stays on Plex", (_name, overrides) => {
    expect(queueRefusal(request(overrides))).toEqual(
      expect.any(String),
    )
  })
})

describe("the card's profile", () => {
  test("agrees by the profile's title", () => {
    expect(profileRoute(kids, "Older Kids")).toEqual({
      app: "queuepilot-tv",
      playsAs: "Older Kids",
    })
  })
  test("agrees with the owner by username", () => {
    expect(profileRoute(owner, "alice")).toEqual({
      app: "queuepilot-tv",
      playsAs: "Alice",
    })
  })
  test("a card with no profile plays as the queue's own profile", () => {
    expect(profileRoute(owner, null).app).toBe(
      "queuepilot-tv",
    )
  })
  test("another profile than the queue plays as stays on Plex", () => {
    const route = profileRoute(owner, "Older Kids")
    expect(route.app).toBe("plex")
    expect(route).toMatchObject({
      reason: expect.stringContaining("'Older Kids'"),
    })
  })
})

describe("routeStart asks the Shield, then the native API", () => {
  test("routes to QueuePilot TV when Android resolves the start action and the TV may play it", async () => {
    expect(
      await routeStart(
        request({ cardProfile: "Older Kids" }),
      ),
    ).toEqual({
      app: "queuepilot-tv",
      playsAs: "Older Kids",
    })
    expect(ctl.calls[0]).toEqual([
      "shell",
      "cmd",
      "package",
      "resolve-activity",
      "--brief",
      "-a",
      TV_APP_START_ACTION,
      "-c",
      "android.intent.category.DEFAULT",
      "-p",
      TV_APP_PACKAGE,
    ])
    // No device: the TV PIN is asked by the TV itself when it starts the queue.
    expect(ctl.authorized).toEqual([["holiday", null]])
  })
  test("a queue the native API refuses stays on Plex, with the reason", async () => {
    ctl.refusal =
      "This queue's Plex binding does not match its profile"
    const route = await routeStart(request({}))
    expect(route.app).toBe("plex")
    expect(route).toMatchObject({
      reason: expect.stringContaining(
        "binding does not match",
      ),
    })
  })
  test.each([
    ["an older build", "No activity found\n"],
    ["no QueuePilot TV", null],
  ])(
    "%s keeps Plex and never asks the native API",
    async (_name, output) => {
      ctl.resolveOutput = output
      expect((await routeStart(request({}))).app).toBe(
        "plex",
      )
      expect(ctl.authorized).toEqual([])
    },
  )
  test("an unreachable Shield keeps Plex and reads nothing else", async () => {
    ctl.connected = false
    expect((await routeStart(request({}))).app).toBe("plex")
    expect(ctl.calls).toEqual([])
    expect(ctl.authorized).toEqual([])
  })
  test("a refused request never asks the Shield", async () => {
    expect(
      (await routeStart(request({ isAuto: true }))).app,
    ).toBe("plex")
    expect(ctl.calls).toEqual([])
  })
})

describe("startInTvApp", () => {
  test("sends the queue id in the start intent and waits for the app to be in front", async () => {
    expect(await startInTvApp("holiday")).toEqual({
      ok: true,
    })
    expect(ctl.calls.at(-1)).toEqual([
      "shell",
      "am",
      "start",
      "-a",
      TV_APP_START_ACTION,
      "-c",
      "android.intent.category.DEFAULT",
      "-p",
      TV_APP_PACKAGE,
      "--es",
      TV_APP_QUEUE_EXTRA,
      "holiday",
      "--activity-clear-top",
      "--activity-single-top",
    ])
    expect(ctl.pressed).toEqual([])
  })
  test("wakes a sleeping Shield first", async () => {
    ctl.awake = false
    expect((await startInTvApp("holiday")).ok).toBe(true)
    expect(ctl.pressed).toEqual(["KEYCODE_WAKEUP"])
  })
  test("a start cancelled during the wake never reaches the TV", async () => {
    ctl.awake = false
    let isCancelled = false
    const pending = startInTvApp(
      "holiday",
      () => isCancelled,
    )
    isCancelled = true
    expect((await pending).ok).toBe(false)
    expect(ctl.pressed).toEqual(["KEYCODE_WAKEUP"])
    expect(
      ctl.calls.some((args) => args.includes("am")),
    ).toBe(false)
  })
  test("never sends an id a shell would read", async () => {
    expect((await startInTvApp("a$(x)")).ok).toBe(false)
    expect(ctl.calls).toEqual([])
  })
  test("reports an intent Android refused", async () => {
    ctl.startOutput =
      "Error: Activity not started, unable to resolve Intent"
    expect(await startInTvApp("holiday")).toEqual({
      ok: false,
      error: "QueuePilot TV did not accept the start",
    })
  })
})

describe("closeBeforePlex", () => {
  test("stops a running QueuePilot TV", () => {
    ctl.pid = "4242\n"
    expect(closeBeforePlex()).toBe(true)
    expect(ctl.calls.at(-1)).toEqual([
      "shell",
      "am",
      "force-stop",
      TV_APP_PACKAGE,
    ])
  })
  test.each([
    ["not running", ""],
    ["not installed", null],
  ])(
    "leaves the Shield alone when the app is %s",
    (_name, pid) => {
      ctl.pid = pid
      expect(closeBeforePlex()).toBe(false)
      expect(
        ctl.calls.some((args) =>
          args.includes("force-stop"),
        ),
      ).toBe(false)
    },
  )
  test("does nothing when the Shield is unreachable", () => {
    ctl.connected = false
    expect(closeBeforePlex()).toBe(false)
    expect(ctl.calls).toEqual([])
  })
})
