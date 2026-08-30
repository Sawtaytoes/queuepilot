# QueuePilot

**[Set up QueuePilot with Docker →](docs/setup.md)**

QueuePilot picks what plays next from things you already chose. It builds ordered or random
queues, tracks progress, and continues with the next eligible item without becoming a content
recommender.

It currently supports Plex, Kavita, BoardGameGeek collections, Steam and MiSTer. QueuePilot
includes a web interface for queue management and can connect to Home Assistant through MQTT
for NFC cards, remote controls and playback automations.

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

The source build needs Node.js 24 or later and uses the committed Yarn release.

```sh
yarn install --immutable
yarn build
yarn workspace queuepilot-server start
```

For frontend development, keep the server running and start Vite in another terminal:

```sh
yarn workspace queuepilot-web dev
```

## Documentation

- [Installation and provider setup](docs/setup.md)
- [Why QueuePilot uses queues instead of Plex playlists](docs/why-queues-not-plex-playlists.md)
- [Decision records](docs/decisions/README.md)
