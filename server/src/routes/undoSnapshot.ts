import type { MiddlewareHandler } from 'hono';
import { errMessage } from '../errors.js';
import * as history from '../history.js';

/**
 * Every data mutation snapshots the files first → the undo/redo stack. `/api/play` only
 * publishes MQTT and `/api/undo|redo` manage the stack themselves.
 *
 * A PROVIDER TOKEN WRITE IS EXCLUDED, and that exclusion is load-bearing rather than an
 * optimisation: history.snapshot() copies the managed config files into the undo stack and
 * its .history.json mirror. A credential that gets copied into an undo stack has escaped its
 * file, which is exactly what decision
 * 2026-08-12-provider-tokens-live-in-a-separate-config-file forbids. The token file is
 * written only by providers/config.js writeSecret(), which is outside this machinery.
 *
 * THE BOARD-GAME ROUTES ARE EXCLUDED, for two separate reasons and both matter. `POST
 * /board-games/pick` MUTATES NOTHING — it is a read with a body, and every reroll would push
 * an identical copy of the managed files onto the stack and bury whatever the owner actually
 * wanted back. And a play or a known-how claim is a row in the BOOK OF RECORD, not in any file
 * this snapshots, so an undo would restore YAML that never changed and leave the write in
 * place: a control that appears to take back the thing you just did and does not. The finish
 * panel carries its own Undo, scoped to exactly the claims it created.
 *
 * THE PREFIX IS STRIPPED BY HAND, and that is the whole reason this is a factory taking
 * `mountPrefix`. Express mounted the original on a path prefix (`app.use('/api', ...)`), so
 * `req.path` inside it had already lost the `/api`, which is why the exclusion list reads
 * `/play` and not `/api/play`. Hono does NOT strip: `c.req.path` is the full request path. Compare
 * the untrimmed path against `/api/play` and NOTHING ever matches, so the snapshot silently
 * runs for undo/redo/play and — far worse — for a provider token write. `e2e/history-persist-test.mjs`
 * and `e2e/kbd-undo-test.mjs` are the behavioural gates.
 */
export function undoSnapshot(mountPrefix: string): MiddlewareHandler {
  const MUTATING = ['POST', 'PATCH', 'PUT', 'DELETE'];
  const MANAGED = ['/play', '/undo', '/redo', '/board-games'];
  const TOKEN_PATH = /^\/providers\/[^/]+\/token$/;

  return async (c, next) => {
    const full = c.req.path;
    // `|| '/'` so a request to the mount point itself ("/api") reads as "/" rather than "".
    const mounted = full.startsWith(mountPrefix) ? full.slice(mountPrefix.length) || '/' : full;

    const isMutating = MUTATING.includes(c.req.method);
    const isManaged = MANAGED.some((p) => mounted === p || mounted.startsWith(`${p}/`))
      || TOKEN_PATH.test(mounted);
    if (isMutating && !isManaged) {
      try {
        await history.snapshot();
      } catch (e) {
        console.log(`[history] snapshot failed: ${errMessage(e)}`);
      }
    }
    await next();
  };
}
