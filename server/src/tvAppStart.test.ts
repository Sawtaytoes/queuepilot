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
  // QueuePilot TV's process: whether it runs, whether the probe fails, and whether a stop ends it.
  isTvAppAlive: false,
  isProbeBroken: false,
  isStopIgnored: false,
  // `dumpsys activity activities` answers, one per read; the last one repeats.
  dumps: [] as (string | null)[],
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
    const line = args.join(" ")
    if (line.includes("pidof")) {
      if (ctl.isProbeBroken) return null
      return ctl.isTvAppAlive
        ? "4242\nprobe-done\n"
        : "probe-done\n"
    }
    if (line.includes("dumpsys activity activities"))
      return ctl.dumps.length > 1
        ? (ctl.dumps.shift() ?? null)
        : (ctl.dumps[0] ?? null)
    if (args.includes("force-stop")) {
      if (!ctl.isStopIgnored) ctl.isTvAppAlive = false
      return ""
    }
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
  closeAfterPlexOpens,
  hasTvAppStopped,
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
  ctl.isTvAppAlive = false
  ctl.isProbeBroken = false
  ctl.isStopIgnored = false
  ctl.dumps = []
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

// The shape of Android 11's `dumpsys activity activities` on a Shield, cut to the lines read.
const dumpWith = (
  tvState: string,
): string => `ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)
  * Task{a1 #12 visible=true type=standard A=10090:com.plexapp.android U=0 sz=1}
      * Hist #0: ActivityRecord{b1 u0 com.plexapp.android/.MainActivityDefault t12}
          packageName=com.plexapp.android processName=com.plexapp.android
          state=RESUMED stopped=false delayedResume=false finishing=false
  * Task{a2 #11 visible=false type=standard A=10018:${TV_APP_PACKAGE} U=0 sz=1}
      * Hist #0: ActivityRecord{b2 u0 ${TV_APP_PACKAGE}/dev.queuepilot.player.MainActivity t11}
          packageName=${TV_APP_PACKAGE} processName=${TV_APP_PACKAGE}
          state=${tvState} stopped=${tvState === "STOPPED"} delayedResume=false finishing=false
`
const forceStops = (): number =>
  ctl.calls.filter((args) => args.includes("force-stop"))
    .length
const fast = { stopWaitMs: 60, pollMs: 5 }

describe("hasTvAppStopped", () => {
  test.each([
    ["STOPPED", true],
    ["DESTROYED", true],
    ["STOPPING", false],
    ["PAUSED", false],
    ["RESUMED", false],
  ])(
    "reads QueuePilot TV in %s, whatever Plex is in",
    (state, isStopped) => {
      expect(hasTvAppStopped(dumpWith(state))).toBe(
        isStopped,
      )
    },
  )
  test("an unreadable dump is not read as stopped", () => {
    expect(hasTvAppStopped(null)).toBeNull()
    expect(hasTvAppStopped("Error: no service")).toBeNull()
  })
})

describe("closeAfterPlexOpens", () => {
  test("stops QueuePilot TV only after it finished onStop, then checks it is gone", async () => {
    ctl.isTvAppAlive = true
    ctl.dumps = [
      dumpWith("PAUSED"),
      dumpWith("STOPPING"),
      dumpWith("STOPPED"),
    ]
    expect(await closeAfterPlexOpens(fast)).toBe("closed")
    expect(forceStops()).toBe(1)
    expect(ctl.dumps).toEqual([dumpWith("STOPPED")])
    expect(ctl.calls.at(-1)?.join(" ")).toContain("pidof")
  })
  test("never ends an app that has not saved: it is left running, and the log is not trusted", async () => {
    ctl.isTvAppAlive = true
    ctl.dumps = [dumpWith("RESUMED")]
    expect(await closeAfterPlexOpens(fast)).toBe("unknown")
    expect(forceStops()).toBe(0)
  })
  test("a stop that leaves the process running is not trusted", async () => {
    ctl.isTvAppAlive = true
    ctl.isStopIgnored = true
    ctl.dumps = [dumpWith("STOPPED")]
    expect(await closeAfterPlexOpens(fast)).toBe("unknown")
    expect(forceStops()).toBe(1)
  })
  test("a failed process probe is not read as no process", async () => {
    ctl.isProbeBroken = true
    expect(await closeAfterPlexOpens(fast)).toBe("unknown")
    expect(forceStops()).toBe(0)
  })
  test("an unreadable activity dump is not read as stopped", async () => {
    ctl.isTvAppAlive = true
    ctl.dumps = [null]
    expect(await closeAfterPlexOpens(fast)).toBe("unknown")
    expect(forceStops()).toBe(0)
  })
  test("a Shield with no QueuePilot TV process is left alone", async () => {
    expect(await closeAfterPlexOpens(fast)).toBe("absent")
    expect(forceStops()).toBe(0)
  })
  test("with no ADB to the Shield, nothing can be known", async () => {
    ctl.connected = false
    expect(await closeAfterPlexOpens(fast)).toBe(
      "unverified",
    )
    expect(ctl.calls).toEqual([])
  })
})
