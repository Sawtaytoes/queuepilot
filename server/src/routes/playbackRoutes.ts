import { Hono } from "hono"
import {
  cachedChooserPoster,
  chooserPosterPaths,
} from "../chooserPosterCache.js"
import {
  deviceOperationCancelled,
  withDevice,
} from "../deviceScope.js"
import * as devices from "../devices.js"
import * as enginePreview from "../engine/preview.js"
import * as engineRouting from "../engine/routing.js"
import { errMessage } from "../errors.js"
import { isAutoRewatch, wireKindForSet } from "../kind.js"
import * as mqttc from "../mqttc.js"
import * as playback from "../playback.js"
import * as providerBlocks from "../providers/blocks.js"
import {
  coverUrl,
  providerFor,
} from "../providers/index.js"
import { isSetAvailable } from "../season.js"
import * as sets from "../sets.js"
import { lastNow } from "../sse.js"
import type { Device } from "../types.js"
import { binaryResponse } from "./binaryResponse.js"
import { readBody } from "./readBody.js"

/** Playback + channels, over the MQTT bridge: devices, play, session state, now-playing. */
export function playbackRoutes(): Hono {
  const app = new Hono()
  app.get("/chooser/posters", async (context) =>
    context.json({ posters: await chooserPosterPaths() }),
  )
  app.get("/chooser/poster/:id", async (context) => {
    const id = context.req.param("id")
    const set = await sets.getSet(id)
    if (!set || !isSetAvailable(set))
      return context.body(null, 404)
    const image = await cachedChooserPoster(id)
    return image
      ? binaryResponse({
          ...image,
          cacheControl: "private, max-age=300",
        })
      : context.body(null, 404)
  })

  // The "Play on ▾" dropdown — the Python service's retained device registry.
  app.get("/devices", (context) => {
    if (!mqttc.connected())
      return context.json(
        { error: "MQTT not connected", devices: [] },
        503,
      )
    return context.json({ devices: mqttc.devices() })
  })

  // Start a queue/channel on a device. Body: {set, kind?, target?, behavior?}.
  // Product kind on the wire is picks|rules (decision 2026-08-23-kind-is-picks-or-rules).
  // set='auto' still lets the Shield's signed-in profile pick the tier; which Rules
  // channel (shows vs Movies rewatch) is chosen by `behavior: rewatch` (legacy
  // kind='movie' still accepted for one release).
  app.post("/play", async (context) => {
    const {
      set: setId,
      kind: kindReq,
      target,
      profile,
      only,
      behavior,
    } = await readBody(context)
    const tgt = target ? String(target) : undefined
    if (tgt && !devices.known(tgt))
      return context.json(
        { error: `unknown device '${tgt}'` },
        400,
      )
    // PR 4: an explicit profile names the binding on a profiles[] function channel (the
    // Play-landing profile selector); the auto path keeps letting the Shield decide.
    const prof = profile ? String(profile) : undefined
    // The grid's per-tile ▶: play ONE entry of a curated set. Only a curated set has entries
    // to name, so asking for one on a rotation channel is a request error rather than a
    // silently-ignored field — a rotation's pool is a rule, and nothing in it has a key.
    const entryKey = only ? String(only) : undefined
    try {
      if (setId === "auto") {
        if (entryKey)
          return context.json(
            {
              error:
                'set "auto" cannot play a single entry',
            },
            400,
          )
        const autoBehavior = isAutoRewatch({
          kind: kindReq,
          behavior,
        })
          ? "rewatch"
          : undefined
        // kind is always rules for auto (both targets are rule-built channels).
        return context.json({
          sent: mqttc.play(
            "auto",
            "rules",
            tgt,
            undefined,
            undefined,
            autoBehavior,
          ),
        })
      }
      const set = await sets.getSet(String(setId || ""))
      if (!set)
        return context.json({ error: "unknown set" }, 400)
      if (entryKey && set.source !== "queue") {
        return context.json(
          {
            error: `'${set.label || set.id}' is a rule-based channel — it has no entries to play one of`,
          },
          400,
        )
      }
      return context.json({
        sent: mqttc.play(
          set.id,
          wireKindForSet(set),
          tgt,
          prof,
          entryKey,
        ),
      })
    } catch (error) {
      return context.json({ error: errMessage(error) }, 503)
    }
  })

  // Transport control for the Now-playing bar: stop / pause / resume / next / seek, plus
  // `power_off` — end the activity and shut the room down.
  //
  // One route rather than six, because the bar's buttons differ only by a word and every
  // one of them resolves the same target device. `seek` is the odd one — it carries an
  // offset and goes through a different Companion call — so it branches here rather than
  // growing a second route that would duplicate the device lookup.
  //
  // The TRANSPORT verbs do NOT go over MQTT. The `cmd/session/*` topics exist so Home
  // Assistant can START a sitting; these verbs act on a player that is already playing, and
  // routing them through the broker would buy nothing but a hop and a second failure mode.
  // The workspace rule is about services talking to each other, and this is the app talking
  // to Plex (decision `2026-08-22-transport-control-is-http-not-mqtt`).
  //
  // `power_off` is the exception, and it is not one: powering a room down is the app asking
  // ANOTHER SERVICE to touch the physical world, which is exactly what the workspace rule
  // puts on MQTT. It stops Plex over HTTP like its neighbours, then publishes.
  app.post("/control", async (context) => {
    const { action, offset, target } =
      await readBody(context)
    const act = String(action || "")
    // Same resolution mqttd.handleStart() does for a start command's `target`: the UI
    // sends the registry ID, playback wants the announced ENTRY (it reads .uri/.mode/.name).
    const targetId =
      target || mqttc.lastState()?.deviceId || null
    const dev = targetId
      ? (devices.known(String(targetId)) as Device | null)
      : null
    if (targetId && !dev)
      return context.json(
        { error: `unknown device '${String(targetId)}'` },
        400,
      )
    try {
      if (act === "seek") {
        const seekResult = await playback.seekTo(
          offset as number,
          {
            device: dev,
          },
        )
        return seekResult.seeked
          ? context.json({
              ok: true,
              offset: seekResult.offset,
            })
          : context.json({ error: seekResult.error }, 503)
      }
      // END THE ACTIVITY. Two halves, in this order, and the order is the contract: the app
      // stops the player itself so nothing is left running behind a dark TV, THEN asks the
      // house to power down over MQTT. Doing it the other way round leaves Plex playing to a
      // receiver that is already off, which is how a session survives the evening and shows
      // up as "resume" the next morning.
      //
      // A failed stop does NOT cancel the power-off: the owner pressed a button that says
      // end this, and a Shield that has already dropped off the network is the common way
      // the stop fails. The error is reported alongside so the toast can say what happened.
      if (act === "power_off") {
        return withDevice(dev, async () => {
          const st = mqttc.lastState()
          const originalSet = st?.set || null
          const stopped = await playback.transport(
            "stop",
            dev,
          )
          if (deviceOperationCancelled())
            return context.json(
              { error: "playback operation was replaced" },
              409,
            )
          const sent = mqttc.endActivity({
            set: originalSet,
            target: targetId ? String(targetId) : null,
          })
          return context.json({
            ok: true,
            sent,
            stopped: stopped.ok,
            stopError: stopped.error,
          })
        })
      }
      if (
        act !== "stop" &&
        act !== "pause" &&
        act !== "resume" &&
        act !== "next"
      ) {
        return context.json(
          { error: `unknown action '${act}'` },
          400,
        )
      }
      const transportResult = await playback.transport(
        act,
        dev,
      )
      return transportResult.ok
        ? context.json({ ok: true })
        : context.json(
            { error: transportResult.error },
            503,
          )
    } catch (error) {
      return context.json({ error: errMessage(error) }, 503)
    }
  })

  // Last session state (retained plex-channels/state) — the play-result toast's source.
  app.get("/state", (context) =>
    context.json({
      state: mqttc.lastState(),
      mqtt: mqttc.connected(),
    }),
  )

  // Which queue is live, and what's on screen. `set` comes from the session state (the queue
  // we STARTED) — authoritative for "which queue is active" in a way the Plex-side payload
  // can't be, since Plex has no idea our queues exist.
  app.get("/now", async (context) => {
    // Use the lifecycle's ordered, sitting-owned snapshot. A raw retained payload can still
    // describe the previous sitting while the replacement's first observation is pending.
    const now = lastNow()
    const st = mqttc.lastState()
    return context.json({
      now,
      set: st?.set || null,
      kind: st?.kind || null,
      mqtt: mqttc.connected(),
    })
  })

  // Channels view: a rotation set's eligible pool, computed in-process by the engine.
  app.get("/generic/:id/preview", async (context) => {
    try {
      const set = await sets.getSet(context.req.param("id"))
      if (!set || set.source !== "rotation")
        return context.json(
          { error: "not a rotation channel" },
          400,
        )

      // A PULL channel's pool is its provider's, not the Plex engine's. Without this the
      // Channels view renders "Empty" for a reading channel that in fact has a full lineup —
      // previewRotation walks Plex sections, and a Kavita channel has none.
      if (set.delivery === "pull") {
        // Spread, not `s`: see the note in providers/launcher.ts — `BlockSourceCfg`'s index
        // signature is satisfied by an anonymous object type but never by an interface.
        const block = providerBlocks.resolveSingle({
          ...set,
        })
        const provider = providerFor(block.provider)
        // `pool()` is optional on the Provider surface. The JS called it unconditionally and a
        // provider without one produced a TypeError that this try/catch turned into a 503; the
        // explicit throw keeps that exact status and body shape with a message that names the
        // provider instead of naming a property.
        if (typeof provider.pool !== "function")
          throw new Error(
            `${provider.label} does not compute a pool`,
          )
        const pool = await provider.pool({
          libraries: block.libraries,
          members: (set.members || []).map(String),
        })
        // Returned as `buckets`, the SAME key and shape the Plex preview uses, so the Channels
        // grid renders a reading pool with no second code path. See kavita.js pool().
        return context.json({
          id: set.id,
          label: set.label,
          provider: block.provider,
          delivery: "pull",
          // `cover` is the one field the Plex shape has no equivalent of: a Plex bucket's
          // artwork is /api/thumb/<ratingKey>, which the frontend builds from the id it already
          // has. A provider id needs its provider's proxy instead, so the URL is sent.
          // `unit` goes with it: the shape is Plex's, and Plex's next-up line counts EPISODES.
          // A reading bucket's number is a chapter, so the tile must say "Ch 113", not "E113".
          buckets: pool.map((bucket) => ({
            ...bucket,
            cover: coverUrl(
              block.provider,
              bucket.ratingKey,
            ),
            unit: provider.unit || "episode",
          })),
        })
      }

      const profile = context.req.query("profile") ?? ""
      // Widened on purpose: `previewRotation()` has no declared return type yet, so TS infers
      // the narrow shape of its first `return` literal and rejects the `routing` field this
      // route bolts on afterwards. A `RotationPreview` interface exported from
      // engine/preview.ts is the real fix — that file belongs to another agent this round.
      const node: Record<string, unknown> =
        await enginePreview.previewRotation(set.id, profile)
      try {
        node.routing = engineRouting.forSet(set.id, profile)
      } catch (error) {
        console.log(
          `[engine] routing preview failed for ${set.id}: ${errMessage(error)}`,
        )
      }
      return context.json(node)
    } catch (error) {
      return context.json({ error: errMessage(error) }, 503)
    }
  })

  return app
}
