// The 302 launcher — the substitute for cast on a PULL provider.
//
// Kavita has no cast and no webhooks (feasibility §4), so a reading queue cannot be started
// by pushing at a device. Instead each queue gets ONE STABLE, BOOKMARKABLE URL on this app:
//
//     GET /go/<setId>   ->  rebuild the reading list, then 302 into the reader deep link
//
// The tablet keeps its Kavita session, so the redirect lands logged-in. The URL never
// changes, so it can go on a bookmark, a home-screen tile, or later an NFC tag.
//
// This is a genuinely better fit than cast would be, not a consolation prize: reading is
// PULL — you pick up the tablet when you are ready — where TV is PUSH.
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import * as routing from '../engine/routing.js';
import { errMessage } from '../errors.js';
import type { PlexClient } from '../types.js';
import { resolveSingle, isMixed } from './blocks.js';
import { providerFor } from './index.js';
// The lineup itself is built in ONE place, shared with top-up — see that module's header for
// why a second copy of the `buckets()` call was a bug waiting to be reintroduced.
import { pullLineup } from './pullLineup.js';

/** What `launchDescriptor()` answers with: either a redirect target or an error + status. */
export type LaunchDescriptor =
  | { url: string; readingListId?: number | string | null; count: number; status: 302; error?: undefined }
  | { error: string; status: number; url?: undefined };

/**
 * Resolve a set to a launch descriptor without performing any redirect.
 * Exported separately so the offline tests can assert the URL without an HTTP layer
 * (`e2e/kavita-provider-test.mjs`).
 */
export async function launchDescriptor(
  setId: string,
  { client = null, only = null }: { client?: PlexClient | null; only?: string | null } = {},
): Promise<LaunchDescriptor> {
  const reg = routing.loadSets();
  const cfg = reg?.sets?.[setId];
  if (!cfg) return { error: `unknown queue '${setId}'`, status: 404 };
  if (cfg.enabled === false) return { error: `queue '${setId}' is not enabled`, status: 409 };

  // `{ ...cfg }` rather than `cfg`: `BlockSourceCfg` carries an index signature, and
  // TypeScript grants an implicit one to an anonymous object type but never to an interface —
  // so a structurally-compatible `RoutingSetCfg` is rejected on that technicality alone. The
  // spread is a shallow copy with no semantic change. (Widening blocks.ts's parameter to
  // accept the two real registry shapes is the actual fix, and is not this PR's file.)
  const blockCfg = { ...cfg };

  if (isMixed(blockCfg)) {
    // Deliberately not guessed. A mixed queue is a push target AND a pull URL at once, and
    // what handoff() should return is an open decision that belongs to the owner.
    return {
      error: `queue '${setId}' draws from more than one provider, and what a mixed queue `
        + 'hands off is not decided yet',
      status: 501,
    };
  }

  const block = resolveSingle(blockCfg);
  let provider;
  try {
    provider = providerFor(block.provider, { client });
  } catch (e) {
    // NOT CONFIGURED lands here, by name, rather than as a silent empty reader.
    return { error: errMessage(e), status: 503 };
  }

  if (provider.delivery !== 'pull') {
    return {
      error: `queue '${setId}' runs on ${provider.label}, which is pushed to a device rather `
        + 'than opened by a link — start it from the app or a card',
      status: 409,
    };
  }

  const play = await pullLineup(setId, cfg, provider, { only });
  if (!play.length) {
    return { error: `queue '${setId}' has nothing unread left`, status: 409 };
  }

  // Rebuild on launch: the reading list is the RUNTIME ARTIFACT, never the store. Unlike a
  // Plex playQueue it persists and is visible in Kavita's own UI, so one list per set is
  // reused rather than a fresh one per launch.
  // `setLabel` is only read on the cover — same fallback the session path uses, so a set with
  // no label paints its id rather than nothing.
  const artifact = await provider.materialize(play, { setName: setId, setLabel: cfg.label || setId });
  // `handoff()` is declared as possibly-async (the Plex side awaits a real playback), and the
  // Kavita one is synchronous. `await` on a plain value is a no-op, so this is the same
  // behaviour the un-awaited JS had — it just says so in a way the union can be narrowed on.
  const out = await provider.handoff(artifact);
  // A PUSH result has no `url` at all, which the old code saw as `undefined` and treated
  // exactly like a pull result with a null url. Same branch, spelled as the narrowing it is.
  //
  // A provider that DECLINES — it answered with a reason rather than a URL — is a 409, not a
  // 500. MiSTer is the first: it is a pull provider with nothing a browser could follow,
  // because a MiSTer game is started by Home Assistant (which enables the controller adapter
  // and switches the activity) rather than by a link. Reporting that as a server error made
  // a working, deliberate refusal look like a crash.
  if (!('url' in out) || !out.url) {
    return out.error
      ? { error: out.error, status: 409 }
      : { error: 'no reader URL', status: 500 };
  }
  return { url: out.url, readingListId: out.readingListId, count: play.length, status: 302 };
}

/**
 * `GET /go/:setId` as a Hono sub-app, mounted at the ROOT rather than under `/api`.
 *
 * Deliberately not under /api — it is a URL a person bookmarks or puts on a home screen, so
 * it stays short and stable, and it is exempt from the /api mutation snapshot (it writes no
 * config).
 */
export function launcherRoutes(): Hono {
  const app = new Hono();

  app.get('/go/:setId', async (c) => {
    try {
      // `?only=<entryKey>` is "read THIS one now" — the ▶ on a single tile. The pull
      // counterpart of the play-one-entry key the push path already threads; without it a
      // reading tile's ▶ could only open the Plex device menu, which offered a Shield, a
      // Plex Dash and a phone for something none of them can open (reported live 2026-08-15).
      const d = await launchDescriptor(c.req.param('setId') || '', {
        only: c.req.query('only') || null,
      });
      // `d.url === undefined` and not `d.error` — same branch, but it discriminates the union
      // so the redirect below knows it has a string.
      if (d.url === undefined) return c.text(d.error, d.status as ContentfulStatusCode);
      // 302, not 301: the target chapter changes every time you read one, so this must
      // never be cached by the browser as a permanent move.
      c.header('Cache-Control', 'no-store');
      return c.redirect(d.url, 302);
    } catch (e) {
      return c.text(errMessage(e), 500);
    }
  });

  return app;
}
