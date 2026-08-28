# QueuePilot owns its top-up timer and publishes the result over MQTT

- **Status:** Accepted
- **Date:** 2026-08-28
- **Type:** architecture / correction
- **Supersedes:** the schedule-ownership clause of [A lineup refills instead of ending, and HA ticks it](2026-08-17-a-lineup-refills-instead-of-ending.md), plus the HA time-pattern consequence in [The reading list is a maintained window](2026-08-17-the-reading-list-is-a-maintained-window.md)
- **Superseded by:** —

## Decision

**QueuePilot owns the two timers that maintain its own artifacts.** It checks a live push
session every five minutes and checks persistent pull lists every fifteen minutes. These are
application-lifecycle checks, not household schedules: the app already owns the session, the
playQueue id, the pull-provider registry, the thresholds and every guard that decides whether
a check writes anything.

Every scheduled pass publishes its outcome on `queuepilot/resp/topup`. Home Assistant may
observe failures there, but it does not publish the normal tick. The existing empty
`queuepilot/cmd/session/topup` command remains as the manual and compatibility seam; receiving
it runs both scopes once.

This does not reverse the house boundary for physical equipment or scheduled household work.
Home Assistant still decides whether a finished sitting turns the room off, and it still owns
calendar/nightly jobs whose time is itself household policy. A five-minute maintenance loop for
an in-process artifact belongs to the process that owns the artifact.

## Context

The first implementation inferred that every recurring wake-up belonged in Home Assistant.
It put five- and fifteen-minute time patterns in `automation.queuepilot_top_up_lineup`, which
published an empty MQTT command back to QueuePilot. QueuePilot then read its own session and
registry to decide what to do.

That automation was live in Home Assistant's `automations.yaml`, even though a later file-only
audit reported it absent because it checked only `/config/packages`. Live QueuePilot logs proved
that the automation was publishing on every fifteen-minute boundary. The normal answer was a
quiet no-op because the reading list held seven unread items and the top-up threshold was three.

The mechanism worked, but its ownership contradicted the owner's intended design and created a
second deployment that had to remain present for QueuePilot to maintain its own state.

## Why

- QueuePilot knows whether a session exists without reading its MQTT discovery sensor back from
  Home Assistant.
- QueuePilot can maintain a pull list that has no session without a second unconditional HA
  trigger.
- The existing cooldown and per-scope overlap guard make a slow or duplicated pass safe.
- MQTT remains the observation and manual-control boundary. It no longer acts as a loopback
  transport for QueuePilot to ask itself to inspect its own state.
- Removing the HA time patterns prevents two schedulers from running after the app deploys.

## Evidence

- Owner, T3 Code chat `t3code-0c395738`, 2026-08-28: “I thought it'd go in QueuePilot itself
  pushing out over MQTT, not Home Assistant.”
- Live container log, 2026-08-28 09:00 through 10:45 UTC: one `manga_webtoons` top-up check at
  every fifteen-minute boundary, each reporting `7 unread, tops up at 3`.
- Live Home Assistant config: `automation.queuepilot_top_up_lineup` supplied both time-pattern
  triggers from `automations.yaml`; `/config/packages/queuepilot_topup.yaml` did not exist.
- Gate: `server/src/topupScheduler.test.ts` pins both cadences, cleanup and no-overlap behavior.
