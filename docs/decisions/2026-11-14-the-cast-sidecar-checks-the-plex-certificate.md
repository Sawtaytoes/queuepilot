# The cast sidecar checks the Plex certificate

- **Status:** Accepted
- **Date:** 2026-11-14
- **Type:** Security
- **Supersedes:** —
- **Superseded by:** —

## Decision

`cast_sidecar/service.py` no longer turns certificate checks off. It builds `PlexServer` with
plexapi's own `requests` session, which verifies the certificate of the Plex API URL
(`PLEX_API_SERVER_URL`, else `PLEX_URL`). `server/src/outboundDeadlines.test.ts` fails if the
sidecar sets `verify=False` again, or reaches for `ssl.CERT_NONE` or an unverified context.

The Node side is unchanged: its scoped undici agents for `PLEX_URL` and the Companion pool
stay as the 2026-11-13 record describes.

## Context

The sidecar is the Python bridge for `PLAYBACK_MODE=cast`. It built a `requests.Session`,
set `verify = False` on it, and handed it to `PlexServer`. Nothing else used the session. The
line came over unchanged from the deleted Python selection engine, which reached Plex at a
LAN address with a self-signed certificate. The 2026-11-13 TLS change removed the Node
process's bypass and left this Python one in place.

## Why

The bypass sent the Plex token without a certificate check. The configured Plex API URL
already serves a publicly trusted certificate, so the check costs nothing. A Plex server
reached on the LAN has a trusted address too: Plex issues each server a `*.plex.direct`
certificate. A sidecar pointed at a raw self-signed address now fails with a certificate
error in `resp/cast`, instead of sending the token unchecked.

## Evidence

- From inside the running container, with certificate checks on, Python `requests` reached
  the configured Plex API URL's `/identity` with HTTP 200.
- In the same container, `PlexServer(url, token)` with plexapi 4.18.3's default session
  connected and reported `session.verify == True`.
- The new test fails against the old `service.py` and passes against the new one.
