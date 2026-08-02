# The queue config web app is embedded in plex-channels, and edits the same YAML

- **Status:** Accepted
- **Date:** 2026-07-16
- **Type:** architecture
- **Supersedes:** —
- **Superseded by:** —
- **Extends:** [2026-07-16-movie-queue-sets-yaml-wishlist.md](2026-07-16-movie-queue-sets-yaml-wishlist.md)

## Decision

The queues get a web UI, served **from inside the existing `plex-channels` container**.

1. **Embedded, not a second app.** An HTTP server runs in a thread alongside the MQTT loop in the
   same process. No new repo, image, TrueNAS app, or icon. Exposed at
   `https://plex-channels.example.com` via an NPM proxy host to `192.0.2.10:<port>`, behind Authelia
   like the other apps.
2. **`queues.yaml` stays the source of truth.** The web app is an editor over the same file, using
   the same `ruamel.yaml` round-trip and atomic replace. Hand-editing over
   `\\nas.example.com\App-Configs\plex-channels\queues.yaml` keeps working as the fallback.
3. **Add by Plex search, not free text.** The UI searches the set's own section (1 for movies, 11
   for anime) and stores `title` + `year` + `ratingKey` + `type` from the chosen result.
4. **One `threading.Lock` guards the file**, shared by the UI writes and the scan-time prune.
5. **Reordering is a first-class action** - the list is a priority, so the UI must express it.

## Context

The queues were designed to be hand-edited YAML because that was the cheapest thing that satisfied
"I can easily add to this queue." The user then asked for a web app. A browser UI also happens to
be the natural home for Plex search, which removes the worst parts of the YAML path.

## Why

- **Embedding is nearly free and fixes the race.** The container already holds the Plex token, the
  `SETS` config, and a long-lived process. A separate app would duplicate all of that, and - more
  importantly - would put the UI's writes and the prune's writes in **different processes**, where
  an in-process lock cannot help and the file race I flagged becomes real. One process reduces
  three writers to two, and the remaining one (SMB hand-edits) is handled by re-read-then-replace.
- **Keeping YAML as the store** preserves the SMB fallback and today's ADR, and keeps the file
  reviewable and greppable. A database would buy cleaner concurrency the embedding already
  provides, at the cost of the fallback.
- **Search kills three gotchas at once**: exact-title typing, quoting titles with a colon, and
  entries that never resolve because the title is wrong or the film is not ripped yet. It also
  resolves `type` (series vs film) up front, which the mixed-entry rule needs anyway.
- **No catalog app exists** for "editor for our own bespoke MQTT service," so the house
  prefer-the-catalog rule is not in play. This is also not a new home-rolled container - it is a
  route on one we already run.

## Why not (rejected alternatives)

- **Separate `plex-channels-viewer` app** (matching the `automatic-ripping-machine-viewer` /
  `plex-nfo-exporter` naming) - offered and declined. It buys independent restarts, and costs
  duplicated Plex/config wiring plus a genuine cross-process write race on `queues.yaml`.
- **Web app owns a SQLite/JSON store, YAML retired** - offered and declined; would supersede the
  movie-queue ADR and drop SMB hand-editing.
- **Free-text add** - keeps the UI trivial but preserves every title-resolution failure mode.

## Risks

- **Host networking.** The app runs host-networked for Cast mDNS, so the web port binds directly on
  `192.0.2.10` and must not collide. Verify with `ss -ltnp` before picking one.
- **Auth is not optional.** Host networking + a bare port means the UI is reachable on the LAN the
  moment it binds. It must sit behind Authelia before it holds anything.
- **A crash in the web thread must not take down playback.** The MQTT loop is the primary job; the
  HTTP server is secondary and should fail closed on its own.
- **Flask is a new dependency** in an image that currently ships only paho / PlexAPI / PyChromecast.

## Evidence

- User: "Did you get the message about making this configurable via a web app and exposing 2 more
  lists for anime for me, my wife, and my kids? Just like movies." (chat 2026-07-16)
- User chose, when asked: "Inside plex-channels" over a separate custom app, and "Web app edits the
  same YAML" over a database. (chat 2026-07-16)
- Live check: `midclt call app.config plex-channels` returns `storage: []`, so the `/config` mount
  and the web port are both new deploy changes.
