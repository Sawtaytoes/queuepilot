# QueuePilot

> **Renamed from `plex-channels` (2026-08-12).** If you arrived from the old GitHub path or an
> old image tag: the repo moves to `queuepilot` (GitHub redirects the old path), the container
> image becomes `ghcr.io/sawtaytoes/queuepilot`, and the self-hosted web UI moves to a
> `queuepilot` subdomain. **The rename is decided and specified, not yet executed** — the old
> repo, image tag, MQTT topic prefix (`plex-channels/…`) and app name are all still live until
> the checklist in
> [the rename decision](docs/decisions/2026-08-12-plex-channels-becomes-queuepilot.md) is worked
> through. That document is the authoritative list of what has to move together.

**QueuePilot picks what plays next, so you don't have to.** Point it at a pile of things you
already want — shows, movies, manga, webtoons — and it hands you the next one, remembers where
you left off, and rolls into the next thing after that.

Its first home is the kids' **NFC / Unfolded Circle 3** Plex experiences on the Family Room
theater. Home Assistant owns the cards/buttons and the theater activity; this service owns the
Plex *brains* it can't do in templates — and talks to HA **only over MQTT** (no REST/shell
bridges). **Kavita** is the next backend
([feasibility](docs/kavita-feasibility.md)), with Jellyfin, Emby and Kodi wanted after it.

## Why *QueuePilot*?

**The name.** **`queue`** is the direct keyword — and literally the data model; a queue is the
object the whole app manipulates. **`pilot`** does double duty: *autopilot*, for the hands-off
result, and a *pilot*, which is a first episode.

**What it actually does, stated precisely.** You pre-choose in bulk; the app **orders what you
already approved** and remembers where you left off. It is **not a recommender** — nothing is
choosing *for* you, and nothing arrives that you didn't put there. What it removes is the
*nightly* decision, not the choosing. (This is why the omakase / chef's-choice family of names
was rejected: omakase means someone else decides, which is the opposite of what happens here.)

**Why it isn't `plex-channels` any more.** It drives Kavita as well as Plex, with Jellyfin, Emby
and Kodi intended — so a Plex-only name was actively misleading about what the app is.

**`tuner` and `channel` were avoided deliberately**, and should not be reintroduced: inside
Plex, Jellyfin and Emby both already mean something specific and different — *tuner* is
HDHomeRun OTA capture hardware, and *channel* is Live TV. Names anchored on `list` are out for
the same reason (Plex "Playlist", Kavita "Reading List").

The full reasoning, the other rejected candidates, and the rename checklist are in
[the decision record](docs/decisions/2026-08-12-plex-channels-becomes-queuepilot.md).

Two kid experiences, both **profile-driven** since 2026-07-16 (the card carries only the
KIND; the Shield's signed-in Plex Home profile - Younger Kids / Older Kids - decides the
tier, detected from the PMS debug log):

1. **Rewatch Movie** — a kid-rated movie that profile has watched before, weighted
   `1/n²` toward the least-watched (seen-exactly-once movies dominate; a first watch is
   impossible, so the kids never see a movie for the first time without the user).
2. **"Saturday Morning Cartoons"** — the *next unwatched* episode across a rotating
   pool of kid shows (+ a bucket of classic shorts), **switching show after each
   episode** like old-TV, auto-advancing.

## How it decides

- **Watched state is PER-PROFILE** and comes from Plex play *history*
  (`/status/sessions/history/all?accountID=`) for the set's own account only — the
  cross-account union was tried and reverted (someone else's viewing drove the kids'
  cards), and `viewCount` on the library reflects only the admin account and is useless.
- **Kid-appropriateness** comes from each set's **own account view** (the Younger Kids
  token sees the G-tier library; the Older Kids token sees the TV-PG library), with a
  per-set `movie_ratings` cap applied on top (younger = G-tier; older = PG tier only, i.e.
  PG/TV-PG, disjoint from younger). The managed-user token works
  locally via the **server-scoped access token** (switch → `/resources` → this server's
  accessToken); playback attribution follows the Shield's signed-in profile (client mode),
  never the owner. A contentRating allow-list is still applied as the ceiling.
- **Rotation** round-robins each show's ordered unwatched episodes across shows, so a
  binge still advances that show across rounds and no two consecutive items share a show.

## Layout

| File | Role |
| --- | --- |
| `server/src/server.js` | the HTTP API + static web server (the process that runs) |
| `server/src/mqttd.js` | MQTT service: session start/advance/preview/devices/discovery/state |
| `server/src/session.js` | a scan end to end: select → persist the queue write-side → play |
| `server/src/engine/` | selection: `routing.js` (set:"auto"), `select.js` (pools), `rotation.js`, `resolve.js` (curated queues + reels), `preview.js` |
| `server/src/plex.js` / `cache.js` | read-only Plex queries + the derived SQLite cache |
| `server/src/playback.js` | drive the Shield's Plex app via its Companion endpoint (`client` mode, resolved from plex.tv) |
| `server/src/driver.js` | the playback state machine (`PLAYBACK_FSM`): verified, retried transitions to playing |
| `server/src/adb.js` | the Shield's Plex profile picker over ADB (profile-gated cards) |
| `server/src/profiles.js` | detect the Shield's signed-in profile from the PMS debug log (`set=auto`) |
| `server/src/queues.js` / `sets.js` | the YAML stores: curated queues + channel definitions (comment-preserving writers) |
| `cast_sidecar/` | the ONLY Python left: a pychromecast bridge for `PLAYBACK_MODE=cast` |
| `web/` | React + TypeScript + Vite web editor for the curated movie/anime queues (Tailwind on `@charcuterie/ui`) |
| `docs/why-queues-not-plex-playlists.md` | 💬 RATIONALE: why "queues" are a watched-state-aware recipe, not native Plex Playlists |
| `docs/kavita-feasibility.md` | 📖 the verified Kavita integration record: endpoints, the reader deep link, the no-cast gap |
| `docs/queuepilot-ui-design.md` | 🎨 design proposal: the queue deck, the mode picker, and app connectors |
| `docs/decisions/` | every settled decision, newest first ([index](docs/decisions/README.md)) |

The service was Python until 2026-08-12; `queue_builder/` and its dry-run CLI are gone, and
with them the soundtrack resolver (MA → YouTube-Music → Ollama), which was never wired to a
live automation. See
[the decision](docs/decisions/2026-08-12-python-is-gone-except-the-cast-sidecar.md).

## Running it

```sh
npm ci --prefix server && node server/src/server.js     # API + UI + MQTT service
npm --prefix web run dev                                 # the web editor, against that API
node e2e/engine-parity.mjs                               # the offline engine gates (see e2e/)
```

Deploy this as a container (see `Dockerfile` / `build.sh`) with the env from
`.env.example`, and wire MQTT to your broker. Keep secrets in the app env, never in the
tree.
