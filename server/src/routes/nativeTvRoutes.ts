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
  type NativeEvent,
} from "../nativeTv.js";
import { NativeRequestError } from "../nativeAccess.js";
import type { NativeStart } from "../nativeQueueDetail.js";
import { readBody } from "./readBody.js";

/** A stated refusal keeps its status; anything else is the 403 these routes always answered. */
const refusal = (e: unknown, fallback: string): { body: { error: string }; status: 400 | 403 | 404 | 409 } => ({
  body: { error: e instanceof Error ? e.message : fallback },
  status: e instanceof NativeRequestError ? e.status : 403,
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
      return c.json(await createNativePlan(String(body.setId || ""), proof, start));
    } catch (e) {
      const { body, status } = refusal(e, "Native playback could not start");
      return c.json(body, status);
    }
  });
  app.get("/native/queues/:setId/full", async (c) => {
    try {
      c.header("Cache-Control", "no-store");
      return c.json(
        await nativeFullQueue(c.req.param("setId"), c.req.header("X-Plex-Profile-Token") || ""),
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
        await nativeMarkWatched(c.req.param("setId"), c.req.header("X-Plex-Profile-Token") || "", {
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
  app.get("/native/history", async (c) => {
    try {
      c.header("Cache-Control", "no-store");
      return c.json(
        await nativeWatchHistory(
          c.req.header("X-Plex-Profile-Token") || "",
          Number(c.req.query("days") || 30),
        ),
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
          c.req.header("X-Plex-Profile-Token") || undefined,
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
        await continueNativePlan(
          c.req.param("id"),
          c.req.header("X-Native-Session-Key") || "",
          c.req.header("X-Plex-Profile-Token") || undefined,
        ),
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
