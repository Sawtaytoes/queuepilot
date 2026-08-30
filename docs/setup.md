# Set up QueuePilot

[Back to the project README](../README.md)

QueuePilot is one container with a web app, its API, the selection engine, MQTT support and an
optional Plex Cast sidecar. The container needs:

- a persistent, writable directory mounted at `/config`;
- access to the services that you connect;
- access to an MQTT broker; and
- port `8768` available, or another port selected with `WEB_PORT`.

The packaged image currently starts the Cast sidecar even when Plex Cast is not used. Set
`MQTT_HOST` to a reachable broker or the sidecar exits and the container restarts.

## Start the container

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

## Configure Plex

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

## Configure Kavita

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

## Configure BoardGameGeek and board games

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

## Configure Steam

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

## Configure MiSTer

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

## Define a custom source

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

## MQTT and Home Assistant

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

## Run from source

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

See [`.env.example`](../.env.example) for optional playback, cache and tuning values. Keep all
credentials in the deployment environment or `/config/providers.secrets.yaml`, never in the
repository.
