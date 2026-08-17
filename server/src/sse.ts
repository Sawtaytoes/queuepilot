// --- live updates (SSE) ------------------------------------------------------ //
//
// The UI re-fetches whenever the data actually changes — a web edit from another tab, the
// Python prune after a scan, or a hand-edit over SMB. This module owns three things that
// used to sit at the bottom of server.js:
//
//   1. the client REGISTRY + `broadcast()`, the one write path every push goes through;
//   2. the `/api/events` handler, whose opening burst re-syncs a reconnecting client;
//   3. `startLiveUpdates()` — the queues.yaml/sets.yaml watcher and the two MQTT
//      subscriptions that call `broadcast()` from outside any request.
//
// The registry holds Hono `SSEStreamingApi` handles rather than raw Express `res` objects.
// That is not a cosmetic swap: a write to a closed Express socket silently no-ops, whereas
// `stream.writeSSE()` REJECTS — so every write below is individually `.catch()`ed and one
// dead client can no longer take down the broadcast loop for the others.
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { SSEStreamingApi } from 'hono/streaming';
import { watch } from 'node:fs';
import path from 'node:path';
import { QUEUES_PATH } from './config.js';
import { GROUPS_FILE } from './groups.js';
import * as cache from './cache.js';
import { errMessage } from './errors.js';
import * as mqttc from './mqttc.js';
import * as plex from './plex.js';
import * as sets from './sets.js';
import type { NowPlaying, PublishedSessionState, SseEvent } from './types.js';
import * as warm from './warm.js';

/** The payload type that goes with one `SseEvent` discriminant. */
type SseData<TType extends SseEvent['type']> = Extract<SseEvent, { type: TType }>['data'];

const sseClients = new Set<SSEStreamingApi>();

// Keep proxies (and the browser's own idle timer) from cutting an otherwise-silent stream.
// 25 s and the exact `: ping` comment are carried over verbatim from the Express version —
// clients ignore SSE comment lines, so the bytes exist purely as a heartbeat.
const KEEPALIVE_INTERVAL_MS = 25_000;
const KEEPALIVE_COMMENT = ': ping\n\n';

/**
 * Write a keepalive comment every `intervalMs` until the stream closes; returns the cleanup
 * closure, which the caller MUST run on disconnect or the timer keeps firing into a dead
 * stream forever.
 *
 * Shape copied from `gallery-downloader/packages/web-server/src/sseKeepalive.ts` (which is
 * itself a file-for-file twin of mux-magic's). Only the interval and the comment text differ,
 * and only because this app's were already 25 s / `: ping`.
 */
function startSseKeepalive(stream: SSEStreamingApi): () => void {
  const timer = setInterval(() => {
    if (stream.closed || stream.aborted) {
      clearInterval(timer);
      return;
    }
    stream.write(KEEPALIVE_COMMENT).catch(() => {
      clearInterval(timer);
    });
  }, KEEPALIVE_INTERVAL_MS);

  return () => {
    clearInterval(timer);
  };
}

/**
 * Push one event to every connected client.
 *
 * Exported because three callers outside the request path use it: the file watcher and the
 * two MQTT subscriptions in `startLiveUpdates()` below.
 */
export function broadcast<TType extends SseEvent['type']>(
  type: TType,
  data: SseData<TType>,
): void {
  const payload = JSON.stringify(data);
  for (const stream of sseClients) {
    // Per-client catch: a client that vanished between the last keepalive and now rejects
    // here, and swallowing it locally keeps the remaining clients' writes going. (The
    // Express version could not fail this way — and could not notice, either.)
    stream.writeSSE({ event: type, data: payload }).catch(() => undefined);
  }
  // A `data` event means the config changed (edit, prune, SMB hand-edit) — warm the cache so
  // the next load is hot. Debounced inside warm.kick(), so an edit burst coalesces.
  if (type === 'data') warm.kick();
}

// --- live now-playing -------------------------------------------------------- //
// Attach the parent series/collection to the raw HA payload so the UI can match a playing
// episode to its SERIES tile. Only worth resolving while something is actually on screen.
let LAST_NOW: NowPlaying | null = null; // withContext()-enriched, kept fresh by onNowPlaying

/** The enriched now-playing snapshot, for `/api/now` and the on-connect replay. */
export const lastNow = (): NowPlaying | null => LAST_NOW;

export async function withContext(
  now: NowPlaying | null | undefined,
): Promise<NowPlaying | null> {
  if (!now || !now.ratingKey) return now || null;
  if (now.state !== 'playing' && now.state !== 'paused') return { ...now, context: null };
  return { ...now, context: await plex.playingContext(now.ratingKey) };
}

/** The `{now, set}` snapshot every `now` frame carries (live push and on-connect replay). */
const nowPayload = (set?: string | null) => ({
  now: LAST_NOW,
  set: set === undefined ? (mqttc.lastState() || {}).set || null : set,
});

/** `GET /api/events` — mounted under the `/api` sub-app. */
export function sseRoutes(): Hono {
  const app = new Hono();

  app.get('/events', (c) => streamSSE(c, async (stream) => {
    // No `flushHeaders()` analogue exists on a Hono stream: the response head goes out with
    // the FIRST write, which is why the `hello` frame below is load-bearing rather than
    // ceremonial. Drop it and a client with nothing playing sees no bytes for 25 s.
    const stopKeepalive = startSseKeepalive(stream);
    try {
      await stream.writeSSE({ event: 'hello', data: '{}' });
      sseClients.add(stream);
      // Re-sync on (re)connect: a phone that slept its tab dropped this SSE stream and missed
      // every `now` published while it was gone, so it would show the stale page-load value
      // until a manual refresh. Replay the CURRENT retained now-playing snapshot to JUST this
      // client — same `{ now, set }` shape the live onNowPlaying/onState broadcasts use — so a
      // resumed tab reconciles the playing tile + active-queue badge without waiting for the
      // next MQTT change. (The `state` event only drives play-result toasts, so it is
      // deliberately NOT replayed here — re-toasting an old result on every wake would be
      // noise; the tile hydrates from `now`.) Registered BEFORE this write, exactly as the
      // Express version was, so a change landing mid-handshake is not missed.
      await stream.writeSSE({ event: 'now', data: JSON.stringify(nowPayload()) });

      // Hold the response open until the client goes away. Without this the handler returns,
      // `streamSSE` closes the response, and the browser sees the stream end immediately.
      await new Promise<void>((resolve) => {
        const signal = c.req.raw.signal;
        if (signal.aborted || stream.aborted || stream.closed) {
          resolve();
          return;
        }
        signal.addEventListener('abort', () => resolve(), { once: true });
        stream.onAbort(() => resolve());
      });
    } finally {
      // BOTH halves, always: leaking the interval burns a timer per client forever, and
      // leaking the registry entry makes every later broadcast write to a dead stream. The
      // `finally` also covers a throw out of the handshake writes, which `req.on('close')`
      // did not.
      stopKeepalive();
      sseClients.delete(stream);
    }
  }));

  return app;
}

/**
 * Wire the three out-of-band `broadcast()` callers: the config-file watcher and the two MQTT
 * subscriptions. Called once from `index.ts` — deliberately NOT from `buildServer()`, so a
 * test can build the Hono root and drive it with `root.fetch()` without starting watchers.
 */
export function startLiveUpdates(): void {
  // Watch the DIRECTORY (the atomic rename-replace writes would orphan a file watch) and
  // debounce bursts.
  let timer: NodeJS.Timeout | null = null;
  const byDir = new Map<string, Set<string>>(); // dir -> filenames we care about (may share a dir)
  // groups.yaml joins the watch list: it is hand-edited over SMB exactly like the other
  // two, and a group added there has to reach an open tab the same way a renamed queue
  // does — otherwise the picker at the top of the app is the one thing that needs an F5.
  for (const p of [QUEUES_PATH, sets.SETS_PATH, GROUPS_FILE]) {
    const d = path.dirname(p);
    if (!byDir.has(d)) byDir.set(d, new Set());
    byDir.get(d)?.add(path.basename(p));
  }
  for (const [dir, names] of byDir) {
    try {
      watch(dir, (_ev, filename) => {
        if (filename && !names.has(String(filename))) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => broadcast('data', {}), 300);
      });
    } catch (e) {
      console.log(`[sse] watch unavailable for ${dir} (${errMessage(e)}) — UI updates on its own actions only`);
    }
  }

  // Session state changes (a play result landing) push to the UI the same way.
  mqttc.onState((state: PublishedSessionState | null) => {
    broadcast('state', state || {});
    // The active-queue badge keys off state.set, so a new session must repaint it even when
    // the Plex-side payload hasn't changed yet.
    broadcast('now', nowPayload((state || {}).set || null));
  });

  // Live playback pushes the same way — every state/attribute change on the Shield's
  // media_player, so the highlight follows the queue as it auto-advances.
  mqttc.onNowPlaying(async (now: NowPlaying | null) => {
    try {
      LAST_NOW = await withContext(now);
    } catch {
      LAST_NOW = now || null; // an unresolvable key still moves the play/pause state
    }
    // Precise, free cache invalidation (B3.1): the now-playing event already tells us which
    // show is on screen. When something is playing, drop that show's cached allLeaves so the
    // next /api/queues refetches exactly the one show whose watched-state may have moved, and
    // bump the cache generation so a browser's /api/queues ETag busts. Nothing else refetches.
    try {
      const showRk = LAST_NOW && LAST_NOW.context && LAST_NOW.context.showRatingKey;
      const st = LAST_NOW
        && (LAST_NOW.state === 'playing' || LAST_NOW.state === 'stopped' || LAST_NOW.state === 'paused');
      if (showRk && st) {
        await cache.dropLeaves(showRk);
        await cache.bumpGeneration();
      }
    } catch {
      /* cache is best-effort */
    }
    broadcast('now', nowPayload());
  });
}
