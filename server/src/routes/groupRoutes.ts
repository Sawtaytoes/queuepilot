import { Hono } from 'hono';

import { errMessage } from '../errors.js';
import {
  createGroup, deleteGroup, reorderGroups, resolveGroups, unassignedSetIds, updateGroup,
} from '../groups.js';
import * as sets from '../sets.js';
import { readBody } from './readBody.js';

/**
 * `GET /api/groups` — every QueuePilot group with its resolved membership.
 *
 * NOT `/api/profiles`, which is Plex's Home profile list and predates this by months. The
 * collision is the reason the concept is called a group at all; see `groups.ts`.
 *
 * Resolved SERVER-side rather than shipping the rules to the browser, because membership
 * reads a set's provider accounts (`requires_profile`, a rotation binding's `plex_user`, a
 * block's `profile`) and those are engine facts. A second implementation in TypeScript on
 * the client is a second answer to "whose is this", and the first thing that would drift is
 * the explicit-beats-derived ordering.
 *
 * `unassigned` rides along so the UI can say "these are filed nowhere" without asking a
 * second time or re-deriving anything.
 */
export function groupRoutes(): Hono {
  const app = new Hono();

  app.get('/groups', async (c) => {
    try {
      const reg = await sets.getRegistry();
      return c.json({
        groups: resolveGroups(reg.sets),
        unassigned: unassignedSetIds(reg.sets),
      });
    } catch (e) {
      return c.json({ error: errMessage(e) }, 500);
    }
  });

  // Create. Body: {label, accounts?, sets?}. Returns the generated (immutable) id.
  app.post('/groups', async (c) => {
    try {
      return c.json(await createGroup(await readBody(c)));
    } catch (e) {
      // 400, not 500: every throw in the writer is a rejected INPUT (no label, a reserved
      // id, a label with nothing to slugify), and answering 500 would tell the editor to
      // retry something that can never succeed.
      return c.json({ error: errMessage(e) }, 400);
    }
  });

  // Edit one group. `id` is never writable — it is the URL, and a bookmark is a promise.
  app.patch('/groups/:id', async (c) => {
    try {
      return c.json(await updateGroup(c.req.param('id'), await readBody(c)));
    } catch (e) {
      return c.json({ error: errMessage(e) }, 400);
    }
  });

  app.delete('/groups/:id', async (c) => {
    try {
      return c.json(await deleteGroup(c.req.param('id')));
    } catch (e) {
      return c.json({ error: errMessage(e) }, 400);
    }
  });

  // Chip order. Body: {ids} — the new full order; anything omitted keeps its relative
  // position at the end rather than being dropped (see reorderGroups).
  app.patch('/groups-order', async (c) => {
    const { ids } = await readBody(c);
    if (!Array.isArray(ids)) return c.json({ error: 'ids[] required' }, 400);
    try {
      return c.json(await reorderGroups(ids.map(String)));
    } catch (e) {
      return c.json({ error: errMessage(e) }, 500);
    }
  });

  return app;
}
