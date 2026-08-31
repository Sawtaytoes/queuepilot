# A streaming service is a catalog read and a launch hand-off, not an API integration

- **Status:** Accepted
- **Date:** 2026-08-30
- **Type:** architecture / provider seam / scope
- **Supersedes:** —
- **Superseded by:** —
- **Companion:** [The watch-history source is a provider capability](2026-08-30-the-watch-history-source-is-a-provider-capability-and-queuepilot-is-the-fallback.md)

## Decision

**A subscription streaming service is a provider kind whose catalog comes from a metadata service
and whose playback is a hand-off to a real device.** QueuePilot never talks to the streaming
service.

Three parts.

1. **The catalog is read from TMDB**, which carries JustWatch availability data. Titles come from
   `/discover/*` filtered by `with_watch_providers` and `watch_region`; per-title availability
   comes from `/{movie,tv}/{id}/watch/providers`. Provider ids are resolved at runtime from
   `/watch/providers/*` and never hard-coded, because they are region-scoped.
2. **The TMDB key is supplied per deployment**, alongside the existing provider tokens. QueuePilot
   ships no key and embeds no key. An installation without a key does not get streaming providers,
   and that is a documented setup step rather than a defect.
3. **Playback is a deep link published over MQTT.** QueuePilot publishes the link and the target
   player. Something else — Home Assistant, in the first implementation — opens it on the device.
   QueuePilot gains no Home Assistant client, no device client and no player-specific code.

**Attribution to JustWatch is mandatory and ships with the feature**, not after it. TMDB's terms
state that use of watch-provider data requires attributing JustWatch as the source, and that
non-compliance revokes API access. Any surface that shows availability carries the credit.

**What is explicitly not built:** no use of a streaming service's private application API, no
token extracted from a signed-in session, and no attempt to start or control a stream. All three
are blocked by DRM in practice and by terms of service in principle.

## Context

The request was to support someone who subscribes to several streaming services instead of running
a Plex library, starting with Disney+ on an Apple TV 4K, and the opening question was whether an
API key could be obtained from the account holder.

There is no such key. No major subscription service runs a public developer programme. The private
API behind the apps needs a short-lived device-bound token from a signed-in session, and playback
is DRM-locked regardless, so a token would not make a stream playable. Research is recorded in
[streaming-service feasibility](../streaming-service-feasibility.md).

What survives that is narrow but real: a third party knows the catalog, tvOS supports deep links,
and Home Assistant can already drive an Apple TV through `pyatv`. Those three facts are the whole
design.

## Why

- **The seam already permits it.** The provider seam was written around a client interface rather
  than a URL, which is what let the board-game provider swap transport without the provider file
  changing ([ADR](2026-08-25-the-board-game-provider-reads-rows-and-still-posts-a-play-over-http.md)).
  A provider whose reads go to a metadata service and whose "start" is a published link is an
  unusual client, not a new seam.
- **TMDB over the alternatives.** JustWatch publishes no developer API; everything on offer there
  is a scraper. Watchmode is a real self-serve API, but its free tier excludes the deeplink field
  that would be most useful and its paid tiers start far above a household tool. Younify Connect
  sells exactly the right data and ships only mobile SDKs, so a Node server cannot be its client.
  TMDB is free, self-serve, and its per-account key model matches how provider credentials already
  work.
- **A per-deployment key, because the data is not ours to redistribute.** Bundling one key would
  pool every installation's requests under one account and would sit badly with the attribution
  terms. It is the same posture as the Plex token.
- **MQTT, because the household half does not belong in a public repository.** Which Apple TV,
  which room, which automation — all of that is Home Assistant's, and it already is. QueuePilot
  publishing a link keeps the design working for any player Home Assistant can drive.
- **A hand-off is honest about what it is.** QueuePilot's Plex path pushes a `playQueue` and can
  state that playback started. Opening a deep link cannot make that claim. The interface says the
  title was opened, and completion arrives separately, or by hand.

## Consequences

- **A streaming queue's history is queue-owned**, per the companion record. How accurate it is
  depends on whether the player reports back what it played. Home Assistant's Apple TV integration
  exposes the active app and playback state, and community reports say Disney+ generally supplies
  media metadata, with artwork the unreliable part. **This project has not verified it**, and it is
  the first thing to test, because a blind launch means the honest product is a launcher with a
  manual mark-complete.
- **Deep links are expected to break.** `pyatv`'s own documentation says a number of them have
  stopped working over time. Every link needs a fallback that opens the bare app rather than
  failing to nothing.
- **Availability data decays.** TMDB does not document a refresh interval, so a title can be listed
  after it has left the service. The launch attempt is what discovers this, not the catalog read.
- **Discover is capped at 10,000 items per query** — 20 per page, 500 pages — regardless of the
  reported total. A large regional catalog needs date-segmented queries.
- **One provider per queue still holds.** A streaming queue is that service and nothing else, the
  same as every other queue
  ([ADR](2026-08-13-a-queue-draws-from-exactly-one-provider.md)). Nothing here reopens mixing.

## Evidence

Owner, chat 2026-08-30:

> "Sounds like you said TMDB knows the catalog reliably? And it's an open API we could use. I have
> a token already. If other folks want QueuePilot, they'll need an API token as well."

> "It would be even better if you could start the Disney+ app on the Apple TV via Home Assistant
> and then tell it to play/queue something specific."

> "QueuePilot knows nothing of Home Assistant as far as I know. It only talks MQTT, and HA has a
> native integration which is how we're automating that connection."

Supporting documentation, read 2026-08-30: TMDB's watch-provider endpoints and their JustWatch
attribution requirement; TMDB's 500-page Discover cap; `pyatv`'s `launch_app` accepting a bundle id
or a URL, with a working Disney+ deep-link example; Home Assistant's Apple TV integration exposing
`media_player.select_source` and `media_player.play_media` with `media_content_type: url`.
