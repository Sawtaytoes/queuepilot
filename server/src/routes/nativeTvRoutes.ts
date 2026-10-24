import { Hono } from "hono";
import {
  createNativePlan,
  continueNativePlan,
  nativeQueues,
  nativeEvent,
  readNativePlan,
  nativeAvatar,
  avatarBytes,
  nativeFullQueue,
  nativeWatchHistory,
  nativeMarkWatched,
  nativeAddToQueue,
  nativeUnlock,
  type NativeCaller,
  type NativeEvent,
} from "../nativeTv.js";
import { NativeRequestError } from "../nativeAccess.js";
import { clearPin, hasPin, NativeLockError, setPin } from "../nativeLock.js";
import type { NativeStart } from "../nativeQueueDetail.js";
import { readPersonPhoto } from "../store/db/personPhotos.js";
import { photoResponse } from "./photoResponse.js";
import { readBody } from "./readBody.js";

type RefusalStatus = 400 | 403 | 404 | 409 | 423 | 429;
interface RefusalBody {
  error: string;
  /** 423: the queue is locked on the TV and this device has no valid unlock. */
  isLocked?: true;
  /** 429: seconds before another PIN attempt is accepted. */
  retryAfterSeconds?: number;
  /** 403 from the unlock route: wrong PINs left before the household waits. */
  attemptsLeft?: number;
}

/** A stated refusal keeps its status; anything else is the 403 these routes always answered. */
const refusal = (e: unknown, fallback: string): { body: RefusalBody; status: RefusalStatus } => {
  const body: RefusalBody = { error: e instanceof Error ? e.message : fallback };
  if (e instanceof NativeLockError) {
    if (e.status === 423) body.isLocked = true;
    if (e.retryAfterSeconds != null) body.retryAfterSeconds = e.retryAfterSeconds;
    if (e.attemptsLeft != null) body.attemptsLeft = e.attemptsLeft;
    return { body, status: e.status };
  }
  return { body, status: e instanceof NativeRequestError ? e.status : 403 };
};

/**
 * The three headers a native request authorizes with. The Plex token names the household
 * DEVICE (never the profile a queue plays as); the device id and the unlock are the TV PIN's.
 */
const callerOf = (c: { req: { header: (name: string) => string | undefined } }): NativeCaller => ({
  proof: c.req.header("X-Plex-Profile-Token") || "",
  deviceId: c.req.header("X-QueuePilot-Device") || "",
  unlockToken: c.req.header("X-QueuePilot-Unlock") || "",
});

/** The optional "start from this item" of a new session, or null when absent or malformed. */
function startFrom(raw: unknown): NativeStart | null | "invalid" {
  if (raw == null) return null;
  if (typeof raw !== "object") return "invalid";
  const start = raw as Record<string, unknown>;
  const entryKey = typeof start.entryKey === "string" ? start.entryKey : "";
  const ratingKey =
    typeof start.ratingKey === "string" || typeof start.ratingKey === "number"
      ? String(start.ratingKey)
      : "";
  const mode = start.mode === undefined ? "continue" : start.mode;
  if (!entryKey || !ratingKey || (mode !== "continue" && mode !== "only")) return "invalid";
  return {
    entryKey,
    ratingKey,
    plexServer: typeof start.plexServer === "string" && start.plexServer ? start.plexServer : null,
    mode,
  };
}
export function nativeTvRoutes(): Hono {
  const app = new Hono();
  app.get("/native/queues", async (c) => {
    try {
      return c.json(await nativeQueues((c.req.query("people") || "").split(",").filter(Boolean)));
    } catch {
      return c.json({ error: "QueuePilot could not load the TV queues" }, 503);
    }
  });
  app.get("/native/people/:id/avatar", async (c) => {
    try {
      // QueuePilot's own photo first; the Plex Home thumb is the fallback
      // (decision 2026-10-22-a-person-photo-is-a-row-in-the-book-of-record).
      const owned = readPersonPhoto(c.req.param("id"));
      if (owned) return photoResponse(c, owned);
      const url = await nativeAvatar(c.req.param("id"));
      if (!url) return c.body(null, 404);
      const image = await avatarBytes(url);
      if (!image) return c.body(null, 404);
      c.header("Content-Type", image.type);
      c.header("Cache-Control", "private,max-age=600");
      return c.body(image.bytes);
    } catch {
      return c.body(null, 404);
    }
  });
  app.post("/native/sessions", async (c) => {
    try {
      const body = await readBody(c),
        proof = c.req.header("X-Plex-Profile-Token") || "";
      c.header("Cache-Control", "no-store");
      const start = startFrom(body.start);
      if (start === "invalid")
        return c.json(
          { error: "start needs an entryKey, a ratingKey, and a mode of continue or only" },
          400,
        );
      return c.json(await createNativePlan(String(body.setId || ""), { ...callerOf(c), proof }, start));
    } catch (e) {
      const { body, status } = refusal(e, "Native playback could not start");
      return c.json(body, status);
    }
  });
  app.get("/native/queues/:setId/full", async (c) => {
    try {
      c.header("Cache-Control", "no-store");
      return c.json(
        await nativeFullQueue(c.req.param("setId"), callerOf(c)),
      );
    } catch (e) {
      const { body, status } = refusal(e, "The queue could not be read");
      return c.json(body, status);
    }
  });
  app.post("/native/queues/:setId/watched", async (c) => {
    try {
      const body = await readBody(c);
      if (
        typeof body.entryKey !== "string" ||
        !(typeof body.ratingKey === "string" || typeof body.ratingKey === "number") ||
        typeof body.isWatched !== "boolean"
      )
        return c.json({ error: "Send entryKey, ratingKey, and a boolean isWatched" }, 400);
      c.header("Cache-Control", "no-store");
      return c.json(
        await nativeMarkWatched(c.req.param("setId"), callerOf(c), {
          entryKey: body.entryKey,
          ratingKey: String(body.ratingKey),
          plexServer: typeof body.plexServer === "string" ? body.plexServer : null,
          isWatched: body.isWatched,
        }),
      );
    } catch (e) {
      const { body, status } = refusal(e, "The watched state could not be saved");
      return c.json(body, status);
    }
  });
  app.post("/native/queues/:setId/items", async (c) => {
    try {
      const body = await readBody(c);
      if (!(typeof body.ratingKey === "string" || typeof body.ratingKey === "number"))
        return c.json({ error: "Send the ratingKey of a movie or a show" }, 400);
      c.header("Cache-Control", "no-store");
      return c.json(
        await nativeAddToQueue(c.req.param("setId"), callerOf(c), {
          ratingKey: String(body.ratingKey),
          plexServer: typeof body.plexServer === "string" ? body.plexServer : null,
        }),
      );
    } catch (e) {
      const { body, status } = refusal(e, "The title could not be added");
      return c.json(body, status);
    }
  });
  /**
   * Trade the household TV PIN for an unlock on this device: `{pin}` → `{unlockToken,
   * expiresAt}`. 403 + `attemptsLeft` for a wrong PIN, 429 + `retryAfterSeconds` after five in a
   * row, 409 when no PIN is set (nothing is locked), 400 without `X-QueuePilot-Device`.
   */
  app.post("/native/unlock", async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      const body = await readBody(c);
      return c.json(await nativeUnlock(callerOf(c), body.pin));
    } catch (e) {
      const { body, status } = refusal(e, "The TV could not be unlocked");
      if (body.retryAfterSeconds != null) c.header("Retry-After", String(body.retryAfterSeconds));
      return c.json(body, status);
    }
  });
  app.get("/native/history", async (c) => {
    try {
      c.header("Cache-Control", "no-store");
      return c.json(
        await nativeWatchHistory(callerOf(c), Number(c.req.query("days") || 30)),
      );
    } catch (e) {
      const { body, status } = refusal(e, "The watch history could not be read");
      return c.json(body, status);
    }
  });
  app.get("/native/sessions/:id", (c) => {
    try {
      c.header("Cache-Control", "no-store");
      return c.json(readNativePlan(c.req.param("id"), c.req.header("X-Native-Session-Key") || ""));
    } catch {
      return c.json({ error: "Native session authorization failed" }, 403);
    }
  });
  app.post("/native/sessions/:id/events", async (c) => {
    try {
      return c.json(
        await nativeEvent(
          c.req.param("id"),
          c.req.header("X-Native-Session-Key") || "",
          (await readBody(c)) as unknown as NativeEvent,
        ),
      );
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : "Progress could not be saved" },
        /authorization|expired/.test(e instanceof Error ? e.message : "")
          ? 403
          : /Stale|order/.test(e instanceof Error ? e.message : "")
            ? 409
            : /Invalid|outside|Unknown|boundary/.test(e instanceof Error ? e.message : "")
              ? 400
              : 503,
      );
    }
  });
  app.post("/native/sessions/:id/continue", async (c) => {
    try {
      return c.json(
        await continueNativePlan(c.req.param("id"), c.req.header("X-Native-Session-Key") || ""),
      );
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : "The queue could not continue" },
        409,
      );
    }
  });
  return app;
}

/**
 * The WEB side of the TV PIN: whether one is set, set or change it, and clear it. Mounted
 * outside `/native` on purpose — the TV app authorizes `/native/*` with a Plex token, and the
 * PIN that locks the TV must not be changeable with the very device it locks. The PIN is never
 * returned, only whether one exists.
 */
export function tvLockRoutes(): Hono {
  const app = new Hono();
  app.get("/tv-lock", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ hasPin: hasPin() });
  });
  app.put("/tv-lock/pin", async (c) => {
    try {
      const body = await readBody(c);
      await setPin(body.pin);
      return c.json({ hasPin: true });
    } catch (e) {
      if (e instanceof NativeLockError) return c.json({ error: e.message }, e.status);
      return c.json({ error: "The TV PIN could not be saved" }, 500);
    }
  });
  app.delete("/tv-lock/pin", (c) => {
    clearPin();
    return c.json({ hasPin: false });
  });
  return app;
}
