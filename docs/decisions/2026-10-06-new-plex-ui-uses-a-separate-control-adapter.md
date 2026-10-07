# New Plex UI uses a separate control adapter

- **Status:** Accepted
- **Date:** 2026-10-06
- **Type:** Compatibility / device control / owner preference
- **Supersedes:** —
- **Superseded by:** —

## Decision

Keep the existing Android TV Plex control adapter for clients running the older UI.
Detect the new single-activity Plex UI and route it to a separate control adapter.
Do not replace the legacy navigation with new selectors or require every client to update.

The new adapter reads accessibility resource IDs and the focused profile tile. It verifies
that the picker closes into signed-in navigation; the playback account audit remains the
independent authority for which account receives a play. A remembered account cannot bypass
an on-screen picker or onboarding.

The new playback adapter opens a server-scoped metadata deep link with the existing
`containerKey` playQueue. The link uses seconds for its initial resume offset. Keep the
Companion HTTP transport for older Plex and for other devices. Scope ADB commands to the
configured player, and preserve the independent server session/account audit after start.

The new app does not listen on the existing Companion endpoint. Unsupported remote
controls must return a clear failure rather than pretend a command worked. New playback
control support requires live verification with the dedicated test profile.

Pause, resume and next use remote key events while Plex owns the active media session.
Stop leaves the player through Back. Local seeking reopens the same queue at its
server-confirmed selected item and uses whole-second offsets; an unknown or mismatching
queue, or a selected item from a shared server, fails explicitly instead of changing media.

Per-profile first-run questions belong to the owner. Stop with an actionable setup message,
leave those questions untouched, and ask for a new scan after setup. Use a dedicated test
profile for live test playback and wait until the owner finishes watching before device work.

## Context

Plex's new Android TV UI keeps Home, profile menus and the user picker in
`com.plexapp.android/tv.plex.app.MainActivity`. The older adapter expects separate
`HomeActivityTV`, `ListDualPaneModalActivity` and `PickUserActivity` activities, and a selected
`title_text` node. Those assumptions fail on the new UI, whose picker tiles use
`switch-user-item-<index>` resource IDs and `focused="true"`.

## Why

A control adapter describes the UI a client actually runs. Updating the legacy adapter's
assumptions would break clients which have not adopted the new Plex UI. Separate adapters
allow both interfaces to remain supported and independently tested.

First-run questions can change a profile's library preferences. Automation must not answer
those questions merely to make a scan succeed.

## Evidence

Owner instructions in the 2026-10-06 QueuePilot troubleshooting conversation (chat ID is
not exposed by this runtime):

> "make sure to add another \"if new Plex UI\" and make another Plex control adapter for that."

> "That way, the old one works for people on older Plex."

> "When you start this new Plex on an account, it asks you some questions. I need to do that for all profiles"

The legacy adapter is preserved verbatim in `server/src/adbLegacy.ts`. The new adapter's
navigation and safety cases are covered by `server/src/plexControlModern.test.ts`; the
existing ADB and playback FSM harnesses continue exercising the legacy path.
