# Person-card queue chooser

A person scan selects viewers; only a queue tap requests playback. Existing direct queue cards and session commands retain their behavior.

Publish non-retained JSON to `queuepilot/cmd/chooser/<reader>`; reader IDs are opaque ASCII letters, digits, hyphens or underscores. Bind card UIDs to the existing people IDs in the installation's scan controller. The application does not guess a person from their display name.

- Scan: `{ "action": "scan", "personId": "ada", "eventId": "unique-scan-id", "atMs": 1234567890000 }`. A scan must be at most 30 seconds old. Event IDs deduplicate deliveries for one minute; repeat physical scans do not duplicate people.
- Interact: `{ "action": "touch", "sessionId": "...", "revision": "..." }` renews the 60-second idle window.
- Choose: `action: "choose"` plus the current session/revision and `queueId`.
- Remove: `action: "remove"` plus the current session/revision and `personId`.
- Close/reset: `action: "dismiss"` or `"reset"` plus session/revision. The trusted local room controller may omit session/revision for `dismiss`, allowing an edge swipe to close the active selection.

Each reader has an isolated in-memory selection. Expiry, close, reset, removal of the last person, a successful choice or an application restart clears it. The next scan starts fresh. Selection revisions change when people change, preventing an old frame from selecting for a new audience.

`queuepilot/chooser/<reader>/state` retains a `queue-picker.v1` payload: session ID, revision, active flag, expiry time, selected `{id,name,artworkPath?}` people, and `{id,title,kind,profile?}` queues. CastKit validates and renders the presentation fields. Queue matching, titles, seasonal availability and superseded tiers share the existing TV/web rules. This chooser currently offers Plex watching queues, which the existing room playback controller can start. All matching queues remain separate choices.

`queuepilot/resp/chooser/<reader>` sends non-retained `show`, `close` and `play` events with that state. A `play` includes the selected `queue`. The installation responds to `show` with its temporary display override (remaining time until `expiresAt`), clears it on `close`/`play`, and routes a fresh `play` through its existing hardware/profile control path. The application never switches room hardware merely because a person was scanned. Do not retain commands or playback responses.

The UI sends interaction only when touched or operated by keyboard; receiving fresh state is not activity. A stale retained state is non-actionable after `expiresAt`. On tap the backend re-reads eligibility, checks expiry again after that read, then closes the selection before emitting one playback request.

Validation: `server/src/chooser.test.ts` covers accumulation, isolation, deduplication, expiry, removal, stale frames, delayed catalog reads and duplicate taps. `e2e/nfc-wire-contract-test.ts` drives the real broker subscription, scan, catalog response and selected playback intent alongside the existing direct-card contract.

People with an owned QueuePilot photo include a relative, versioned `artworkPath`
using the existing `/api/people/:id/photo?v=<version>` route. Replacing a photo
changes its URL; people without a photo omit the field so clients can draw initials.
The display source must configure its media base URL to QueuePilot. CastKit then
uses its existing origin-restricted, channel-authorized media proxy rather than
sending upstream credentials or deployment addresses to the display client.
