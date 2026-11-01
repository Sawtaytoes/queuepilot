# QueuePilot

**[Set up QueuePilot with Docker →](docs/setup.md)**

QueuePilot picks what plays next from things you already chose. It builds ordered or random
queues, tracks progress, and continues with the next eligible item without becoming a content
recommender.

It currently supports Plex, Kavita, BoardGameGeek collections, Steam and MiSTer. QueuePilot
includes a web interface for queue management and can connect to Home Assistant through MQTT
for NFC cards, remote controls and playback automations.

The Plex source editor also shows video libraries on other servers shared with the selected
Plex account. This view is read-only. Queue entries and playback still use the configured
Plex server; a managed Plex Home profile does not inherit another account's external shares.

## Run the container

Follow the [setup guide](docs/setup.md) first. It explains the required MQTT broker, persistent
`/config` volume, provider credentials and playback settings.

```sh
docker run -d \
  --name queuepilot \
  --restart unless-stopped \
  --network host \
  --env-file /path/to/queuepilot.env \
  --volume /path/to/queuepilot-config:/config \
  ghcr.io/sawtaytoes/queuepilot:latest
```

Open `http://<queuepilot-host>:8768` after the container starts. Set `WEB_PORT` to use another
port.

## Run from source

The source build needs Node.js 24 or later and uses pnpm 12.9.1.

```sh
npm install --global --force --allow-scripts=pnpm pnpm@12.9.1
pnpm install --frozen-lockfile
pnpm build
pnpm --filter queuepilot-server start
```

For frontend development, keep the server running and start Vite in another terminal:

```sh
pnpm --filter queuepilot-web dev
```

## Documentation

- [Installation and provider setup](docs/setup.md)
- [How Plex playback reaches a Shield or Android TV](docs/plex-on-android-tv.md)
- [Person photos: uploading, storage and the API](docs/person-photos.md)
- [Why QueuePilot uses queues instead of Plex playlists](docs/why-queues-not-plex-playlists.md)
- [Decision records](docs/decisions/README.md)

### Additional Android TV playback targets

The default player keeps its existing `shield_*` settings and `shield` wire ID. Add
explicit players to the deployment's `config.yaml` when Plex does not advertise them:

```yaml
playback_targets:
  - id: den-tv
    name: Den TV
    machine_identifier: den-player-client-id
    uri: http://192.0.2.31:32500
    adb_target: 192.0.2.31:5555
```

Restart QueuePilot after changing host configuration. The player appears in the existing
Play on picker even without Companion discovery. `uri` identifies the Plex client; new
Android TV Plex versions use the explicitly authorized `adb_target` for playback and
transport instead of expecting a Companion HTTP listener. The URI and ADB endpoint must
name the same host. Enable network debugging on the player and authorize the server's
persisted ADB key once. A discovered client without an explicit ADB endpoint never inherits
another player's ADB connection. Unknown requested target IDs are rejected. A configured machine identifier is authoritative;
a matching display name cannot override a different identifier. Update a pinned identifier
if reinstalling Plex changes it.

Play, profile switching, pause, resume, next, stop, seek, resume-on-advance, and session
advance all retain the selected player. Profile observations are kept per player.
The existing engine manages one sitting at a time; selecting another device replaces that
managed sitting. It does not stop unrelated playback already running on either device.
For an explicit secondary target, QueuePilot reads Plex session telemetry while that sitting
is active; it does not use the default player's now-playing feed for its controls or history.

Session state and automatic finish events include `deviceId`. Manual activity-off commands
retain their existing `target` ID. Integrations that turn rooms off must route those IDs
explicitly; `target` on a finish event is still a numeric playback length, not a device ID.
Actual playback and profile attribution must be verified on each newly configured device;
an authorized ADB connection alone is not playback verification.
