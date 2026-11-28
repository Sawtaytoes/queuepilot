/**
 * A card or chooser start that plays in QueuePilot TV instead of Plex.
 *
 * Decision `2026-11-28-a-card-start-plays-in-queuepilot-tv-when-the-shield-has-it-and-plex-otherwise`.
 * The rule, in order:
 *
 *  1. **Only a named Plex queue.** `set: "auto"` reads the profile Plex is signed into, and a
 *     web "play this entry" names an entry the TV's start does not take, so both stay on Plex.
 *     QueuePilot TV plays Plex-provider queues only.
 *  2. **Only on a Shield whose QueuePilot TV build accepts a remote start.** Asked of Android
 *     itself (`cmd package resolve-activity` for the start action), so an older build that would
 *     only open its Home screen is never sent one.
 *  3. **Only when the TV would play it, as the card asks.** The answer is the native API's own
 *     `authorizeQueue()`, so routing can never disagree with what the TV is then allowed to do.
 *     QueuePilot TV plays every queue as the queue's OWN profile. A card that names another
 *     profile for a queue with no `requires_profile` asks Plex to play it as that profile, and
 *     the TV cannot, so Plex keeps it. History lands where the card says either way.
 *
 * The server sends the queue id and nothing else. The TV app starts its own native session
 * with its own household-device token, and a queue locked on the TV still asks for the PIN on
 * the screen. A remote start cannot do anything a person with the remote cannot.
 */

import * as adb from "./adb.js"
import { adbTarget } from "./deviceScope.js"
import { ADB_ENABLED, TV_APP_START } from "./env.js"
import { authorizeQueue } from "./nativeAccess.js"
import type * as plex from "./plex.js"
import { providerIdForSet } from "./providers/blocks.js"
import { providerFor } from "./providers/index.js"
import type { RoutingSetCfg } from "./types.js"

export const TV_APP_PACKAGE =
  "dev.queuepilot.player.prototype"
export const TV_APP_START_ACTION =
  "dev.queuepilot.player.action.START_QUEUE"
export const TV_APP_QUEUE_EXTRA =
  "dev.queuepilot.player.extra.QUEUE_ID"

/**
 * The only ids sent over `adb shell`, which joins its arguments into one remote shell line.
 * Every registry id is letters, digits and underscores today; anything else stays on Plex
 * rather than being quoted.
 */
const SAFE_QUEUE_ID = /^[A-Za-z0-9_-]{1,128}$/

export type TvAppRoute =
  | { app: "queuepilot-tv"; playsAs: string }
  | { app: "plex"; reason: string }

export interface TvAppStartRequest {
  setName: string
  cfg: RoutingSetCfg
  isAuto: boolean
  only: string | null
  cardProfile: string | null
}

const plexRoute = (reason: string): TvAppRoute => ({
  app: "plex",
  reason,
})

/** Rule 1: a start QueuePilot TV can take at all, before anything is read. Null when it can. */
export function queueRefusal(
  request: TvAppStartRequest,
): string | null {
  if (request.isAuto)
    return "set auto reads the profile Plex is signed into"
  if (request.only)
    return "a single-entry start plays in Plex"
  if (!SAFE_QUEUE_ID.test(request.setName))
    return "the queue id has characters a remote start does not send"
  let kind: string | undefined
  try {
    // The provider's KIND, as `authorizeQueue` asks it: a custom id can still be a Plex server.
    kind = providerFor(
      providerIdForSet({ ...request.cfg }),
    ).kind
  } catch {
    // A queue that mixes providers has no single handoff; Plex's path states why.
    kind = undefined
  }
  if (kind !== "plex")
    return "QueuePilot TV plays Plex queues only"
  return null
}

/**
 * Rule 3's card half: the card's profile, when it names one, is the profile the queue plays as,
 * by its title or (for the owner) its username.
 */
export function profileRoute(
  playsAs: plex.HomeUser,
  cardProfile: string | null,
): TvAppRoute {
  const name = playsAs.name || playsAs.username || ""
  if (
    cardProfile &&
    ![playsAs.name, playsAs.username].includes(cardProfile)
  )
    return plexRoute(
      `the card asks for '${cardProfile}', and QueuePilot TV plays this queue as '${name}'`,
    )
  return { app: "queuepilot-tv", playsAs: name }
}

/**
 * Rule 2: does the target Shield have a QueuePilot TV build that takes a remote start?
 * One `cmd package` read, about 300 ms. False whenever ADB cannot answer.
 */
export function tvAppAcceptsRemoteStart(): boolean {
  if (!ADB_ENABLED || !adbTarget() || !adb.connect())
    return false
  const out = adb.run([
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
  return out?.includes(`${TV_APP_PACKAGE}/`) === true
}

/** The whole routing decision for one start, cheapest check first. */
export async function routeStart(
  request: TvAppStartRequest,
): Promise<TvAppRoute> {
  if (!TV_APP_START) return plexRoute("TV_APP_START is off")
  const refusal = queueRefusal(request)
  if (refusal) return plexRoute(refusal)
  if (!tvAppAcceptsRemoteStart())
    return plexRoute(
      "the Shield has no QueuePilot TV build that takes a remote start",
    )
  let playsAs: plex.HomeUser
  try {
    // No device: the TV's own PIN check happens when the TV starts the queue. Everything else
    // the TV would be refused for is refused here first, and that start stays on Plex.
    playsAs = (await authorizeQueue(request.setName, null))
      .profile
  } catch (error) {
    return plexRoute(
      `QueuePilot TV could not play it (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  return profileRoute(playsAs, request.cardProfile)
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Wake the Shield and send the start intent. Resolves once QueuePilot TV is in front.
 *
 * CLEAR_TOP with SINGLE_TOP hands the intent to the running activity (`onNewIntent`) instead of
 * stacking a second one, so a queue already playing in the app is replaced the same way a
 * person starting another queue replaces it.
 */
export async function startInTvApp(
  setName: string,
  isCancelled: () => boolean = () => false,
  // eslint-disable-next-line @typescript-eslint/naming-convention -- matches the device-command result shape used across adb.ts
): Promise<{ ok: boolean; error?: string }> {
  if (!SAFE_QUEUE_ID.test(setName))
    return {
      ok: false,
      error: "the queue id cannot be sent",
    }
  if (!adb.connect())
    return {
      ok: false,
      error: `cannot reach ${adbTarget()} over adb`,
    }
  if (adb.isAwake() !== true) {
    await adb.press("KEYCODE_WAKEUP")
    await sleep(1000)
  }
  // A start replaced or cancelled during the wake must not open the queue on the TV.
  if (isCancelled())
    return { ok: false, error: "the start was cancelled" }
  const out = adb.run([
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
    setName,
    "--activity-clear-top",
    "--activity-single-top",
  ])
  if (out == null || /Error:|Exception/.test(out))
    return {
      ok: false,
      error: "QueuePilot TV did not accept the start",
    }
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (
      (adb.foregroundActivity() || "").startsWith(
        `${TV_APP_PACKAGE}/`,
      )
    )
      return { ok: true }
    await sleep(250)
  }
  return {
    ok: false,
    error: "QueuePilot TV did not come to the front",
  }
}

/**
 * Close QueuePilot TV before a start opens Plex on the same Shield. Returns whether it was
 * running.
 *
 * The Plex profile checks read the Plex server's log for requests from the Shield's address
 * (`profiles.waitForProfile`). QueuePilot TV signs its own requests with a profile's
 * household-device token, from the same address, so a request it made while Plex was coming
 * forward could read as Plex signed into that profile. Both Plex paths call this before they open
 * Plex and before the log watch starts at the log's end, so every line the watch reads comes
 * from after QueuePilot TV stopped. A start that opens Plex replaces what the TV shows anyway.
 */
export function closeBeforePlex(): boolean {
  if (!ADB_ENABLED || !adbTarget() || !adb.connect())
    return false
  const pid = adb.run(["shell", "pidof", TV_APP_PACKAGE])
  if (!pid?.trim()) return false
  adb.run(["shell", "am", "force-stop", TV_APP_PACKAGE])
  console.log(
    "[tv-app] closed QueuePilot TV before opening Plex",
  )
  return true
}
