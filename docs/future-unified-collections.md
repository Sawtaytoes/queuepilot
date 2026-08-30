# Future unified collections and playback

**Status:** Future planning. This document is not part of the current Collection UI change.

QueuePilot can grow from one board-game shelf into a set of QueuePilot-maintained collections.
The first implementation only adds the collection picker and the Board Games detail route. It
does not claim that QueuePilot can import, synchronize, or start playback in the services below.

## Product boundary

A QueuePilot collection is an indexed view of items from one or more configured providers. A
provider remains the authority for its own library, watchlist, progress, and credentials. The
QueuePilot database stores provider-neutral item identity, provider references, normalized
metadata needed by queues, and synchronization state. It does not silently merge two titles only
because their names match.

The design must keep three concepts separate:

1. A **provider library** reports items the provider can access.
2. A **provider watchlist** reports items an account wants to watch or read.
3. A **QueuePilot collection** selects and presents normalized items from those sources.

## Proposed delivery phases

1. Define provider-neutral `collection`, `collection_source`, `media_item`, and
   `provider_item` records. Add explicit external identifiers and a review state for uncertain
   matches. Keep board games on the existing API until the new schema has equivalent behavior.
2. Add read-only adapters one provider at a time. Plex, Kavita, Jellyfin, Emby, and Kodi each
   require a capability audit for libraries, watchlists, progress, artwork, and playback. A
   missing provider API remains visible as an unsupported capability.
3. Add scheduled synchronization with cursors, provenance, deletion tombstones, rate limits,
   and a per-source health record. QueuePilot must preserve a provider's last successful snapshot
   when a later synchronization fails.
4. Add opt-in cross-provider identity matching. Prefer stable IDs such as TMDB, TVDB, IMDb, ISBN,
   and provider-native IDs. Put ambiguous matches in a review queue. Do not use title-only matches
   as authoritative links.
5. Add unified watchlist views and queue eligibility only after synchronization and identity tests
   cover partial outages, duplicates, editions, seasons, and provider removals.
6. Add playback handoff as a separate capability. Each adapter must declare whether it can deep
   link, remote-control an existing player, report completion, and select an account or profile.
   Automatic movement between apps requires an explicit device session and a verified completion
   event. A timer or inferred duration is not sufficient.

Commercial streaming services such as Netflix and Amazon need separate research. QueuePilot must
not depend on undocumented private APIs or automate credentials in a way that violates provider
terms. A supported deep link may be the only safe capability for some services.

## YouTube authorization research

YouTube account access will probably require a Google Cloud project, an OAuth consent screen, and
OAuth 2.0 credentials for the YouTube Data API. The exact account type, verification requirements,
scopes, quotas, redirect URI, and token-storage rules must be confirmed against current Google
documentation before implementation.

The initial YouTube scope should be read-only and minimal. QueuePilot should store refresh tokens
as credentials outside the public repository, encrypt them with the existing credential mechanism,
and support revocation. The design must decide whether the source is a playlist, Watch Later, liked
videos, subscriptions, or an explicit QueuePilot playlist because the API can expose different
capabilities for each. Playback through an embedded player or a YouTube app handoff is a later and
separate capability from metadata synchronization.

## Required decisions before implementation

- Which provider and source type is the first integration after Board Games.
- Whether one collection can contain several media kinds or keeps one activity per collection.
- Whether QueuePilot mirrors watchlist membership or can write changes back to a provider.
- Which metadata source resolves cross-provider identity conflicts.
- Which playback devices QueuePilot can control and how it verifies completion.
- Which OAuth deployment model fits a self-hosted instance and its callback address.

Each provider needs a documented capability matrix and a small read-only proof before QueuePilot
adds it to the collection picker.
