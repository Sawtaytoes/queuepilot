# Plex tile links use the server URL, not app.plex.tv

- **Status:** Accepted
- **Date:** 2026-08-25
- **Type:** correction / config
- **Supersedes:** the `app.plex.tv` host choice in `2026-08-22-a-tile-links-to-its-item-in-plex-or-kavita` (title-as-link, show-not-episode, and server-built URL still stand)
- **Superseded by:** —

## Decision

A Plex tile's `webUrl` is built from **`PLEX_API_SERVER_URL`** (the same host the API already
talks to), as:

```
{PLEX_API_SERVER_URL}/web/index.html#!/server/{machineIdentifier}/details?key=…
```

It is **not** `https://app.plex.tv/desktop/#!…`.

The hash path is still Plex's shape, not ours. The "owned apps route with paths, never `#/`"
rule still does not bind an external client's address we are quoting.

## Context

The 2026-08-22 record chose `app.plex.tv` so a phone off the LAN could still open the item.
The owner, looking at live tiles:

> *"For some reason, the Plex links on QueuePilot go to app.plex.tv instead of
> plex.octen.dev. can you fix that config?"*

Asked whether to always use the server URL or keep a configurable hatch, he picked **always
the server URL via `PLEX_API_SERVER_URL`**.

## Why

The household already reverse-proxies the Plex web client at that host, and that is the
client the owner expects the tile to open. The off-LAN reachability argument for
`app.plex.tv` is real, and it is no longer the preference: a phone that cannot reach the
server URL also cannot stream from it, and signing into app.plex.tv is a different client
than the one he runs.

Building from `PLEX_URL` (not a hard-coded host) keeps the public repo's placeholder default
(`https://plex.example.com`) and the live deploy's `plex_api_server_url` / env override as
the one source of truth.

## Evidence

- Owner, 2026-08-25: the request above.
- Owner, same session, choosing the shape: always `PLEX_API_SERVER_URL` (not a new env, not a
  hard-coded household host).
