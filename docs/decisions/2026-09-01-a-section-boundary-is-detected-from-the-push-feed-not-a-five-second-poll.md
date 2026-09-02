# A section boundary is detected from the push feed, not a five-second poll

- **Status:** Accepted
- **Date:** 2026-09-01
- **Type:** playback / latency
- **Supersedes:** —
- **Superseded by:** —

## Decision

A section's start seek and its stop-and-advance are driven from the **MQTT now-playing feed**
QueuePilot already subscribes to, with the position extrapolated locally between events. The
`/status/sessions` poll stays as the fallback, not the primary trigger.

Five supporting changes, in the order they pay off:

1. **A `companionTarget()` MISS is cached** with a short TTL. Today only a hit is memoised, so a
   Shield that is not advertising a connection costs a WAN round trip to
   `plex.tv/api/v2/devices` on **every poll, every seek and every transport verb** — and "not
   advertising" is exactly the state the system is in while Plex is mid-navigation, which is
   when a section is about to start.
2. **The client target is resolved once at arm time** and handed to the watcher, instead of
   being re-resolved per tick and again per seek. `resume.arm()` already stores the device.
3. **The poll path gets its own short timeout.** `plexReq`'s default is 60 s with no retry; on a
   5 s cadence one hung socket stalls the watcher for a dozen ticks.
4. **A section plan is keyed by playQueue INDEX, not by ratingKey.** `readPlayQueue()`'s
   `selectedOffset` is the only signal that says which *occurrence* is playing.
5. **`RESUME_POLL_MS` drops** for the fallback path.

**A section start on the HEAD item costs nothing at all.** Companion `playMedia` already takes
an `offset` that applies to the item it starts on, and `PlexArtifact.offset` already carries it.
The head's start is that offset — no poll, no seek, no delay.

## Context

The owner reports that seeking to the right spot in queued content takes four to five seconds,
and asked for it to be instant. A section that starts five seconds late is a broken section, so
this is not a separate nicety — it is the same problem.

The number is not mysterious. It is almost entirely one line:

```
RESUME_POLL_MS = 5_000        # env.ts
```

The seek cannot fire before the next tick after the player advances, so mean detection is
**2.5 s** and worst case **5 s** before a byte goes out. `considerSession` may then decline once
with `retry: true`, because at the moment of an advance `/status/sessions` can still report the
previous item's position against the new ratingKey — a live observation already recorded in
`resume.ts`, where one episode's first sighting carried the previous episode's 895 s. That costs
**another full poll**. Five seconds and ten seconds are both reachable, and both match the
report.

The seek itself is one LAN HTTP round trip, tens of milliseconds. **The seek is not slow.
Finding out that it is due is slow.**

The feed that fixes it is already in the tree and already trusted. `queuepilot/now-playing` is
subscribed in `mqttc.ts`, carries `position` and `positionAt`, is consumed by `finished.ts` on
every event to save a per-entry position, is rebroadcast to browsers over SSE, and is
extrapolated at 1 Hz by `NowPlayingBar` to paint a live scrub bar. Nothing about it is new work.

## Why

- **The boundary is a position question, and the position is already being pushed.** Polling an
  HTTP endpoint to learn something a retained MQTT topic reports is latency bought for nothing.
- **Local extrapolation between events beats a shorter poll.** `position + (now - positionAt)`
  is what the Now-playing bar already does; a 1 Hz local timer costs no network at all, where a
  1 Hz HTTP poll costs one request per second per active queue.
- **Index-keying is a correctness fix, not a tuning one.** Once one file can appear twice, a
  `Map<ratingKey, ms>` physically cannot hold two different starts for it, and a
  `Set<ratingKey>` of already-considered items answers "already considered" for the second
  occurrence and never seeks. See
  [`2026-09-01-an-entry-can-carry-an-id-so-one-file-can-hold-two-lines`](2026-09-01-an-entry-can-carry-an-id-so-one-file-can-hold-two-lines.md).
- **The existing resume filters must not apply to a section.** `RESUME_MIN_MS` (30 s) would drop
  a section starting at 0:12, `RESUME_MAX_FRACTION` (0.95) would drop a closing-gag section, and
  `viewCount >= 1` would drop any section of a film already watched. Those three are all correct
  for a resume *marker*, which is inferred data. A section is authored data and gets its own
  plan rather than a loosened version of that one.

## Risks

**The now-playing topic has been rejected for this job once before**, and the reason is recorded
in `resume.ts`: on this setup the HA-fed topic reported `{"state":"playing","ratingKey":null}` —
a playing state it could not name. A trigger that cannot name the item cannot seek it.

The position fields from that same topic **are** trusted in production today by `finished.ts`,
so the payload is not wholly unreliable; it is the naming fields that were. So: verify the live
payload before trusting `ratingKey`, and keep the `/status/sessions` path as the fallback rather
than deleting it. If `ratingKey` proves unreliable, the honest longer-term fix is PMS's own
`/:/websockets/notifications` timeline feed, which is what HA consumes to produce this topic in
the first place — adopting it directly removes HA from the loop.

**`commandID` is hardcoded to `'1'`** on every Companion command. Companion expects a
monotonically increasing per-client id. It has never mattered because commands are isolated. A
section fires **seek then `skipNext` in quick succession**, which is the first time this codebase
sends two commands close together. Verify before shipping.

**`advanceSession()` is not the advance mechanism.** It rebuilds the whole playQueue and
restarts playback, which `topup.ts` already names as the thing to avoid. The advance is
Companion `skipNext` through `transport('next')`.

## Evidence

- Owner, chat 2026-09-01: *"I wish we could more quickly see what's playing and seek to the right
  spot. I'd love for that to be instant. It take 4-5 seconds today, the seeking of playlist
  content."*
- Owner, same chat, choosing to fix it here rather than defer it.
- `resume.ts` module header — the recorded rejection of the now-playing topic as a *naming*
  source, and the live measurement that produced it.
- `resume.ts` `considerSession` — the `retry: true` branch and the 895 s stale-position
  observation that motivated it.
