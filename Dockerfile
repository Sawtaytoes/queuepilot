# One image, two processes (decision 2026-07-20-queue-web-ui-monorepo-single-container.md):
#   * queuepilot-web     — the Node.js app: API, web UI, selection engine, MQTT service and
#                          playback (the esbuild bundle at server/dist/index.js). This is the
#                          whole application.
#   * cast_sidecar       — a ~100-line Python process for PLAYBACK_MODE=cast (pychromecast),
#                          the one thing Node cannot do (decision 2026-08-12).
# The mux-magic / gallery-downloader pattern: server + web UI ship in ONE app container.
# Base is the Node 26 image (Debian trixie); Python 3 is added ONLY for the cast sidecar.

# --- stage 1: build the React frontend --------------------------------------- #
# `web/` is a Vite project since M6d, so the runtime image needs its `dist/`, not
# its sources — and none of its ~48 dev dependencies. Keeping the build in its own
# stage means React, Vite, Tailwind and TypeScript never reach the final image.
FROM node:26-trixie-slim AS web-build
WORKDIR /repo
# The workspace root's manifest + lockfile + the pinned yarn release, then the workspace
# manifests: everything the install resolves from and nothing that invalidates it on a
# source-only edit. `--immutable` makes a lockfile that does not match the manifests a BUILD
# failure rather than a silent re-resolve.
#
# e2e/package.json is copied but its workspace is not built here: yarn needs every manifest
# named in `workspaces` to resolve the lockfile at all.
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/releases ./.yarn/releases
COPY web/package.json ./web/
COPY server/package.json ./server/
COPY e2e/package.json ./e2e/
# The COMMITTED yarn release, run through node — not corepack. node:26 ships neither
# corepack (dropped from the distribution in Node 25) nor yarn, so `corepack enable` fails
# with "not found"; and even where it exists it would fetch yarn over the network at build
# time. `.yarnrc.yml` pins the same file as `yarnPath`, so this is the exact yarn the
# lockfile was written by.
RUN node .yarn/releases/yarn-*.cjs workspaces focus queuepilot-web
COPY web/ ./web/
WORKDIR /repo/web
# `yarn run build` is plain `vite build`; the `.br`/`.gz` siblings the server's static
# handler serves are emitted by `precompressAssets()` from `@charcuterie/server/vite`,
# inside the build (this replaced the hand-rolled web/scripts/precompress.mjs).
#
# vite.config.ts uses `sourcemap: "hidden"`, so the maps are emitted but never
# referenced by the bundle — delete them here so the runtime image doesn't carry
# ~2 MB of unreachable files. The glob is `*.map*`, not `*.map`: the precompress
# plugin walks the whole `dist/` and also writes `<chunk>.js.map.br`/`.gz`, which
# `-name '*.map'` would leave behind as orphans.
RUN node ../.yarn/releases/yarn-*.cjs run build && find dist -name '*.map*' -delete

# --- stage 2: bundle the Node server ------------------------------------------ #
# esbuild collapses server/src/**.ts into ONE ESM file plus its source map, so the
# runtime image carries no `.ts`, no tsx, no typescript and no esbuild. Running the
# server through tsx in production would keep the whole TypeScript compiler resident
# for the life of the container; `node --enable-source-maps dist/index.js` gets the
# same readable stack traces from the `.map` alone.
FROM node:26-trixie-slim AS server-build
WORKDIR /repo
# Manifests first so the (dev-inclusive) install layer is keyed on them and survives
# source-only edits.
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/releases ./.yarn/releases
COPY web/package.json ./web/
COPY server/package.json ./server/
COPY e2e/package.json ./e2e/
# `workspaces focus` installs ONE workspace's dependency tree instead of all three — the
# server-build stage has no use for React, Vite or Playwright.
RUN node .yarn/releases/yarn-*.cjs workspaces focus queuepilot-server
COPY server/ ./server/
WORKDIR /repo/server
RUN node ../.yarn/releases/yarn-*.cjs run build

# --- stage 3: the runtime image ----------------------------------------------- #
FROM node:26-trixie-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    WEB_PORT=8768 \
    # Plex serves a self-signed cert; this is the Node equivalent of the Python client's
    # ssl.CERT_NONE. Scoped to this container, which only talks to the LAN Plex server.
    NODE_TLS_REJECT_UNAUTHORIZED=0

# Python 3 runtime for the cast sidecar (venv keeps pip off the system interpreter).
# `adb` drives the Shield's Plex profile picker (server/src/adb.ts) so a profile-gated
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

# --- Node deps for queuepilot-web (own layer, keyed on the manifest) ---
# Production deps only: no tsx/typescript/esbuild, which live in devDependencies and
# were needed only by the server-build stage. The bundle currently externalizes
# NOTHING (see server/scripts/build-server.mjs), so this layer is a safety net rather
# than a hard requirement — but it is what makes an added `external:` entry work
# without a second Dockerfile change, and it keeps `yarn info` answerable inside the
# container.
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/releases ./.yarn/releases
COPY web/package.json ./web/
COPY server/package.json ./server/
COPY e2e/package.json ./e2e/
RUN node .yarn/releases/yarn-*.cjs workspaces focus queuepilot-server --production

# --- source + build artifacts ---
# cast_sidecar is plain Python and ships as source. The Node half ships ONLY as the
# esbuild bundle + its map: `server/src/*.ts` is deliberately absent from this image.
COPY cast_sidecar ./cast_sidecar
COPY --from=server-build /repo/server/dist ./server/dist
COPY --from=web-build /repo/web/dist ./web/dist
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x entrypoint.sh

ENV PATH="/opt/venv/bin:${PATH}"
CMD ["./entrypoint.sh"]
