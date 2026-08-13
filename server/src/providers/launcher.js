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
import * as routing from '../engine/routing.js';
import { providerFor } from './index.js';
import { resolveSingle, isMixed } from './blocks.js';

/**
 * Resolve a set to a launch descriptor without performing any redirect.
 * Exported separately so the offline tests can assert the URL without an HTTP layer.
 */
export async function launchDescriptor(setId, { client = null } = {}) {
  const reg = routing.loadSets();
  const cfg = reg.sets?.[setId];
  if (!cfg) return { error: `unknown queue '${setId}'`, status: 404 };
  if (cfg.enabled === false) return { error: `queue '${setId}' is not enabled`, status: 409 };

  if (isMixed(cfg)) {
    // Deliberately not guessed. A mixed queue is a push target AND a pull URL at once, and
    // what handoff() should return is an open decision that belongs to the owner.
    return {
      error: `queue '${setId}' draws from more than one provider, and what a mixed queue `
        + 'hands off is not decided yet',
      status: 501,
    };
  }

  const block = resolveSingle(cfg);
  let provider;
  try {
    provider = providerFor(block.provider, { client });
  } catch (e) {
    // NOT CONFIGURED lands here, by name, rather than as a silent empty reader.
    return { error: String(e.message || e), status: 503 };
  }

  if (provider.delivery !== 'pull') {
    return {
      error: `queue '${setId}' runs on ${provider.label}, which is pushed to a device rather `
        + 'than opened by a link — start it from the app or a card',
      status: 409,
    };
  }

  const { play } = await provider.buckets({ cfg, libraries: block.libraries });
  if (!play.length) {
    return { error: `queue '${setId}' has nothing unread left`, status: 409 };
  }

  // Rebuild on launch: the reading list is the RUNTIME ARTIFACT, never the store. Unlike a
  // Plex playQueue it persists and is visible in Kavita's own UI, so one list per set is
  // reused rather than a fresh one per launch.
  const artifact = await provider.materialize(play, { setName: setId });
  const out = provider.handoff(artifact);
  if (!out.url) return { error: out.error || 'no reader URL', status: 500 };
  return { url: out.url, readingListId: out.readingListId, count: play.length, status: 302 };
}

/** Mount `GET /go/:setId` on an Express app. */
export function mountLauncher(app) {
  app.get('/go/:setId', async (req, res) => {
    try {
      const d = await launchDescriptor(String(req.params.setId || ''));
      if (d.error) return res.status(d.status).type('text/plain').send(d.error);
      // 302, not 301: the target chapter changes every time you read one, so this must
      // never be cached by the browser as a permanent move.
      res.setHeader('Cache-Control', 'no-store');
      return res.redirect(302, d.url);
    } catch (e) {
      return res.status(500).type('text/plain').send(String(e.message || e));
    }
  });
}
