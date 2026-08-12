# One image, two processes (decision 2026-07-20-queue-web-ui-monorepo-single-container.md):
#   * plex-channels-web  — the Node.js app: API, web UI, selection engine, MQTT service and
#                          playback (server/src/server.js). This is the whole application.
#   * cast_sidecar       — a ~100-line Python process for PLAYBACK_MODE=cast (pychromecast),
#                          the one thing Node cannot do (decision 2026-08-12).
# The mux-magic / gallery-downloader pattern: server + web UI ship in ONE app container.
# Base is the Node 26 image (Debian trixie); Python 3 is added ONLY for the cast sidecar.

# --- stage 1: build the React frontend --------------------------------------- #
# `web/` is a Vite project since M6d, so the runtime image needs its `dist/`, not
# its sources — and none of its ~48 dev dependencies. Keeping the build in its own
# stage means React, Vite, Tailwind and TypeScript never reach the final image.
FROM node:26-trixie-slim AS web-build
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
# `npm run build` = vite build + scripts/precompress.mjs (the `.br`/`.gz` siblings the
# server's staticCompressed middleware serves). vite.config.ts uses `sourcemap: "hidden"`,
# so the maps are emitted but never referenced by the bundle — delete them here so the
# runtime image doesn't carry 1.2 MB of unreachable files.
RUN npm run build && find dist -name '*.map' -delete

# --- stage 2: the runtime image ----------------------------------------------- #
FROM node:26-trixie-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    WEB_PORT=8768 \
    # Plex serves a self-signed cert; this is the Node equivalent of the Python client's
    # ssl.CERT_NONE. Scoped to this container, which only talks to the LAN Plex server.
    NODE_TLS_REJECT_UNAUTHORIZED=0

# Python 3 runtime for the cast sidecar (venv keeps pip off the system interpreter).
# `adb` drives the Shield's Plex profile picker (server/src/adb.js) so a profile-gated
# card can switch the profile itself instead of waiting for someone to walk to the TV.
# It stays inert unless ADB_ENABLED is set. The client key is NOT baked in — the Shield
# only trusts keys accepted once via an on-TV prompt, so mount the authorized private key
# at ADB_KEY_PATH (default /config/.android/adbkey). adb.py sets HOME per-invocation to
# point adb at it: this adb ignores ANDROID_USER_HOME and derives its key dir from $HOME,
# which is unset for the 568:568 run user. Not set globally here, because $HOME also
# affects the node and python halves.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv ca-certificates adb \
    && rm -rf /var/lib/apt/lists/*

# --- cast-sidecar Python deps (own layer, keyed on requirements.txt) ---
COPY requirements.txt ./
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

# --- Node deps for plex-channels-web (own layer, keyed on the manifest) ---
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm install --omit=dev --no-audit --no-fund

# --- source ---
COPY cast_sidecar ./cast_sidecar
COPY server ./server
COPY --from=web-build /web/dist ./web/dist
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x entrypoint.sh

ENV PATH="/opt/venv/bin:${PATH}"
CMD ["./entrypoint.sh"]
