# No process-wide TLS bypass, and every outbound call has a deadline

- **Status:** Accepted
- **Date:** 2026-11-13
- **Type:** Security / reliability
- **Supersedes:** The `NODE_TLS_REJECT_UNAUTHORIZED=0` line that the runtime image set since the
  first public release.
- **Superseded by:** —

## Decision

The image sets no process-wide TLS bypass. A LAN host that truly serves a self-signed
certificate gets its own undici `Agent` with `connect.rejectUnauthorized: false`, used for that
host only. Today there are two: the `PLEX_URL` pool in `server/src/plex.ts` (which now also
serves poster bytes) and the Companion and playQueue pool in `server/src/playback.ts`. A
poster redirect is followed at most three times; a hop that leaves `PLEX_URL`'s origin goes
through the global `fetch` with full certificate checks, never through the scoped agent. Every
other host keeps full certificate checks: plex.tv, Kavita, Steam, BoardGameGeek, the MiSTer
box-art archive, and the MQTT broker.

There is one plex.tv JSON helper, `server/src/plexTv.ts`, and it has a timeout. Every outbound
HTTP call in `server/src` has a deadline: plex.tv, `PLEX_URL` (including posters), shared Plex
servers, MiSTer, Kavita, Steam, the board-game picker, and BoardGameGeek. A new call adds one.

## Context

The runtime image set `NODE_TLS_REJECT_UNAUTHORIZED=0` with the comment "this container only
talks to the LAN Plex server." That stopped being true as soon as the app called plex.tv. From
then on, the admin Plex token went to plex.tv with no certificate check, and so did the Kavita
API key, the Steam key, and the BoardGameGeek token. The LAN Plex calls never depended on the
variable. `plex.ts` already used a scoped agent, because undici does not reliably honor the
variable.

Two copies of `plextv()` had drifted. The `playback.ts` copy gained a timeout after a stalled
plex.tv call hung a seek tick, and the `plex.ts` copy never got one.

## Why

A process-wide bypass protects nothing that a scoped agent does not, and it silently covers
every host that is added later. A missing timeout turns one stalled host into a stalled page or
a stalled playback tick.

## Evidence

Before the change, a TLS probe from inside the running container with certificate checks on
reached every configured host with a publicly trusted certificate: plex.tv, the Plex API
URL, Kavita, the board-game host, the MQTT broker on its TLS port, BoardGameGeek, Steam, and
the box-art archive. `server/src/outboundDeadlines.test.ts` fails if the Dockerfile sets the
variable again, if a poster read or a same-origin poster redirect leaves the scoped agent, if
a cross-origin poster redirect uses it, or if a plex.tv, Kavita, MiSTer, Steam, or board-game
picker call loses its deadline. The deploy of this change is checked against plex.tv, Plex,
Kavita, and MQTT from the new image.
