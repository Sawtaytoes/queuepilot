// queuepilot-web: the browser editor for the curated queues (queues.yaml) and the
// set registry (sets.yaml). This is the whole application; the only other process in the
// container is the Python cast_sidecar. Read-only against Plex (search + poster proxy);
// its writes go to queues.yaml (still guarded by the cross-process lock in queues.js) and
// sets.yaml.
//
// This file is BOOTSTRAP ONLY — resolve paths, open the cache, wire the live-update
// subscriptions, listen. Everything that answers a request lives in `buildServer.ts` and
// `routes/`.
import { serve } from '@hono/node-server';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServer } from './buildServer.js';
import * as cache from './cache.js';
import { WEB_PORT } from './config.js';
import * as finished from './finished.js';
import * as mqttd from './mqttd.js';
import { seedIfMissing } from './groups.js';
import * as sets from './sets.js';
import { startLiveUpdates } from './sse.js';
import * as warm from './warm.js';

// Resolved from `import.meta.url`, never `process.cwd()`: the e2e harnesses spawn this from
// the repo root, the Dockerfile's entrypoint from `/app`, and a dev `npm start` from
// `server/` — cwd is different in all three, and the module's own location is not.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Monorepo layout: server/ (this API) + web/ (the React frontend) + queue_builder/
// (the Python playback/MQTT engine) — one container, user decision 2026-07-20.
//
// `web/` is a Vite project since M6d, so what gets served is its BUILD OUTPUT, not its
// sources. Run `npm --prefix web run build` before starting this server (the Dockerfile does
// it in a builder stage; e2e/run.sh and CI do it inline). The app routes on real paths, so
// the browser requests `/queues` and `/q/<id>` directly and `buildServer` answers unmatched
// extensionless paths with index.html (`hasSpaFallback: true`).
//
// The `..`/`..` depth is the same in dev and in prod, which is not a coincidence worth
// leaving unstated — VERIFIED against both layouts:
//   dev  — this module is `<repo>/server/src/index.ts`   -> `<repo>/web/dist`
//   prod — the esbuild bundle is `/app/server/dist/index.js` (Dockerfile stage 2, and
//          `COPY --from=web-build /web/dist ./web/dist` puts the frontend at `/app/web/dist`)
//                                                        -> `/app/web/dist`
// Both are `<x>/server/<one dir>/`, so `../../web/dist` lands correctly in each. If the
// bundle ever moves a level (e.g. `server/dist/server/index.js`), this breaks silently into
// a 404-for-everything static root.
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'web', 'dist');

// Open the derived Plex cache (decision 2026-08-03-sqlite-is-a-derived-plex-cache) before
// listening. A failure here disables caching but never blocks the server — every reader in
// cache.js degrades to a miss.
await cache.init();

// A fresh install has no groups.yaml, and an empty group picker is indistinguishable
// from a broken one. Seed it from whatever accounts the registry already names, once, before
// anything can read it. Best-effort by construction — every failure path inside logs and
// returns false, because a missing OPTIONAL config file must not stop the app serving.
try {
  const { sets: registrySets } = await sets.getRegistry();
  await seedIfMissing(registrySets);
} catch (e) {
  console.log(`[groups] seed skipped: ${e instanceof Error ? e.message : String(e)}`);
}

// The file watcher + the two MQTT subscriptions that push over SSE. Kept out of
// buildServer() so building the root for a test starts no timers and no watchers.
startLiveUpdates();

// The third now-playing subscriber, and the only one that WRITES: when an item leaves the
// screen it re-runs the finished-entry bookkeeping for the set that was playing, so a movie
// you just finished is marked `done` in seconds instead of waiting for the next card tap.
// Same reason as above for living here rather than in buildServer().
finished.watchPlaybackEnd();

const app = buildServer({ publicDir: PUBLIC_DIR });

serve({ fetch: app.fetch, port: WEB_PORT }, () => {
  console.log(`[queuepilot-web] listening on :${WEB_PORT}`);
  mqttd.start();
  warm.start();
});
