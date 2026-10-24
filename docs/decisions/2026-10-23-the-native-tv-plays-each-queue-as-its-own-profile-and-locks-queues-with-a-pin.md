# The native TV plays each queue as its own profile, and locks chosen queues with a PIN

- **Status:** Accepted
- **Date:** 2026-10-23
- **Type:** API / native TV / authorization / UI
- **Supersedes:** The authorization rule of [The native TV reads the whole queue…](2026-10-22-the-native-full-queue-history-and-watched-api.md) (a profile reads or plays only the queues it plays as) and item 2 of [The native TV adds a title only to a Picks queue it plays as](2026-10-23-the-native-tv-adds-a-title-to-a-picks-queue-it-plays-as.md). Everything else in both stands.
- **Superseded by:** —

## Decision

1. **The TV is authorized as a household device, not as one profile.** `X-Plex-Profile-Token`
   must verify (against plex.tv, as before) as the server owner or a member of the owner's Plex
   Home. Any other Plex account is the usual 403. The token is NOT required to be the queue's
   profile any more, and it is never used for a queue's grants.
2. **The server plays every queue as the queue's own profile.** `queuePlayAs()` reads it from
   the queue: `requires_profile`, else the routing binding, else the server owner. The server
   mints that profile's token with the owner's Home-user switch (`nativeScopeProof`, memoized
   ten minutes in memory) and uses it for item reads, the playback grants handed to the TV,
   scrobbles and timelines, and watched marks, so history lands on the queue's profile whoever
   holds the remote. A named profile the Plex Home no longer has is a stated refusal — never a
   silent fallback to the owner. Applies to the catalog, `/full`, sessions (including `start`),
   `/watched`, `/items`, and history.
3. **The catalog lists every queue** with `audience` (the web's audience line: required members,
   three names then `+n`, or "Anybody"), `playsAs` (display only), and `isLocked`. The
   `requiredProfile` field is removed: the TV no longer gates on it, and without it an older
   TV build plays every queue too.
4. **History covers every queue**, queue → sitting → items with the 75-minute rule unchanged,
   not filtered to the signed-in account. `profile` still names that account; `hiddenLockedQueues`
   counts queues left out because they are locked and not unlocked on this device.
5. **A queue can be "Locked on TV"** (`is_locked_on_tv`, sparse on the set, a switch with a
   lock icon in the queue's settings). **One household TV PIN** (4–8 digits) is set in the web
   app's new Settings page and stored as a salted scrypt hash in `native_tv_pin` — never the
   PIN. `POST /api/native/unlock {pin}` with `X-QueuePilot-Device` returns an unlock token valid
   for four hours, bound to that device id and that household account; only its SHA-256 is
   held, in memory. Every route of a locked queue without a valid `X-QueuePilot-Unlock` is
   **423** `{error, isLocked: true}`. A wrong PIN is 403 with `attemptsLeft`; five wrong PINs in a
   row lock out every attempt, from any device, for 60 seconds (429 + `Retry-After`). Changing
   or clearing the PIN revokes every unlock. **With no PIN set, nothing is locked.**
6. **A started sitting is not asked again.** Events and `continue` are authorized by the
   session key the locked start returned, so an unlock that expires mid-film does not stop the
   film. The web manages the PIN at `/api/tv-lock`, outside `/native`, so the device a PIN locks
   cannot change it with its Plex token.

## Context

The TV gated every queue on its play-as profile: the player showed "Switch to that profile" on
the full queue and a "Play as … Switch and play" dialog on start, and the server's
`authorizeQueue()` refused any profile but the queue's own. Only the queues of the profile the
TV happened to be signed in as could be used without switching. The queue already names the
profile it plays as, so the switch asked a question QueuePilot had answered.

## Why

Who a queue plays as is configured once, on the queue, and the server can already mint that
profile's grant itself; making the viewer switch profile repeats it and blocked the app's main
function. Keeping some queues from some viewers is a per-queue concern, which a PIN expresses
directly, where a profile switch only approximated it. The device check stays fail-closed, and
the profile check moves from "who is holding the remote" to "who the queue says it plays as",
which is the identity that decides whose history a play writes.

Profile choice remains where it changes what is shown outside queues — library browsing,
search, title screens, and playing a single title outside a queue use the profile the viewer
chose. Those paths talk to Plex with the TV's own profile token and are not queue routes.

## Evidence

The owner's direction, 2026-10-23, recorded with the quotes in the private project notes
(`queuepilot-project-notes`, the 2026-10-23 decision on the TV playing every queue as its own
profile): a profile choice in front of a queue is unnecessary because the queue already names
it, and locking chosen queues with a PIN is the restriction to use instead. Covered by
`server/src/nativeTv.test.ts` ("plays a gated queue as the profile it names, whoever is signed
in", "native TV catalog …", "native TV PIN lock") and `server/src/nativeHistory.test.ts`, with
fixture data.
