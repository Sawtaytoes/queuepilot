# Native Plex TV sessions

Native TV players use `/api/native` for a Plex-only queue catalog, the existing people
filter, engine-selected playback plans, and durable progress. Queue selection calls the
same provider `buckets` implementation used by other playback transports. It preserves
entry batches, profile binding, source server identities, section windows, completion
policy, and lead windows. It never calls the ADB, Companion or room-control transport.

## Who may use a queue, and whom it plays as

Decision: `docs/decisions/2026-10-23-the-native-tv-plays-each-queue-as-its-own-profile-and-locks-queues-with-a-pin.md`.

- **The TV is a household device.** `X-Plex-Profile-Token` must verify at plex.tv as the server
  owner or a member of the owner's Plex Home (`nativeVerifiedProfile`). Any other account is
  403. It does NOT have to be the queue's profile, and it is never used for a queue's grants.
- **Every queue plays as its own profile.** `queuePlayAs()` (`server/src/nativeAccess.ts`):
  `requires_profile`, else the routing binding, else the server owner. The server mints that
  profile's token with the owner's Home-user switch and uses it for item reads, the playback
  grants it hands the TV, timelines, scrobbles, and watched marks. A named profile that is not
  in the Plex Home is a stated refusal, never the owner's history.
- **Library browsing, search, title screens, and single-title playback are not queue routes.**
  The TV does those with the profile the viewer chose and its own token, directly against Plex.
- **TV PIN lock.** A queue with `is_locked_on_tv` (the "Locked on TV" switch in the queue's
  settings) needs the household TV PIN while one is set (web Settings, `/api/tv-lock`). Send
  `X-QueuePilot-Device: <stable install id>` on every native request and
  `X-QueuePilot-Unlock: <token>` once unlocked. Without a valid unlock, every route of a
  locked queue answers **423** `{error, isLocked: true}`. With no PIN set, nothing is locked.
- `POST /api/native/unlock`, body `{pin}`, headers `X-Plex-Profile-Token` and
  `X-QueuePilot-Device` → `{unlockToken, expiresAt}`. The unlock is valid for four hours, for
  that device and that household account only. Wrong PIN: 403 `{error, attemptsLeft}`. The
  fifth wrong PIN in a row, and every attempt for 60 seconds after it from any device: 429
  `{error, retryAfterSeconds}` with `Retry-After`. No PIN set: 409. No device header: 400.
  Changing or clearing the PIN revokes every unlock. The PIN is stored only as a salted
  scrypt hash (`native_tv_pin`).
- The web side: `GET /api/tv-lock` → `{hasPin}`, `PUT /api/tv-lock/pin {pin}` (4–8 digits),
  `DELETE /api/tv-lock/pin`. It is outside `/native` on purpose.

## Routes

- `GET /api/native/queues?people=<comma-separated-person-ids>` returns EVERY Plex queue and a
  projected roster. Each queue carries `audience` (the web's audience line), `playsAs` (the
  profile name it plays as, for display only), and `isLocked`. There is no `requiredProfile`
  and no profile filtering. Empty selection means no people filter. Required/optional members and group
  minimums use `queueMatchesSelection`; selecting people does not pick a playback profile.
  Each queue's `title` is the one the web Queues page prints: `queueTitle` and
  `queueListNumbers` from `shared/queueTitle.ts`, numbered over the whole registry before
  the people filter, so a typed name is kept verbatim and a nameless queue reads
  "Movies & Shows", "Movies & Shows 2", ….
  A superseded legacy Rules tier (`isSupersededTier`) is not listed, exactly as no web picker
  lists it; its id still plays through `POST /api/native/sessions`.
- `GET /api/native/people/:id/avatar` returns the person's QueuePilot photo when one is set
  ([person photos](person-photos.md)). Otherwise it returns an image from the person's
  explicitly linked Plex account when unambiguous. Missing artwork returns 404. Image
  redirects are restricted to HTTPS Plex image hosts and Gravatar; credentials are not
  forwarded.
- `POST /api/native/sessions`, body `{setId, start?}`, requires `X-Plex-Profile-Token` from Plex PIN
  authorization. Plex verifies the actual account UUID belongs to the household. The session
  plays as the queue's own profile (`profileName`, `profileUuid` in the plan). The response contains ordered media identities, resume/section positions, the
  home server identity, and a random `sessionKey`; it contains no Plex credentials or media URLs.
  `start` = `{entryKey, ratingKey, plexServer?, mode: "continue" | "only"}` (Picks queues only)
  begins at a picked item: `continue` plays it, the rest of its entry that is not watched, then
  the engine's lineup; `only` plays it alone and does not refill. Nothing before the pick is
  marked or skipped, and no lead window is spent.
- `POST /api/native/sessions/:id/events` requires `X-Native-Session-Key`, which is the whole
  authorization: after a service restart the server mints the queue profile's grant again
  itself, and the lock is not asked again mid-sitting. Events identify an
  event ID, increasing sequence, current item index, state, position and duration. Retries of
  a committed event are idempotent. The server sends a scoped Plex timeline and uses the
  existing completion reconciliation for QueuePilot-owned progress. Plex judges completion;
  the client does not invent a watched percentage. Authored section boundaries remain distinct.
- `POST /api/native/sessions/:id/continue` requires the same key. After the current plan is
  finished, the engine can produce the next window within the sitting's playback length.
  Previously handed-over identities are excluded. Exhaustion returns `{complete:true}`.

### Full queue, history, watched marks, and adds

Same headers, same checks as a session (`authorizeQueue()` in
`server/src/nativeAccess.ts`): a household device, plus the TV PIN for a locked queue. A stated
refusal is 400/404/409 with `{error}`, a locked queue is 423; anything else is 403. Decision: `docs/decisions/2026-10-22-the-native-full-queue-history-and-watched-api.md`.

- `GET /api/native/queues/:setId/full` →
  `{setId, kind: "picks"|"rules", layout: "grid"|"list", isWholeQueue, isLineupShuffled,
  lineup: {count, endPosition}, isTruncated, entries: [{entryKey, title, type, lane,
  watchHistory, isShuffled, isUnresolved, items: [{position, ratingKey, serverId, plexServer,
  title, type, show, season, episode, isSpecial, durationMs, state:
  "watched"|"in_progress"|"unwatched", offsetMs, section: {startMs, endMs}|null, lineupIndex,
  isNext, canMarkWatched, artwork: {thumb, parentThumb, grandparentThumb, art}}]}]}`.
  `layout` is `grid` only when movies outnumber episodes. `endPosition` is the flattened
  position of the last lineup item. Artwork paths are relative to `serverId`. A Rules queue
  returns one `type: "lineup"` entry holding its lineup (`isWholeQueue: false`).
- `GET /api/native/history?days=30` (1–365) →
  `{profile: {uuid, name}, hiddenLockedQueues, sittingGapMinutes: 75, since, queues: [{setId, title,
  lastWatchedAt, sittings: [{startedAt, endedAt, items: [{setId, entryKey, ratingKey,
  plexServer, title, show, season, episode, type, startedAt, endedAt, state:
  "finished"|"partial", positionMs, durationMs, source: "native-tv"|"queue-ledger",
  isTimeApproximate}]}]}]}`. Times are epoch ms. A sitting is one queue's plays cut by a gap
  over 75 minutes. Only native TV plays and queue-ledger completions count; see the decision
  for exactly what that leaves out. Every queue's plays are included, whichever profile it
  plays as; `profile` names the signed-in account and does not filter. A locked queue is left
  out unless this device holds an unlock, and `hiddenLockedQueues` counts what was left out.
- `POST /api/native/queues/:setId/watched`, body `{entryKey, ratingKey, plexServer?,
  isWatched}` → `{entryKey, ratingKey, state}`. Queue-owned (`watch_history: queue`) items
  only; a Plex-history entry is 409 because QueuePilot never writes Plex's watched state.
- `POST /api/native/queues/:setId/items`, body `{ratingKey, plexServer?}` →
  `{added, key, duplicateOf?, title}`. Adds a movie or show to the top of a Picks queue,
  through the web route's own `addQueueItem()` (shared-server check,
  duplicate guard, write). The item is read through the queue profile's grant first: 404 when
  it cannot see it, 400 unless it is a movie or a show. `plexServer` may be the home server's
  own id. A Rules queue is 409. Decision:
  `docs/decisions/2026-10-23-the-native-tv-adds-a-title-to-a-picks-queue-it-plays-as.md`.

Sessions and event receipts live in the book of record. Only a hash of the capability key
is stored; Plex proof and server tokens are not persisted in these tables. Session access
expires after 24 hours. The native client encrypts pending progress locally and retries it
in order. Expired or invalid grants cannot authorize new history writes. They require review
rather than silently acquiring owner privileges.

The player independently resolves each server through the selected Plex account and streams
with that server's scoped credential. A queue may cross granted Plex servers. Unsupported
files still require future transcode negotiation; this API does not claim faithful ASS,
HDR conversion, Dolby Vision or passthrough support. Native playback never powers a room down.

The schema adds native session/event tables at version 9. `native_tv_events.recorded_at`
(epoch ms, nullable) arrives through the additive column check; older rows stay NULL. Back up the book of record before
upgrading; rolling back to a pre-9 image requires its corresponding database backup or the
existing YAML rollback path.

Cloud authorization, direct server grants, metadata and timeline requests use an explicit
certificate-verifying TLS dispatcher, independent of legacy process TLS settings. Relay
connections and public cleartext HTTP are excluded. The server verifies each granted
server identity before using its scoped token. Runtime credentials are kept in memory.
