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

  /**
   * The collections in one library, for the pending pass.
   *
   * `plex.collections()` takes a query and title-filters client-side; an empty query is every
   * collection in the section, which is what this wants. Collections per library are few, so
   * this is one cheap read on top of the listing that was already happening.
   */
  const listCollections = async (sectionId: number) => (
    (await plex.collections([sectionId], '')).map((row) => ({
      childCount: row.childCount,
      ratingKey: row.ratingKey,
      sectionId: row.sectionId,
      title: row.title,
    }))
  );

  app.get('/pending', async (c) => {
    try {
      const libs = (await plex.sections()).map((l) => ({
        id: Number(l.id), title: String(l.title ?? ''), type: String(l.type ?? ''),
        video: Boolean(l.video), other: Boolean(l.other),
      }));
      const { items, state } = await pending.pendingItems(
        liveClient(), libs, listSection, listCollections,
      );
      // The filter panel is drawn from THIS response rather than from `/api/sets`, and the
      // two differ in the way that matters: `libraries` here is every video library the
      // screen COULD draw from, and `selected` is the ids it did. Sending the resolved
      // selection — not the raw `state.libraries` — is what lets the panel show the default
      // as checked boxes instead of as an empty set the owner would read as "nothing".
      const choosable = libs.filter((l) => l.video);
      return c.json({
        items,
        seen_through: state.seen_through,
        dismissed: state.dismissed.length,
        libraries: choosable,
        selected: pending.selectedLibraries(libs, state).map((l) => l.id),
        // Whether the selection is a real choice or the fallback, so the panel can offer
        // "back to default" only when there is something to go back from.
        isDefault: state.libraries === null,
      });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  /**
   * Choose the libraries. `{ libraries: null }` clears the choice and restores the default;
   * `{ libraries: [] }` is the deliberate blank page. They are different states and the
   * route keeps them apart.
   */
  app.post('/pending/libraries', async (c) => {
    const body = await readBody(c);
    const value = (body as { libraries?: unknown }).libraries;
    if (value !== null && !Array.isArray(value)) {
      return c.json({ error: 'libraries must be an array of section ids, or null' }, 400);
    }
    try {
      const state = await pending.setLibraries(
        value === null ? null : (value as unknown[]).map(Number),
      );
      return c.json({ ok: true, libraries: state.libraries });
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
