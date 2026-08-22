# Transport control is HTTP, not MQTT

- **Status:** Accepted
- **Date:** 2026-08-22
- **Type:** Architecture / boundary
- **Supersedes:** —
- **Superseded by:** —

## Decision

The Now-playing bar's controls — stop, pause, resume, next, seek — go to the app's own
**`POST /api/control`**. They do **not** publish an MQTT command, and no `queuepilot/cmd/*`
topic is added for them.

The `cmd/session/*` topics keep their job unchanged: they are how **Home Assistant** starts a
sitting, from an NFC card, a voice sentence or a remote button.

## Context

The workspace rule is that services talk to each other over MQTT rather than over new REST or
shell bridges. Read quickly, that rule says a new "stop the video" verb belongs on the broker
next to `cmd/session/start`, and an agent reading this repo will reach for exactly that.

## Why this is the other side of the rule

The rule governs **service-to-service** traffic — Home Assistant asking QueuePilot to do
something, QueuePilot telling the house a sitting ended. Both of those cross a process
boundary between two independently-scheduled systems, and the broker is what decouples them.

A transport verb crosses no such boundary:

- **The browser is already talking to this server.** The bar is served by QueuePilot, over
  the same origin it fetches `/api/now` from. Publishing to a broker so that the same process
  can subscribe to itself adds a hop and a second failure mode to a round trip that already
  exists.
- **It needs an answer.** A press has to say whether it worked — "stop failed: target client
  not found" belongs in a toast. MQTT gives fire-and-forget; the `cmd/session/*` topics get
  away with that because their reply is a *state* the whole house cares about
  (`queuepilot/state`, `resp/last-played`), and "did the pause land" is not.
- **Home Assistant has no interest in it.** Nothing in the house automates a pause. The one
  house-facing event in this area already exists and stays on the broker:
  `queuepilot/resp/finished`, which carries `power_off`.

## Why not both

A `cmd/playback/pause` topic mirroring the route would be two paths to one behaviour, and the
one nothing uses would rot. The rename audit of 2026-08-12 found a `preview` topic in exactly
that state — published by nobody, subscribed by nothing, still carried in the code.

## Evidence

- Owner, 2026-08-22: *"I don't have any media controls from here though. So I can't stop it.
  Once a queue starts, it keeps going."* The ask is a control surface in the app, not a new
  house capability.
- `playback.stopPlayback()` and `playback.seekTo()` already existed with no HTTP route on
  either — the gap was the route, not the transport.
- The verbs reach Plex Companion directly (`/player/playback/<verb>`), which is a third-party
  HTTP API. There is no service of ours between the button and Plex for a broker to decouple.

## Notes

- `seek` branches inside the same route rather than getting its own: it carries an offset and
  needs the binding's play token, but it resolves the same target device.
- These verbs deliberately do **not** get `driver.ts`'s re-open-Plex retry loop. That loop
  exists to start a session against a Shield in an unknown state; a transport verb only makes
  sense while something is already on screen, so a refusal is real news.
