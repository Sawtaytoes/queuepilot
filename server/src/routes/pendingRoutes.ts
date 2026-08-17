import { Hono } from 'hono';

import * as pending from '../pending.js';
import { liveClient } from '../engine/plex-live.js';
import * as plex from '../plex.js';
import { readBody } from './readBody.js';
import type { PlexMetadata } from '../types.js';

/**
 * PENDING — what arrived that nothing is going to play.
 *
 * The listing is one container read per video library, which is the same read the pool engine
 * already does per scan. It is NOT cached here: the whole point of the screen is that it is
 * current, and it is opened by hand rather than polled.
 */
export function pendingRoutes(): Hono {
  const app = new Hono();

  const listSection = async (sectionId: number, type: 1 | 2): Promise<PlexMetadata[]> => {
    const json = await plex.plexGet(
      `/library/sections/${sectionId}/all?type=${type}&X-Plex-Container-Size=10000`,
    );
    const mc = (json as { MediaContainer?: { Metadata?: PlexMetadata[] } }).MediaContainer;
    return mc?.Metadata || [];
  };

  app.get('/pending', async (c) => {
    try {
      const libs = (await plex.sections()).map((l) => ({
        id: Number(l.id), title: String(l.title ?? ''), type: String(l.type ?? ''),
        video: Boolean(l.video), other: Boolean(l.other),
      }));
      const { items, state } = await pending.pendingItems(liveClient(), libs, listSection);
      return c.json({ items, seen_through: state.seen_through, dismissed: state.dismissed.length });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // Say no to ONE item. Per-item rather than moving the watermark, or skipping one film would
  // also hide everything added after it.
  app.post('/pending/dismiss', async (c) => {
    const { ratingKey } = await readBody(c);
    if (!ratingKey) return c.json({ error: 'ratingKey required' }, 400);
    try {
      const state = await pending.dismiss(String(ratingKey));
      return c.json({ ok: true, dismissed: state.dismissed.length });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // Clear the whole list in one gesture by moving the watermark.
  app.post('/pending/seen', async (c) => {
    try {
      const state = await pending.markSeen();
      return c.json({ ok: true, seen_through: state.seen_through });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  return app;
}
