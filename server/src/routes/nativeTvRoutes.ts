import { Hono } from "hono"
import { NativeRequestError } from "../nativeAccess.js"
import {
  clearPin,
  hasPin,
  NativeLockError,
  setPin,
} from "../nativeLock.js"
import type { NativeStart } from "../nativeQueueDetail.js"
import {
  avatarBytes,
  continueNativePlan,
  createNativePlan,
  type NativeCaller,
  type NativeEvent,
  nativeAddToQueue,
  nativeAvatar,
  nativeEvent,
  nativeFullQueue,
  nativeMarkWatched,
  nativeQueues,
  nativeUnlock,
  nativeWatchHistory,
  readNativePlan,
} from "../nativeTv.js"
import { readPersonPhoto } from "../store/db/personPhotos.js"
import { photoResponse } from "./photoResponse.js"
import { readBody } from "./readBody.js"

type RefusalStatus = 400 | 403 | 404 | 409 | 423 | 429
interface RefusalBody {
  error: string
  /** 423: the queue is locked on the TV and this device has no valid unlock. */
  isLocked?: true
  /** 429: seconds before another PIN attempt is accepted. */
  retryAfterSeconds?: number
  /** 403 from the unlock route: wrong PINs left before the household waits. */
  attemptsLeft?: number
}

/** A stated refusal keeps its status; anything else is the 403 these routes always answered. */
const refusal = (
  error: unknown,
  fallback: string,
): { body: RefusalBody; status: RefusalStatus } => {
  const body: RefusalBody = {
    error:
      error instanceof Error ? error.message : fallback,
  }
  if (error instanceof NativeLockError) {
    if (error.status === 423) body.isLocked = true
    if (error.retryAfterSeconds != null)
      body.retryAfterSeconds = error.retryAfterSeconds
    if (error.attemptsLeft != null)
      body.attemptsLeft = error.attemptsLeft
    return { body, status: error.status }
  }
  return {
    body,
    status:
      error instanceof NativeRequestError
        ? error.status
        : 403,
  }
}

/**
 * The three headers a native request authorizes with. The Plex token names the household
 * DEVICE (never the profile a queue plays as); the device id and the unlock are the TV PIN's.
 */
const callerOf = (context: {
  req: { header: (name: string) => string | undefined }
}): NativeCaller => ({
  proof: context.req.header("X-Plex-Profile-Token") || "",
  deviceId: context.req.header("X-QueuePilot-Device") || "",
  unlockToken:
    context.req.header("X-QueuePilot-Unlock") || "",
})

/** The optional "start from this item" of a new session, or null when absent or malformed. */
function startFrom(
  raw: unknown,
): NativeStart | null | "invalid" {
  if (raw == null) return null
  if (typeof raw !== "object") return "invalid"
  const start = raw as Record<string, unknown>
  const entryKey =
    typeof start.entryKey === "string" ? start.entryKey : ""
  const ratingKey =
    typeof start.ratingKey === "string" ||
    typeof start.ratingKey === "number"
      ? String(start.ratingKey)
      : ""
  const mode =
    start.mode === undefined ? "continue" : start.mode
  if (
    !entryKey ||
    !ratingKey ||
    (mode !== "continue" && mode !== "only")
  )
    return "invalid"
  return {
    entryKey,
    ratingKey,
    plexServer:
      typeof start.plexServer === "string" &&
      start.plexServer
        ? start.plexServer
        : null,
    mode,
  }
}
export function nativeTvRoutes(): Hono {
  const app = new Hono()
  app.get("/native/queues", async (context) => {
    try {
      return context.json(
        await nativeQueues(
          (context.req.query("people") || "")
            .split(",")
            .filter(Boolean),
        ),
      )
    } catch {
      return context.json(
        {
          error: "QueuePilot could not load the TV queues",
        },
        503,
      )
    }
  })
  app.get("/native/people/:id/avatar", async (context) => {
    try {
      // QueuePilot's own photo first; the Plex Home thumb is the fallback
      // (decision 2026-10-22-a-person-photo-is-a-row-in-the-book-of-record).
      const owned = readPersonPhoto(context.req.param("id"))
      if (owned) return photoResponse(context, owned)
      const url = await nativeAvatar(
        context.req.param("id"),
      )
      if (!url) return context.body(null, 404)
      const image = await avatarBytes(url)
      if (!image) return context.body(null, 404)
      context.header("Content-Type", image.type)
      context.header("Cache-Control", "private,max-age=600")
      return context.body(image.bytes)
    } catch {
      return context.body(null, 404)
    }
  })
  app.post("/native/sessions", async (context) => {
    try {
      const body = await readBody(context),
        proof =
          context.req.header("X-Plex-Profile-Token") || ""
      context.header("Cache-Control", "no-store")
      const start = startFrom(body.start)
      if (start === "invalid")
        return context.json(
          {
            error:
              "start needs an entryKey, a ratingKey, and a mode of continue or only",
          },
          400,
        )
      return context.json(
        await createNativePlan(
          String(body.setId || ""),
          { ...callerOf(context), proof },
          start,
        ),
      )
    } catch (error) {
      const { body, status } = refusal(
        error,
        "Native playback could not start",
      )
      return context.json(body, status)
    }
  })
  app.get("/native/queues/:setId/full", async (context) => {
    try {
      context.header("Cache-Control", "no-store")
      return context.json(
        await nativeFullQueue(
          context.req.param("setId"),
          callerOf(context),
        ),
      )
    } catch (error) {
      const { body, status } = refusal(
        error,
        "The queue could not be read",
      )
      return context.json(body, status)
    }
  })
  app.post(
    "/native/queues/:setId/watched",
    async (context) => {
      try {
        const body = await readBody(context)
        if (
          typeof body.entryKey !== "string" ||
          !(
            typeof body.ratingKey === "string" ||
            typeof body.ratingKey === "number"
          ) ||
          typeof body.isWatched !== "boolean"
        )
          return context.json(
            {
              error:
                "Send entryKey, ratingKey, and a boolean isWatched",
            },
            400,
          )
        context.header("Cache-Control", "no-store")
        return context.json(
          await nativeMarkWatched(
            context.req.param("setId"),
            callerOf(context),
            {
              entryKey: body.entryKey,
              ratingKey: String(body.ratingKey),
              plexServer:
                typeof body.plexServer === "string"
                  ? body.plexServer
                  : null,
              isWatched: body.isWatched,
            },
          ),
        )
      } catch (error) {
        const { body, status } = refusal(
          error,
          "The watched state could not be saved",
        )
        return context.json(body, status)
      }
    },
  )
  app.post(
    "/native/queues/:setId/items",
    async (context) => {
      try {
        const body = await readBody(context)
        if (
          !(
            typeof body.ratingKey === "string" ||
            typeof body.ratingKey === "number"
          )
        )
          return context.json(
            {
              error:
                "Send the ratingKey of a movie or a show",
            },
            400,
          )
        context.header("Cache-Control", "no-store")
        return context.json(
          await nativeAddToQueue(
            context.req.param("setId"),
            callerOf(context),
            {
              ratingKey: String(body.ratingKey),
              plexServer:
                typeof body.plexServer === "string"
                  ? body.plexServer
                  : null,
            },
          ),
        )
      } catch (error) {
        const { body, status } = refusal(
          error,
          "The title could not be added",
        )
        return context.json(body, status)
      }
    },
  )
  /**
   * Trade the household TV PIN for an unlock on this device: `{pin}` → `{unlockToken,
   * expiresAt}`. 403 + `attemptsLeft` for a wrong PIN, 429 + `retryAfterSeconds` after five in a
   * row, 409 when no PIN is set (nothing is locked), 400 without `X-QueuePilot-Device`.
   */
  app.post("/native/unlock", async (context) => {
    context.header("Cache-Control", "no-store")
    try {
      const body = await readBody(context)
      return context.json(
        await nativeUnlock(callerOf(context), body.pin),
      )
    } catch (error) {
      const { body, status } = refusal(
        error,
        "The TV could not be unlocked",
      )
      if (body.retryAfterSeconds != null)
        context.header(
          "Retry-After",
          String(body.retryAfterSeconds),
        )
      return context.json(body, status)
    }
  })
  app.get("/native/history", async (context) => {
    try {
      context.header("Cache-Control", "no-store")
      return context.json(
        await nativeWatchHistory(
          callerOf(context),
          Number(context.req.query("days") || 30),
        ),
      )
    } catch (error) {
      const { body, status } = refusal(
        error,
        "The watch history could not be read",
      )
      return context.json(body, status)
    }
  })
  app.get("/native/sessions/:id", (context) => {
    try {
      context.header("Cache-Control", "no-store")
      return context.json(
        readNativePlan(
          context.req.param("id"),
          context.req.header("X-Native-Session-Key") || "",
        ),
      )
    } catch {
      return context.json(
        { error: "Native session authorization failed" },
        403,
      )
    }
  })
  app.post(
    "/native/sessions/:id/events",
    async (context) => {
      try {
        return context.json(
          await nativeEvent(
            context.req.param("id"),
            context.req.header("X-Native-Session-Key") ||
              "",
            (await readBody(
              context,
            )) as unknown as NativeEvent,
          ),
        )
      } catch (error) {
        return context.json(
          {
            error:
              error instanceof Error
                ? error.message
                : "Progress could not be saved",
          },
          /authorization|expired/.test(
            error instanceof Error ? error.message : "",
          )
            ? 403
            : /Stale|order/.test(
                  error instanceof Error
                    ? error.message
                    : "",
                )
              ? 409
              : /Invalid|outside|Unknown|boundary/.test(
                    error instanceof Error
                      ? error.message
                      : "",
                  )
                ? 400
                : 503,
        )
      }
    },
  )
  app.post(
    "/native/sessions/:id/continue",
    async (context) => {
      try {
        return context.json(
          await continueNativePlan(
            context.req.param("id"),
            context.req.header("X-Native-Session-Key") ||
              "",
          ),
        )
      } catch (error) {
        return context.json(
          {
            error:
              error instanceof Error
                ? error.message
                : "The queue could not continue",
          },
          409,
        )
      }
    },
  )
  return app
}

/**
 * The WEB side of the TV PIN: whether one is set, set or change it, and clear it. Mounted
 * outside `/native` on purpose — the TV app authorizes `/native/*` with a Plex token, and the
 * PIN that locks the TV must not be changeable with the very device it locks. The PIN is never
 * returned, only whether one exists.
 */
export function tvLockRoutes(): Hono {
  const app = new Hono()
  app.get("/tv-lock", (context) => {
    context.header("Cache-Control", "no-store")
    return context.json({ hasPin: hasPin() })
  })
  app.put("/tv-lock/pin", async (context) => {
    try {
      const body = await readBody(context)
      await setPin(body.pin)
      return context.json({ hasPin: true })
    } catch (error) {
      if (error instanceof NativeLockError)
        return context.json(
          { error: error.message },
          error.status,
        )
      return context.json(
        { error: "The TV PIN could not be saved" },
        500,
      )
    }
  })
  app.delete("/tv-lock/pin", (context) => {
    clearPin()
    return context.json({ hasPin: false })
  })
  return app
}
