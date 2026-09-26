# A Plex queue can mix items from several servers

- **Status:** Accepted
- **Date:** 2026-09-25
- **Type:** product rule / playback / identity / access control
- **Supersedes:** —
- **Superseded by:** —

## Decision

One QueuePilot Plex queue may contain items from the home Plex server and any shared Plex
server granted to the queue's selected Plex Home profile. They remain one ordered lineup. The
owner does not choose one server for the whole queue.

A shared entry stores the granting server's machine identifier as `plex_server` beside its
`ratingKey`. Its ordinary line key is `server:<plex_server>:rk:<ratingKey>`; a local entry keeps
the existing `rk:<ratingKey>`. The optional opaque `id:` still outranks both when a deliberate
duplicate needs a second line.

The queue editor discovers servers from the selected account's current plex.tv resources,
searches only libraries in that grant, and proxies artwork without returning a server token or
connection URL. Playback chooses the server of the first item as the playQueue host and appends
each consecutive source run with Plex's cross-server `server://...` URI. Thus either a local or
a shared item may lead, and later items may alternate servers without reordering the lineup.

The HA now-playing feed names only a rating key. If two items in one lineup have the same key
on different servers, it cannot assign live position to either queue-owned ledger entry.
QueuePilot must abstain from that write and from a tile highlight rather than attribute the
play to the wrong server. Plex's own per-server watch history still records the play. Manual
"track current" for a shared item started outside QueuePilot is unavailable for the same
reason; manual completion of a known shared entry remains available.

## Context

QueuePilot already showed the shared servers and libraries available to a profile, but the
editor stopped at a read-only inventory. Its text explicitly said their items could not be
added. The open product question was whether each queue should choose one server or whether a
single queue should contain both.

Live Plex probes then built a two-item playQueue in both directions: home first with a shared
append, and shared first with a home append. Plex retained both items. That made the mixed
lineup a supported server behavior rather than a speculative UI promise.

## Why

- The server is an item property. Requiring a server-wide queue split would turn one viewing
  list into several lists for a storage detail the viewer does not care about.
- A rating key is only unique within one Plex server. Server-scoped identity prevents a local
  `42` and a shared `42` from becoming the same queue line or duplicate result.
- The profile grant is checked again when searching, resolving, adding and playing. A stored
  server id is an address, not authorization.
- Tokens, server URLs and resource grants remain on the server. The browser receives only the
  public server name, machine identifier, library labels and proxied artwork URL.
- Existing local-only queue files and playQueue calls retain their old shape and behavior.

## Evidence

- Owner, 2026-09-25: “Mix servers in one queue.” Chat
  `81c531b4-0b34-4e71-a916-667518d1eef1`.
- Live Plex probe in the same chat: a home-hosted playQueue retained a home item followed by a
  shared item, and a shared-hosted playQueue retained a shared item followed by a home item.
- `server/src/mixedPlayQueue.test.ts` pins source grouping without changing lineup order.
- `server/src/sharedPlexIdentity.test.ts` pins both entry-key readers to the same server-scoped
  identity.
- `server/src/plexSources.test.ts` pins grant-token use and allowed-library search scope.
