# Native Plex TV sessions

Native TV players use `/api/native` for a Plex-only queue catalog, the existing people
filter, engine-selected playback plans, and durable progress. Queue selection calls the
same provider `buckets` implementation used by other playback transports. It preserves
entry batches, profile binding, source server identities, section windows, completion
policy, and lead windows. It never calls the ADB, Companion or room-control transport.

- `GET /api/native/queues?people=<comma-separated-person-ids>` returns Plex queues and a
  projected roster. Empty selection means no filter. Required/optional members and group
  minimums use `queueMatchesSelection`; selecting people does not pick a playback profile.
  Each queue's `title` is the one the web Queues page prints: `queueTitle` and
  `queueListNumbers` from `shared/queueTitle.ts`, numbered over the whole registry before
  the people filter, so a typed name is kept verbatim and a nameless queue reads
  "Movies & Shows", "Movies & Shows 2", ….
- `GET /api/native/people/:id/avatar` returns an image from the person's explicitly linked
  Plex account when unambiguous. Missing artwork returns 404. Image redirects are restricted
  to HTTPS Plex image hosts and Gravatar; credentials are not forwarded.
- `POST /api/native/sessions`, body `{setId}`, requires `X-Plex-Profile-Token` from Plex PIN
  authorization. Plex verifies the actual account UUID. The queue binding must match before
  selection. The response contains ordered media identities, resume/section positions, the
  home server identity, and a random `sessionKey`; it contains no Plex credentials or media URLs.
- `POST /api/native/sessions/:id/events` requires `X-Native-Session-Key`. Include `X-Plex-Profile-Token` again to renew
  the same profile grant after a service restart. Events identify an
  event ID, increasing sequence, current item index, state, position and duration. Retries of
  a committed event are idempotent. The server sends a scoped Plex timeline and uses the
  existing completion reconciliation for QueuePilot-owned progress. Plex judges completion;
  the client does not invent a watched percentage. Authored section boundaries remain distinct.
- `POST /api/native/sessions/:id/continue` requires the same key and renewal proof. After the current plan is
  finished, the engine can produce the next window within the sitting's playback length.
  Previously handed-over identities are excluded. Exhaustion returns `{complete:true}`.

Sessions and event receipts live in the book of record. Only a hash of the capability key
is stored; Plex proof and server tokens are not persisted in these tables. Session access
expires after 24 hours. The native client encrypts pending progress locally and retries it
in order. Expired or invalid grants cannot authorize new history writes. They require review
rather than silently acquiring owner privileges.

The player independently resolves each server through the selected Plex account and streams
with that server's scoped credential. A queue may cross granted Plex servers. Unsupported
files still require future transcode negotiation; this API does not claim faithful ASS,
HDR conversion, Dolby Vision or passthrough support. Native playback never powers a room down.

The schema adds native session/event tables at version 9. Back up the book of record before
upgrading; rolling back to a pre-9 image requires its corresponding database backup or the
existing YAML rollback path.

Cloud authorization, direct server grants, metadata and timeline requests use an explicit
certificate-verifying TLS dispatcher, independent of legacy process TLS settings. Relay
connections and public cleartext HTTP are excluded. The server verifies each granted
server identity before using its scoped token. Runtime credentials are kept in memory.
