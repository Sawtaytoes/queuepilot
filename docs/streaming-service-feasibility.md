# Streaming-service feasibility — can QueuePilot queue a subscription service?

**Verdict: yes as a queue and a launcher, no as an integration.** A subscription streaming
service is not a provider in the sense Plex and Kavita are. It has no API to hold, it cannot be
asked what you watched, and its playback is DRM-locked so nothing outside its own app can start a
stream. What is reachable is a *catalog* (from a third party), a *deep link* (into the service's
own app on a real device), and a *watch history* (from a third party, or from QueuePilot itself).

- **Researched:** 2026-08-30, against published documentation only. Nothing here was called
  against a live account, and no credential was used. Every row marked "unverified" below is a
  claim from a vendor document that this project has not reproduced.
- **Worked example throughout:** Disney+ on an Apple TV. It is the hardest common case — no API,
  no local server, and a player that is not a Plex client.

> **Why this document exists.** The provider seam
> ([ADR](decisions/2026-08-12-backends-are-providers-behind-a-media-neutral-seam.md)) was written
> for services that answer questions. Every provider shipped so far — Plex, Kavita,
> BoardGameGeek, Steam, MiSTer — has a real API, and most of them are self-hosted. A subscription
> streaming service breaks that assumption in three separate places at once, and the three
> breakages have three different answers.

---

## 1. What is not available, and will not become available

| Want | Reality |
| --- | --- |
| A published API | None. The major subscription services run no public developer programme and issue no API keys. Business integrations are partnerships. |
| An "API key" from a subscriber | Does not exist as a thing a subscriber can be given. There is nothing to hand over. |
| The app's own private API | Real, but it is an internal service reached with a short-lived device-bound token pulled out of a signed-in session. Using it breaks the terms of service. It is not a design this project will adopt. |
| Starting a stream from our own code | Blocked by DRM (Widevine / PlayReady / FairPlay). Even a valid token does not make a stream playable outside the licensed app. |

The consequence is structural, not a matter of effort: **playback is a hand-off, never a push.**
QueuePilot's Plex path materialises a `playQueue` and pushes it to a client. No equivalent exists
here. The most QueuePilot can do is open the right screen in the right app on the right device.

## 2. The catalog — what is on the service

### 2.1 TMDB (JustWatch data) — the chosen source

TMDB carries JustWatch's availability data and exposes it two ways:

| Need | Endpoint |
| --- | --- |
| Where can I watch this one title | `GET /3/movie/{id}/watch/providers`, `GET /3/tv/{id}/watch/providers` |
| What is on this service, in this region | `GET /3/discover/movie` and `/3/discover/tv` with `with_watch_providers=<id>`, `watch_region=<cc>`, `with_watch_monetization_types=flatrate` |
| The provider id for a service | `GET /3/watch/providers/movie?watch_region=<cc>` and the `tv` twin |

Four constraints, all of which shape the implementation:

1. **Attribution is mandatory.** TMDB states plainly: *"In order to use this data you must
   attribute the source of the data as JustWatch."* Non-compliance revokes API access. Any
   QueuePilot surface that shows availability carries a visible JustWatch credit. This is not
   optional and it is not a footnote in a settings page.
2. **The key is per-deployment.** TMDB issues a key to an account. QueuePilot ships no key and
   embeds no key. Each installation supplies its own, the way each installation already supplies
   its own Plex token — see
   [provider tokens live in a separate config file](decisions/2026-08-12-provider-tokens-live-in-a-separate-config-file.md).
3. **Discover is capped at 10,000 items.** 20 per page, 500 pages maximum, regardless of what
   `total_results` reports. A single service's regional catalog usually fits, but the cap is
   real and the documented workaround is date segmentation: read to page 500, take the last
   item's date, re-query with `primary_release_date.lte` set a day earlier, repeat.
4. **Provider ids are region-scoped and must be read, never hard-coded.** The same brand can
   carry different ids in different regions, and third-party write-ups disagree about which id
   is Disney+. Resolve it from `/watch/providers/*` at runtime and cache it.

Freshness is not documented. JustWatch data is refreshed on their schedule, not ours, so a title
can be listed after it has left the service. Treat availability as a *hint that decays*, and let
the deep-link launch be the thing that discovers a title is gone.

### 2.2 Alternatives, and why they are not the choice

| Source | Findings |
| --- | --- |
| **JustWatch directly** | No public developer API, no key programme, no developer portal. Everything on offer is a third-party scraper of their GraphQL endpoint. Not a dependency this project takes. |
| **Watchmode** | A genuine self-serve API: 200+ services, 50+ countries, episode-level availability, and iOS/Android deeplinks. Free "Developer" tier is 2,500 requests/month, non-commercial, 3 countries, attribution required, **deeplinks excluded**. Paid tiers start at $349/month. The free tier's request budget is thin for catalog building and the useful field is behind the paywall. Worth revisiting only if TMDB's data proves too coarse. |
| **Younify Connect** | See §3.3. It sells catalog *and* history, but its SDKs are iOS, Android, React Native and .NET MAUI — there is no server SDK, so a Node server cannot be the client. Pricing is unpublished. |

**TMDB is the choice** because it is free, self-serve, already understood, and its per-account key
model matches how QueuePilot already handles provider credentials.

## 3. Watch history — what was actually watched

This is the part with three candidate answers, and the reason for the companion decision record
[the watch-history source is a provider capability](decisions/2026-08-30-the-watch-history-source-is-a-provider-capability-and-queuepilot-is-the-fallback.md).

### 3.1 The service itself

Not available, for the reasons in §1. A subscription streaming provider reports
`canReportWatchHistory: false`, and that is a permanent property of the provider kind rather than
a gap waiting to be filled.

### 3.2 QueuePilot itself — the fallback

QueuePilot already has this machinery. The
[provider-history decision](decisions/2026-08-30-provider-watch-history-is-the-default-and-entries-can-opt-out.md)
landed a queue-owned completion ledger with manual mark-complete and undo controls, built for the
shared-profile rewatch case. A streaming provider reuses it unchanged. The difference is only that
queue-owned stops being an opt-out and becomes the sole option.

Accuracy then depends on the launch path being observed. Two grades:

- **Blind** — QueuePilot opens the deep link and assumes the item was watched. Wrong whenever
  someone stops after five minutes.
- **Observed** — the player reports back what it played and for how long, and QueuePilot records
  that. This is what §4 makes possible, and it is why the Apple TV path matters to the history
  design and not only to the automation.

### 3.3 An external history service

Two exist. Both are third-party aggregators, and both authenticate against the streaming account
on the user's behalf.

**Trakt.** Its "Streaming Scrobbler" is built on Younify's SDK.

| Question | Answer as of 2026-08-30 |
| --- | --- |
| Is it browser-based? | No. Connection happens in Trakt's iOS/Android app Settings, using the Younify Connect SDK. Credentials are handled on the device; a token is stored there. |
| Does it cover Disney+? | Listed as supported, alongside Netflix, Apple TV+, Prime Video, Hulu, Max and Paramount+. At the December 2024 launch Disney+ was named as *planned*; it appears in the current supported list. |
| Does it work? | **Disputed.** Trakt's own forums carry standing reports of Disney+ connecting successfully but syncing nothing. This is the single largest risk in adopting it. |
| Cost | Trakt VIP. Published third-party figures for 2026 are $30/year standard and $60/year for the higher tier, after a 2025 increase. The scrobbler is a VIP feature. |
| Backfill quality | Poor for Disney+ specifically. Trakt states the service does not supply watched *dates*, so an initial import stamps items with their original release date. Ongoing watches are better but still imprecise. |
| Can QueuePilot read the result? | Expected yes, and **unverified**. Trakt has a documented REST API with OAuth; once history is in the account it should be readable through the sync endpoints. Free Trakt accounts are limited to one connected application, which is a real constraint for someone already using a Trakt client. |

The shape that matters: **capture is mobile-app-side, read is server-side.** The phone app is what
talks to Disney+; QueuePilot would only ever read the Trakt account over HTTP. So it does satisfy
"works outside the browser" — but it does not run unattended on a server either, and the phone app
is a dependency of the whole chain.

**Younify Connect** is the layer underneath, sold directly to developers: normalised watch history,
watchlists, ratings and continue-watching across 14+ services including Disney+. It is the better
data source and the worse dependency — no server SDK, no published pricing, and access terms that
are not self-serve. Recorded here so nobody re-discovers it; not a candidate today.

## 4. Playback — launching a title on an Apple TV

The first target player is an Apple TV 4K. This is the strongest hand-off available, because tvOS
supports deep linking and `pyatv` exposes it.

**Launching.** `pyatv`'s `interface.Apps.launch_app` takes either a bundle identifier or a URL:

```
await apps.launch_app("com.netflix.Netflix")          # bare app
await apps.launch_app("https://www.disneyplus.com/…")  # a specific title
```

The `pyatv` documentation carries a working Disney+ example of the URL form and notes that Disney+
publishes an `apple-app-site-association` file defining which URL patterns deep-link. Home
Assistant's Apple TV integration surfaces both: `media_player.select_source` opens a bare app, and
`media_player.play_media` opens a deep link.

```yaml
action: media_player.play_media
data:
  media_content_type: url
  media_content_id: https://www.disneyplus.com/series/…
```

Three caveats:

- **The Companion protocol must be paired**, or `launch_app` is unavailable.
- **Deep links rot.** `pyatv` states outright that a number of deep-link URLs have stopped
  working over time, and that fewer apps support them well. Sometimes a link needs a country code
  stripped to work. Any deep link QueuePilot builds needs a failure path that lands the person in
  the bare app rather than nowhere.
- **A web URL is the source of a deep link**, not a documented scheme. The link comes from the
  service's own share sheet or its website.

**Observing.** The Home Assistant Apple TV integration exposes the active app and playback state
on the `media_player` entity. Community reports say Netflix, Disney+ and Apple TV+ generally do
expose media data, with artwork the flaky part, and that a pause/resume sometimes shakes the
metadata loose after an app switch. **Unverified here.** The whole "observed" history grade in
§3.2 rests on this, so it is the first thing to test against real hardware, before any of it is
built.

## 5. The bridge — QueuePilot does not learn Home Assistant

QueuePilot has no Home Assistant client and does not gain one. It speaks MQTT, and Home Assistant
has a native MQTT integration. That is the entire connection, and it is the existing pattern
([MQTT cutover](queuepilot-mqtt-cutover.md)).

- **Outbound.** QueuePilot publishes a command carrying the deep link and the target player. A
  Home Assistant automation subscribes and calls `media_player.play_media`.
- **Inbound.** A Home Assistant automation watches the Apple TV `media_player` entity and
  publishes what it sees. QueuePilot records that against the queue entry.

This keeps the household-specific half — which Apple TV, which room, which automation — in Home
Assistant, where it already lives, and out of a public repository. It also means the same design
serves any player Home Assistant can drive, not only an Apple TV.

## 6. What must be tested before anything is built

In order, cheapest first. Each one can kill the design above it.

1. **Does the Apple TV `media_player` entity report a usable `media_title` while Disney+ plays?**
   If not, history is blind and the honest product is a launcher with a manual mark-complete.
2. **Does a Disney+ deep link still launch the right title through `play_media`?** Test several,
   including a series episode, not just one.
3. **Does TMDB Discover return a Disney+ catalog that matches what the service actually shows?**
   Spot-check both directions: listed-but-gone, and present-but-unlisted.
4. **Does Trakt's Disney+ scrobbler sync at all on a real account?** Given the standing forum
   reports, assume it does not until proven, and treat the whole external-history source as
   optional.

## Sources

- [TMDB — Movie Watch Providers](https://developer.themoviedb.org/reference/movie-watch-providers)
  and [TV Series Watch Providers](https://developer.themoviedb.org/reference/tv-series-watch-providers)
- [TMDB — Discover pagination limits](https://www.themoviedb.org/talk/66f6d91fb9fd27627950d0b4)
- [Watchmode API](https://api.watchmode.com/)
- [Trakt — Automatically sync your streaming services](https://forums.trakt.tv/t/automatically-sync-your-streaming-services/34947)
- [Trakt partners with Younify to launch its Streaming Scrobbler](https://www.prnewswire.com/news-releases/trakt-partners-with-younify-to-launch-its-streaming-scrobbler-302324174.html)
- [Trakt — Disney+ streaming scrobbler issue](https://forums.trakt.tv/t/disney-streaming-scrobbler-issue-not-marking-as-watched/53711)
- [Younify Connect](https://www.younify.tv/)
- [Trakt API](https://github.com/trakt/trakt-api)
- [pyatv — Apps and deep links](https://pyatv.dev/development/apps/)
- [Home Assistant — Apple TV integration](https://www.home-assistant.io/integrations/apple_tv/)
