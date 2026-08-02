# The queue web UI is a monorepo in one container, not a separate app

- **Status:** Accepted — **shipped 2026-07-20**
- **Date:** 2026-07-20
- **Type:** amendment / architecture
- **Amends:** [2026-07-20-queue-web-ui-is-nodejs-not-flask.md](2026-07-20-queue-web-ui-is-nodejs-not-flask.md)
  (keeps the Node.js + mux-magic decision; changes only the packaging: one repo + one
  container instead of a separate app/container).
- **Superseded by:** —

## Decision

The Node.js queue editor (`plex-channels-web`) lives **in the existing `plex-channels`
repo** (a monorepo) and ships **in the same container** as the Python MQTT/playback
service (`plex-channels-queue`) — one image, one TrueNAS app, two processes. This is the
mux-magic / gallery-downloader shape: server + web UI are one app container, not two.

- **Image:** `node:24-trixie-slim` base (Node 24) with Python 3 added via apt + a venv for
  the queue service's deps. `entrypoint.sh` starts both processes and ties their lifetimes
  together (if either exits, the container exits so the orchestrator restarts it).
- **Layout:** `queue_builder/` (Python) + `web/` (Node: `src/` server + `public/` vanilla-JS
  front-end). The two logical components are `plex-channels-queue` (Python, package
  `queue_builder`) and `plex-channels-web`. (The Python package was renamed from
  `plexchannels` → `queue_builder` on 2026-07-20 at the user's request; bare `queue` was
  avoided because it shadows Python's stdlib `queue` module.)
- **Same TrueNAS app** (`plex-channels`, host-networked). The web server binds `WEB_PORT`
  (default 8768) directly on `192.0.2.10`; NPM fronts it at `plex-channels.example.com`.
- **Cross-process file lock stays required.** Even in one container the Node editor and the
  Python `queues.prune` are separate processes, so the Python `threading` lock can't cover
  both. Both take a **mkdir-based advisory lock** on `<queues.yaml>.lock` (identical
  convention in `queue_builder/queues.py::_file_lock` and `web/src/queues.js`).

## Context

The prior decision, read as "a *separate* Node app/container," was the earlier agent's
interpretation of "modeled on mux-magic." The user corrected it: mux-magic (and
gallery-downloader) are **one** container holding both the server and the web UI, and he
wants the same here — simpler to manage than two containers.

## Why

- **One thing to deploy, one app to manage** — the user's explicit preference and his
  existing pattern (mux-magic, gallery-downloader).
- **The Node 24 base already carries (or trivially adds) Python**, so a single image runs
  both halves without a second container.
- The only cost — a cross-process write lock — was already required by the amended decision
  and is solved with a dependency-free mkdir lock shared by both writers.

## Evidence

- User (chat 2026-07-20): *"Why not build it into the `plex-channels` repo? … We're making
  this into a monorepo right? … simply combine the two into one container. That way, the web
  app and Python code are simpler to manage … For Mux-Magic and Gallery-Downloader, the Web
  UI and server are both 1 app container, not 2. … The Node.js 24 container I believe has
  Python as well."*
