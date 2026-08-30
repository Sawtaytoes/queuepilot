# QueuePilot

> **Renamed from `plex-channels` (2026-08-12).** The cutover is complete. Use
> `ghcr.io/sawtaytoes/queuepilot` and the `queuepilot/…` MQTT topics. GitHub redirects the old
> repository path. The historical checklist is in
> [the rename decision](docs/decisions/2026-08-12-plex-channels-becomes-queuepilot.md).

**QueuePilot picks what plays next, so you don't have to.** Point it at a pile of things you
already want — shows, movies, manga, webtoons — and it hands you the next one, remembers where
you left off, and rolls into the next thing after that.

Its first home is an **NFC / Unfolded Circle 3** Plex experience. Home Assistant owns the
cards, buttons and theater activity; this service owns the selection logic that does not belong
in templates, and talks to HA **only over MQTT** (no REST or shell bridges). QueuePilot can
currently build queues from **Plex, Kavita, BoardGameGeek collections, Steam and MiSTer**.
Jellyfin, Emby and Kodi are planned but are not implemented.

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
  A rotation channel names its account in `profiles[]`; a **curated queue's account is its
  `requires_profile`**, which is therefore who it plays as and not merely a start gate
  ([decision](docs/decisions/2026-08-16-a-curated-queue-plays-as-the-profile-it-is-gated-to.md)).
  An ungated queue reads as the owner.
- **Kid-appropriateness** comes from each set's **own account view** (the Younger Kids
  token sees the G-tier library; the Older Kids token sees the TV-PG library), with a
  per-set `movie_ratings` cap applied on top (younger = G-tier; older = PG tier only, i.e.
  PG/TV-PG, disjoint from younger). The managed-user token works
  locally via the **server-scoped access token** (switch → `/resources` → this server's
  accessToken); playback attribution follows the Shield's signed-in profile (client mode),
  never the owner. A contentRating allow-list is still applied as the ceiling.
- **Rotation** round-robins each show's ordered unwatched episodes across shows, so a
  binge still advances that show across rounds and no two consecutive items share a show.
- **Skipping** is per-item, not per-entry. A curated queue carries a `skipped:` list of the
  leaves it never plays — one episode of a show, one film inside a collection — so "not this
  one" no longer means dismantling the entry. It is the curated twin of a filtered pool's
  `blocklist`, and it is permanent until cleared from the queue's **Skipped** panel. A skipped
  item counts as dealt with, so an entry whose every remaining item is watched or skipped is
  finished — and Restore revives it
  ([decision](docs/decisions/2026-08-22-a-curated-queue-skips-items-the-way-a-filtered-pool-blocks-them.md),
  [correction](docs/decisions/2026-08-23-a-skipped-item-counts-as-dealt-with-so-the-entry-can-complete.md)).
- **What plays inside an entry is a LIST you tick.** An entry that holds items — a collection,
  a show — opens a member list: the collection's members, or the show's episodes under season
  headings. Normal episodes start ticked; regular specials start unticked and can be included
  one at a time. A selected special uses Plex's original availability date when present and
  otherwise follows the normal run. Ticked plays, unticked is skipped, and Save writes the whole answer at once. It is
  how three duplicate cuts of one film in one collection are dealt with in a single pass, and
  the rows name the Plex **edition** and the runtime, because that is all that tells two copies
  of the same title apart. Reached from the tile menu, from the **What plays** field on the
  entry sheet, and signposted by an `N skipped` tag on the tile
  ([member-list decision](docs/decisions/2026-08-26-an-entry-lists-what-is-inside-it-and-you-tick-what-plays.md),
  [specials decision](docs/decisions/2026-08-28-specials-are-skipped-by-default-and-selected-one-at-a-time.md)).

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
| `server/src/queues.js` / `sets.js` | the queue + set MODEL: entry vocabulary, normalization, the mutations |
| `server/src/store/` | the store seam — where the durable state lives and how it is read and written. Four YAML files today (`sets`, `queues`, `groups`, `pending`); nothing outside it names a `.yaml` path |
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

## Set up QueuePilot

QueuePilot is one container with a web app, its API, the selection engine, MQTT support and an
optional Plex Cast sidecar. The container needs:

- a persistent, writable directory mounted at `/config`;
- access to the services that you connect;
- access to an MQTT broker; and
- port `8768` available, or another port selected with `WEB_PORT`.

The packaged image currently starts the Cast sidecar even when Plex Cast is not used. Set
`MQTT_HOST` to a reachable broker or the sidecar exits and the container restarts.

Start with this minimum environment file. Keep the real file outside this public repository.

```dotenv
WEB_PORT=8768

MQTT_HOST=mqtt.example.com
MQTT_PORT=1883
MQTT_USER=queuepilot
MQTT_PASS=replace-me

PLEX_API_SERVER_URL=https://plex.example.com
PLEX_LOCAL_URL=http://plex.lan:32400
PLEX_TOKEN=replace-me
PLEX_CLIENT_IDENTIFIER=plex-channels-helper

PLAYBACK_MODE=client
SHIELD_CLIENT_NAME=Living Room Player
```

Then run the published image. Host networking is useful for Plex clients, Cast discovery and
LAN-only providers. If those services are routed another way, expose `WEB_PORT` instead.

```sh
docker run -d \
  --name queuepilot \
  --restart unless-stopped \
  --network host \
  --env-file /path/to/queuepilot.env \
  --volume /path/to/queuepilot-config:/config \
  ghcr.io/sawtaytoes/queuepilot:latest
```

Open `http://<queuepilot-host>:8768`. Create a Picks queue, choose its activity and source,
select the source libraries, then add items from the queue page. A configured source appears in
the source picker automatically. An empty library selection means all libraries.

QueuePilot stores durable data in `/config/queuepilot.sqlite`. Back up the complete `/config`
directory. `/config/cache.sqlite` and the board-game cache can be rebuilt, but the main database
cannot.

### Configure Plex

The Plex definition is built in and becomes available when its token is configured. It needs
the owner or administrator token because QueuePilot uses that token to discover Plex Home
accounts and obtain the server-scoped tokens that keep watch history separate for each account.

1. Set `PLEX_API_SERVER_URL` to the Plex URL that QueuePilot and its users can reach. Do not add
   `/web` to it.
2. Get an `X-Plex-Token` by following Plex's
   [token instructions](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/),
   and set it as `PLEX_TOKEN`.
3. Set `PLEX_LOCAL_URL` to the server address that the playback device can reach. This is
   normally `http://<plex-lan-address>:32400`.
4. Keep `PLEX_CLIENT_IDENTIFIER` stable after the first connection. Changing it creates a new
   Plex client identity and can invalidate account-token assumptions.
5. Restart QueuePilot. Open a new queue and confirm that Plex libraries appear under Source.

Choose one playback mode:

| Mode | Configuration | Behavior |
| --- | --- | --- |
| `client` | `PLAYBACK_MODE=client` plus `SHIELD_CLIENT_NAME`; optionally set `SHIELD_CLIENT_MACHINE_ID` or the direct `SHIELD_CLIENT_URI=http://<player>:32500` | Remote-controls the signed-in Plex player. Watch history belongs to the account active on that player. |
| `cast` | `PLAYBACK_MODE=cast` plus `SHIELD_CAST_NAME` | Uses Plex Cast and the queue account token. This keeps watch attribution deterministic for Plex Home accounts. MQTT and network discovery are required. |

Profile-aware NFC cards can also use `set: "auto"`. Mount the Plex Media Server log directory
read-only so `PMS_LOG_PATH` points at `Plex Media Server.log`. Set `SHIELD_IP` to the player.
Automatic profile switching is optional and off by default. To use it, set `ADB_ENABLED=true`,
enable network ADB on the player, approve the connection once on the player, and persist the
approved private key at `/config/.android/adbkey`.

### Configure Kavita

QueuePilot reads Kavita series and chapter progress. Starting a reading queue opens Kavita at
the selected series because Kavita has no cast or playback webhook.

1. In Kavita, open **User Settings → 3rd Party Clients** and create or copy an Auth Key. The
   [Kavita API guide](https://wiki.kavitareader.com/guides/api/) describes these keys and their
   expiration setting.
2. Add these values to the QueuePilot environment:

   ```dotenv
   KAVITA_API_SERVER_URL=https://kavita.example.com
   KAVITA_API_KEY=replace-me
   KAVITA_BATCH_DEFAULT=1
   ```

3. Restart QueuePilot. Create or edit a Picks queue, select **Kavita** as the source, and select
   the libraries that the queue can use.

`KAVITA_BATCH_DEFAULT` is the number of chapters contributed by one series in each rotation.
The queue editor can override it per queue. Kavita's Auth Key identifies one Kavita user, so
read progress and available libraries follow that user.

If Kavita also stores board-game rulebooks, set `KAVITA_RULEBOOK_LIBRARY_ID` to that library's
numeric ID. The board-game sync then matches games to rulebook series and stores normal Kavita
links without putting the key in a URL.

### Configure BoardGameGeek and board games

BoardGameGeek collection sync is built into QueuePilot. It is not the same setting as the
legacy Board Game Picker HTTP connector.

1. Register QueuePilot as a non-commercial application at
   [BoardGameGeek Applications](https://boardgamegeek.com/applications). BGG can take time to
   approve an application.
2. After approval, create an application token and set the token and the collection owner:

   ```dotenv
   BOARD_GAME_GEEK_API_TOKEN=replace-me
   BGG_USERNAME=your-bgg-username
   ```

   BGG documents application registration, bearer tokens and usage limits in its
   [XML API guide](https://boardgamegeek.com/using_the_xml_api).
3. Enable the board-game source with the sibling Board Game Picker URL. The URL remains the
   rollback transport address; normal reads use QueuePilot's own database.

   ```dotenv
   BOARD_GAME_PICKER_URL=http://board-game-picker.lan:3000
   BOARD_GAME_TRANSPORT=repository
   ```

4. Restart QueuePilot and request a sync by publishing any payload to
   `board-game-picker/cmd/sync`. The result arrives on `board-game-picker/resp/sync`.

   ```sh
   mosquitto_pub -h mqtt.example.com -u queuepilot -P 'replace-me' \
     -t board-game-picker/cmd/sync -m '{}'
   ```

5. Create a Picks queue and select **Board Game Picker** as its source. Leave its library list
   empty to use the complete collection.

The sync performs four independent steps: collection reconciliation, metadata and cover
enrichment, optional Kavita rulebook linking, and teaching-video linking. It refuses an empty
BGG response instead of marking the complete collection as removed. QueuePilot does not include
a scheduler. Schedule the MQTT command in your automation system if you want periodic refreshes.

For a source checkout, you can run the same job without MQTT:

```sh
server/node_modules/.bin/tsx server/src/tools/board-game-sync.ts all
```

`BOARD_GAME_TRANSPORT=http` sends board-game reads and play writes back to the sibling Board
Game Picker service. Keep `repository` for the normal in-process data path.

### Configure Steam

Steam needs a Web API key and the account's 64-bit Steam ID.

1. Create a key on Valve's [Steam Web API page](https://steamcommunity.com/dev/apikey).
2. Set the Steam account's **Game Details** privacy to public. Valve otherwise returns HTTP
   200 with no games array.
3. Add the values and restart QueuePilot:

   ```dotenv
   STEAM_WEB_API_KEY=replace-me
   STEAM_ID=76561190000000000
   ```

4. Create a Picks queue and select **Steam** as its source.

Use the numeric Steam ID, not a vanity name. QueuePilot reads owned games and play timestamps.
Starting an entry returns a `steam://rungameid/<appid>` URL for the system that launches games.

### Configure MiSTer

QueuePilot connects to the `remote` service from
[mrext](https://github.com/wizzomafizzo/mrext). The service indexes the MiSTer's systems and
games and does not issue an API token.

1. Install and start the mrext **Remote** extension on the MiSTer.
2. Set the service address. QueuePilot accepts the address with or without the trailing `/api`.

   ```dotenv
   MISTER_API_SERVER_URL=http://mister.lan:8182
   ```

3. Restart QueuePilot. Create a Picks queue, select **MiSTer**, and choose the systems that the
   queue can use.

QueuePilot chooses a game but does not call mrext's launch route. Hand the returned game path to
Home Assistant or another local launcher that also performs the required device setup.

### Define a custom source

The standard environment variables create the built-in source IDs (`plex`, `kavita`,
`board-game-picker`, `steam` and `mister`). To give a source another ID and label, or to add an
additional Kavita or MiSTer server, define it in `/config/providers.yaml`:

```yaml
providers:
  - id: comics-kavita
    kind: kavita
    label: Comics Kavita
    base_url: https://comics-kavita.example.com
```

Put its credential in `/config/providers.secrets.yaml`, and restrict the file to its owner:

```yaml
comics-kavita: replace-me
```

```sh
chmod 600 /path/to/queuepilot-config/providers.secrets.yaml
```

An environment variable takes precedence over the secrets file. A custom source ID such as
`comics-kavita` uses `PROVIDER_TOKEN_COMICS_KAVITA`. Tokens never belong in
`providers.yaml`, screenshots, logs or this repository. Plex still uses the global
`PLEX_API_SERVER_URL`, and Steam still uses the global `STEAM_ID`, so a second definition does
not create a second Plex server or Steam account.

### MQTT and Home Assistant

QueuePilot listens on `queuepilot/cmd/session/start` and publishes session state and responses
under `queuepilot/`. A typical start payload is:

```json
{"set":"movie-night","via":"ha"}
```

The set ID is permanent. It can be stored on an NFC card, in a Home Assistant automation or in
another remote control. Rename the queue label when needed, but do not change an ID already used
by an external control.

The board-game refresh deliberately keeps its historical `board-game-picker/cmd/sync` topic.
Do not change `BOARD_GAME_MQTT_BASE` unless you also change every publisher and response
consumer.

### Run from source

The source build needs Node.js 24 or later. The repository uses the committed Yarn release. Do
not use `npm` or `npx`.

```sh
yarn install --immutable
yarn build
yarn workspace queuepilot-server start
```

For frontend development, keep the server running and start Vite in another terminal:

```sh
yarn workspace queuepilot-web dev
```

See [`.env.example`](.env.example) for optional playback, cache and tuning values. Keep all
credentials in the deployment environment or `/config/providers.secrets.yaml`, never in the
repository.
