import { createStaticHandler } from '@charcuterie/server';
import { Hono } from 'hono';
import { errMessage } from './errors.js';
import { launcherRoutes } from './providers/launcher.js';
import { historyRoutes } from './routes/historyRoutes.js';
import { playbackRoutes } from './routes/playbackRoutes.js';
import { plexMetadataRoutes } from './routes/plexMetadataRoutes.js';
import { providersRoutes } from './routes/providersRoutes.js';
import { queuesRoutes } from './routes/queuesRoutes.js';
import { setsRoutes } from './routes/setsRoutes.js';
import { undoSnapshot } from './routes/undoSnapshot.js';
import { sseRoutes } from './sse.js';

/** Where the mutation-snapshot middleware and every JSON route are mounted. */
const API_PREFIX = '/api';

interface BuildServerOptions {
  /** Absolute path to `web/dist` — the Vite build output. */
  publicDir: string;
}

/**
 * Assemble the Hono root and return it.
 *
 * Returning rather than listening is the point: the whole surface is drivable as
 * `root.fetch(new Request(...))` with no port bound, which is what `server.js` — a single
 * 1095-line module that called `app.listen()` at import time — could never be.
 *
 * Mount order is load-bearing:
 *   1. `/api`      — the JSON API, behind the undo-snapshot middleware.
 *   2. `/go/:setId` — the launcher, at the root because it is a URL a person bookmarks.
 *   3. `*`          — the static handler, LAST, so it only ever sees what nothing above claimed.
 */
export function buildServer({ publicDir }: BuildServerOptions): Hono {
  const root = new Hono();

  // Express had NO error handler: every route try/catches itself, and anything that escaped
  // fell through to Express's default handler, which answers an HTML 500 to a caller that
  // asked for JSON. This is the deliberate (small) behaviour change — same status, a JSON body.
  root.onError((err, c) => {
    console.log(`[queuepilot-web] unhandled error on ${c.req.method} ${c.req.path}: ${errMessage(err)}`);
    return c.json({ error: errMessage(err) }, 500);
  });

  const api = new Hono();
  // Registered BEFORE the routes: Hono runs handlers in registration order, so a `use()`
  // added after them would never get to snapshot anything.
  api.use('*', undoSnapshot(API_PREFIX));
  api.route('/', historyRoutes());
  api.route('/', queuesRoutes());
  api.route('/', setsRoutes());
  api.route('/', plexMetadataRoutes());
  api.route('/', providersRoutes());
  api.route('/', playbackRoutes());
  api.route('/', sseRoutes());
  root.route(API_PREFIX, api);

  root.route('/', launcherRoutes());

  // The whole of the old transfer/caching block — `compression`, the hand-rolled
  // `staticCompressed` that negotiated `.br`/`.gz` by mutating `req.url`, its CONTENT_TYPES
  // map and traversal guard, and the two `express.static` mounts with the immutable/no-cache
  // split — collapses to this. `@charcuterie/server` serves the build-time-precompressed
  // siblings `precompressAssets()` writes in `web/vite.config.ts`, sets `immutable` on
  // `/assets/` and `no-cache` on everything else, and adds an ETag to the `no-cache` bucket.
  //
  // NO compression middleware is added back, deliberately: the static bytes are compressed at
  // build time, and the JSON API is small. If one is ever added, `text/event-stream` MUST be
  // excluded or `/api/events` buffers and the stream looks dead.
  //
  // `hasSpaFallback: false` is load-bearing, not tidiness. The app routes on `location.hash`,
  // so every URL the browser requests is `/` and there is no SPA fallback today. The option
  // DEFAULTS to true, which would start answering every unmatched extensionless path with
  // index.html — turning what is now a 404 into a 200 page.
  root.use('*', createStaticHandler({ rootDir: publicDir, hasSpaFallback: false }));

  return root;
}
