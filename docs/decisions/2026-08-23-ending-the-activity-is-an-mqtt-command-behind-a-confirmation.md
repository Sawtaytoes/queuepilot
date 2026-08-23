# Ending the activity is an MQTT command, behind a confirmation

- **Status:** Accepted
- **Date:** 2026-08-23
- **Type:** Feature / boundary / UI
- **Supersedes:** —
- **Superseded by:** —
- **Builds on:**
  - [transport-control-is-http-not-mqtt](2026-08-22-transport-control-is-http-not-mqtt.md)
    — the transport verbs stay on HTTP; this names the one control that does not

## Decision

### 1. The Now-playing bar gains a power-off control

`⏻ End the activity and power off`, beside Stop. The Now-playing bar only — it is the
"controls", and the bar is on screen exactly when there is an activity to end.

Owner, 2026-08-23: *"there's no way to power-off the activity in the controls."*

### 2. It asks first

A confirmation modal (`#poweroffmodal`), named for what it takes with it:

> **End the activity?**
> `<what is playing>` stops, and the room powers off — the TV and the receiver both.

Cancel / **End and power off**.

Every other button in the bar is undone by pressing another one. This is not: it takes the
TV and the receiver down together, in a room with other people in it, and Stop is its
immediate neighbour. Owner, 2026-08-23: *"I also want it activated via confirmation modal."*

### 3. Stop first over HTTP, then publish over MQTT

`POST /api/control {action: "power_off"}`:

1. `playback.transport('stop')` — the app kills the running session itself.
2. `mqttc.endActivity()` — publish `queuepilot/cmd/activity/off`.

**The order is the contract.** Powering the room down first leaves Plex playing to a
receiver that is already off, which is how a session survives the evening and turns up as a
resume point the next morning. Owner, 2026-08-23: *"Should kill any running process
automatically."*

A failed stop does **not** cancel the power-off. The press says end this; a Shield that has
already dropped off the network is the ordinary way the stop fails, and refusing to turn the
room off because of it would be the wrong half to honour. The response carries
`stopped` / `stopError` so a toast can still say what happened.

### 4. Why this one is MQTT when its neighbours are HTTP

[The transport ADR](2026-08-22-transport-control-is-http-not-mqtt.md) keeps stop / pause /
resume / next / seek on `POST /api/control` because they are **this app talking to Plex**,
and a broker hop between a browser and its own origin buys a failure mode.

Powering a room down is not that. It is this app asking **another service** to touch things
with power cables, which is precisely what the workspace rule puts on MQTT — and it is the
same boundary `resp/finished`'s `power_off` flag has always sat on. So the action stays
split: Plex over HTTP, the house over the broker.

### 5. A COMMAND topic, not the finished announcement

`queuepilot/cmd/activity/off`, payload `{reason: 'manual', set?, target?}`. Not retained.

It is deliberately **not** `resp/finished` with `power_off: true`, because HA gates that
event on four guards that all exist for a thing that fires on its own:

| `resp/finished` guard | Why it is absent here |
| --- | --- |
| the set's `power_off_when_done` opt-in | the press **is** the opt-in; a queue nobody ticked the box on still ends when the owner ends it |
| `isComplete` | neither "played its full length" nor "ran dry" describes a button press mid-episode |
| a 45-second wait | it exists to let a re-tap land on an event nobody chose; waiting here means the room stays on for 45 seconds after being told to go off |
| "nothing is playing" after the wait | with the wait gone there is nothing to re-check, and the app has already stopped Plex |

`reason` exists so a later automatic sender (a sleep timer, an empty-room rule) is
distinguishable from the button without a second topic.

### 6. Home Assistant

`packages/queuepilot_topup.yaml` gains an `MQTT: End Activity` trigger and a branch that
turns off `media_player.family_room_tv` + `media_player.family_room_avr` — the same two
entities the automatic branch already targets, with none of its guards.

## Context

The bar shipped 2026-08-22 with stop / pause / resume / next / seek
([#178](https://github.com/Sawtaytoes/queuepilot/pull/178)). Power-off existed only as
`power_off_when_done`, a per-set flag that rides on `resp/finished` — so the only way to end
an evening deliberately was to stop playback and then reach for a remote.

## Why

- **A room is not a player.** Stop is a Plex verb; power off is a house verb. Splitting the
  action along that line is what keeps each half talking to the service that owns it.
- **The guards on the automatic path are the wrong guards for a press.** Reusing
  `resp/finished` would have meant either honouring them (a button that does nothing on a
  queue with the box unticked) or loosening them (an automatic power-off that no longer
  waits out a re-tap). A second topic costs one trigger and keeps both correct.
- **Confirmation is cheap here and only here.** The other four controls are reversible in
  one tap; this one is a dark room.

## Evidence

- Owner, 2026-08-23: *"there's no way to power-off the activity in the controls"*;
  *"End the activity to Power Off via HA which'll make this another MQTT control. Should
  kill any running process automatically"*; *"I also want it activated via confirmation
  modal."*
- Placement chosen from the same session: Now-playing bar only.
