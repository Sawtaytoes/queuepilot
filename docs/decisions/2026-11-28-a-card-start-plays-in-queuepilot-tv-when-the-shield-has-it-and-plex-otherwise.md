# A card start plays in QueuePilot TV when the Shield has it, and in Plex otherwise

- **Status:** Accepted
- **Date:** 2026-11-28
- **Type:** Playback routing / native TV / device control
- **Supersedes:** —
- **Superseded by:** —

## Decision

1. **A named Plex queue's start plays in QueuePilot TV when the target Shield can take it.**
   An NFC card, the chooser, and the remote all publish `session/start`. Before the server opens
   Plex, `tvAppStart.routeStart()` decides the app, in this order:
   - `set: "auto"` stays on Plex: it reads the profile Plex is signed into. A web
     "play this entry" (`only`) also stays on Plex.
   - Every provider of the queue must be of kind `plex`, as `authorizeQueue` requires. A second
     Plex server with its own provider id qualifies. QueuePilot TV plays no other kind.
   - The Shield must answer `cmd package resolve-activity` for the action
     `dev.queuepilot.player.action.START_QUEUE` in the package `dev.queuepilot.player.prototype`.
     An older build of the app does not declare the action, so it is never sent a start that it
     would treat as a plain launch.
   - The native API's own check must accept the queue: `authorizeQueue(id, null)`, the same
     function `POST /api/native/sessions` runs, with no device so the TV PIN is left to the TV.
     A queue it refuses (a binding that does not match its profile, a disabled queue) stays on
     Plex, and the log names the reason.
   - The card's `profile`, when it names one, must be the profile `authorizeQueue` plays the
     queue as, by title or username. Plex plays an ungated queue as the card's profile, and
     QueuePilot TV cannot, so that start stays on Plex.
   The checks run cheapest first: the request, then one ADB read, then the native check.
2. **The remote start is an explicit intent with the queue id and nothing else.** The server
   wakes the Shield if it sleeps, then sends
   `am start -a dev.queuepilot.player.action.START_QUEUE -c android.intent.category.DEFAULT -p
   dev.queuepilot.player.prototype --es dev.queuepilot.player.extra.QUEUE_ID <id>
   --activity-clear-top --activity-single-top`, and waits up to 5 seconds for the app to be in
   front. Only an id of letters, digits, `_`, and `-` is sent, because `adb shell` joins its
   arguments into one remote shell line. A start cancelled or replaced while the Shield wakes
   sends no intent.
3. **The app keeps every native check.** It starts the queue with `POST /api/native/sessions`,
   with its own household-device Plex token, exactly as a press on a queue card does. A queue
   locked on the TV asks for the TV PIN on the screen. The intent carries no token or unlock, so
   a remote start can do nothing that a person with the remote cannot.
4. **The server keeps no sitting for a QueuePilot TV start.** It clears `SESSION` completely
   (no set, profile, device, playQueue, or lineup) and disarms the resume and section watchers,
   so advance, top-up, and the Plex completion watcher have nothing to extend or announce. The
   app owns and continues the queue. The state payload's `playback` is
   `{isDispatched: true, app: "queuepilot-tv", queue: <id>}`, never `played`, because the app may
   still ask for the TV PIN. The web app shows "Sent to QueuePilot TV", and
   `sensor.queuepilot_status` reads `sent`.
5. **A refused QueuePilot TV start is a stated error, never a quiet switch to Plex.** It names
   the queue and the reason.
6. **Every other start opens Plex and takes the Plex path, as before.** This includes the
   profile gate and the picker walk. `TV_APP_START=false` sends every start to Plex.
7. **A check that reads the Plex server's log first closes QueuePilot TV, after it saved.** The
   log line for a request names the profile but not the app, and QueuePilot TV signs its own
   requests with a profile's device token from the Shield's address. A paused player in the
   background can still load media. So `set: "auto"` (when Plex's own session does not name the
   account) and the log-based gate (`PLAYBACK_FSM=false`) call `closeAfterPlexOpens()` once
   Plex is in front, before their watch starts at the log's end:
   - The server waits up to 10 seconds for every QueuePilot TV activity to report `STOPPED` or
     `DESTROYED` in `dumpsys activity activities`. The app saves its resume position in
     `onStop` and waits for the save there, so it is never ended before it saved.
   - Then it force-stops the app and checks that no process is left.
   - A failed probe, an app that has not finished `onStop`, or a process that outlived the
     stop means no log line is trusted. The start fails with a sentence that says QueuePilot TV
     is still open.
   - With no ADB to the Shield, the server can neither see nor close the app, and the log is
     read as before. A setup that runs QueuePilot TV and a log-based check needs ADB.
   The FSM path for a named queue reads Plex's own session, not the log, so it leaves
   QueuePilot TV alone.

## Context

A card, chooser, or remote start could only drive Plex over ADB, even on a Shield where
QueuePilot TV plays the queue natively. Plex 2026.23.1 also broke the Plex profile switch (see the
next paragraph), so every start of a profile-gated queue failed with a "the Shield did not switch
to it" error. The owner chose that starts work with both apps: QueuePilot TV first, and a working
Plex route.

The same day's Plex fix: Plex 2026.23.1 focuses a launcher alias of `tv.plex.app.MainActivity`
(`.MainActivityDefault`, and one alias per app icon), so `isModernPlexActivity()` now accepts
`com.plexapp.android/.MainActivity<Name>` as the new UI. Before, the alias fell to the legacy
adapter, which looks for `HomeActivityTV` and `PickUserActivity`, activities this Plex does not
have.

## Why

QueuePilot TV already plays each queue as the queue's own profile with no profile switch
(2026-10-23 record), so a card that starts there needs no picker walk at all. Asking Android
whether the installed build declares the start action detects the capability itself, rather than
a version number that a side-loaded or rolled-back build could contradict. Sending only the id
keeps the server out of the app's authorization: the device token and the PIN stay where the
2026-10-23 record put them. Keeping `auto`, single entries, other providers, and disagreeing
cards on Plex keeps each start's history where it went before.

## Evidence

Owner direction, 2026-11-28, recorded in the private project notes. Tests, with fixture data:

- `server/src/tvAppStart.test.ts`: the routing rule, the Shield check, the native check, the
  intent, a sleeping Shield, a start cancelled during the wake, ids a shell would read, and
  closing QueuePilot TV only after it finished `onStop`, with each failure kept untrusted.
- `server/src/sessionTvApp.test.ts`: a routed start never opens Plex, builds a lineup, or
  leaves a sitting; a refused start is an error; each log-reading path closes QueuePilot TV
  after Plex opens and before it watches the log, and refuses when the app may still run; and
  the FSM path leaves the app alone.
- `server/src/adbAdapters.test.ts`: the Plex launcher aliases.
- `e2e/nfc-wire-contract-test.ts`: the sensor state that the published template gives each
  kind of state payload, read by a reader that refuses a malformed template.
