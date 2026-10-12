import { Hono } from "hono";
import {
  createNativePlan,
  continueNativePlan,
  nativeQueues,
  nativeEvent,
  readNativePlan,
  nativeAvatar,
  avatarBytes,
  type NativeEvent,
} from "../nativeTv.js";
import { readBody } from "./readBody.js";
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
      return c.json(await createNativePlan(String(body.setId || ""), proof));
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : "Native playback could not start" },
        403,
      );
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
