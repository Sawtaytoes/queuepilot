import { Hono } from 'hono';
import * as cache from '../cache.js';
import { ROTATION_LENGTH, ROTATION_LENGTH_MAX, TOPUP_AT } from '../env.js';
import { toWeight } from '../engine/weight.js';
import { errMessage } from '../errors.js';
import * as plex from '../plex.js';
import * as providerTiles from '../providers/tiles.js';
import * as queues from '../queues.js';
import * as sets from '../sets.js';
import * as tiles from '../tiles.js';
import { mapLimit } from './mapLimit.js';
import { readBody } from './readBody.js';

/** The set REGISTRY surface: create/edit/delete/reorder a set, and a channel's members. */
export function setsRoutes(): Hono {
  const app = new Hono();

  // The registry + the Plex library list (all video libraries) — one call feeds the
  // queue-editor modal and the Channels filter editor. Membership is opt-in per set; there
  // is no global hide list, so every video library is offered.
  app.get('/sets', async (c) => {
    try {
      const reg = await sets.getRegistry();
      let libraries: Awaited<ReturnType<typeof plex.sections>> = [];
      try {
        libraries = await plex.sections();
      } catch {
        /* Plex down: registry still serves */
      }
      // The lineup DEFAULTS, so the pool editor can chip the right option "Default", clamp to
      // the same ceiling the writer does, and say in words when a refill actually fires. These
      // are env, not constants — hardcoding 12/200/3 in the web bundle would let a deployment
      // that moves ROTATION_LENGTH silently disagree with its own editor, which is the same
      // class of split-brain the entry-count Default chip exists to close.
      const lineup = { length: ROTATION_LENGTH, max: ROTATION_LENGTH_MAX, topup_at: TOPUP_AT };
      return c.json({ ...reg, libraries, lineup });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // Create a curated queue. Body: {label, kind, sections}. Returns its generated id.
  app.post('/sets', async (c) => {
    try {
      return c.json(await sets.createSet(await readBody(c)));
    } catch (e) {
      return c.json({ error: errMessage(e) }, 400);
    }
  });

  // Shelf order. Body: {ids} — the new full order.
  app.patch('/sets-order', async (c) => {
    const { ids } = await readBody(c);
    if (!Array.isArray(ids)) return c.json({ error: 'ids[] required' }, 400);
    try {
      return c.json(await sets.reorderSets(ids.map(String)));
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // Edit one set: label/kind/sections (+ rotation filter knobs). Ids never change.
  app.patch('/sets/:id', async (c) => {
    try {
      const body = await readBody(c);
      const out = await sets.updateSet(c.req.param('id'), body);
      // Config mutation → cache invalidation (B3.3), cheapest useful thing: bump the generation
      // so open browsers' /api/queues ETags bust, and if the libraries a set draws from changed,
      // drop those section listings so the next read reflects the new pool.
      await cache.bumpGeneration();
      if ('sections' in body || 'item_sections' in body) {
        const secs = [
          ...(Array.isArray(body.sections) ? body.sections : []),
          ...(Array.isArray(body.item_sections) ? body.item_sections : []),
        ];
        await cache.dropSectionListings(secs.map(String));
      }
      return c.json(out);
    } catch (e) {
      return c.json({ error: errMessage(e) }, 400);
    }
  });

  // Delete a curated queue — registry entry AND its queues.yaml list.
  app.delete('/sets/:id', async (c) => {
    try {
      const id = c.req.param('id');
      const out = await sets.deleteSet(id);
      if (out.deleted) await queues.deleteSetKey(id);
      return c.json(out);
    } catch (e) {
      return c.json({ error: errMessage(e) }, 400);
    }
  });

  // A rotation channel's explicit members, resolved for DISPLAY (poster, type, next-episode)
  // through the same resolvers the queue grid uses — so the member grid shows exactly what
  // the Python service will resolve at scan time (v3 PR 3). `raw` + `index` round-trip so
  // the grid can PATCH the whole members array back (whole-array replace, like profiles).
  app.get('/sets/:id/members', async (c) => {
    try {
      const s = await sets.getSet(c.req.param('id'));
      if (!s || s.source !== 'rotation') return c.json({ error: 'not a rotation channel' }, 400);
      const sections = [...new Set([...(s.sections || []), ...(s.item_sections || [])])];
      // A per-profile channel passes the active binding's user_uuid so each member tile's next-up
      // reflects THAT profile's watched state, not the admin's — matching the per-account pool
      // below it. Absent (legacy/admin) => admin view, unchanged; a mint failure degrades to admin.
      const uuidQ = (c.req.query('uuid') ?? '').trim();
      let scope = {};
      if (uuidQ) {
        try { scope = { token: await plex.accountToken(uuidQ), account: uuidQ }; } catch { scope = {}; }
      }
      // A READING channel's members are its provider's, resolved in one bounded round-trip —
      // the same seam the queue grid uses, and for the same reason: Plex cannot resolve them.
      // (A pull channel has no Plex Home profile to scope by, so `scope` does not apply.)
      if (s.delivery === 'pull') {
        const values = s.members || [];
        const cores = await providerTiles.resolveTiles(s, values);
        return c.json({
          members: values.map((value, index) => ({
            index,
            raw: value,
            // `cores` is index-aligned with `values` by contract, which is what the `!` says —
            // `noUncheckedIndexedAccess` is the only reason it is written.
            ...cores[index]!,
            start: value && typeof value === 'object' && value.start ? value.start : null,
            episodes: value && typeof value === 'object' && value.episodes ? value.episodes : 1,
            weight: toWeight(value && typeof value === 'object' ? value.weight : null),
          })),
        });
      }
      const members = await mapLimit(s.members || [], 6, async (value, index) => {
        // A hand-written {collection: <name>} mapping resolves like its string spelling.
        const v = value && typeof value === 'object' && value.collection && value.ratingKey == null
          ? `Collection: ${value.collection}`
          : value;
        const start = value && typeof value === 'object' && value.start ? value.start : null;
        // The SAME resolver the queue grid uses, so a member tile and a queue tile of the same
        // collection read identically (member poster + title, collection as the badge).
        const core = await tiles.resolveTile(sections, v, start, scope);
        return {
          index,
          raw: value, // the ORIGINAL value (not the collection-mapped `v`) round-trips for PATCH
          ...core,
          start,
          // Per-member episodes/weight, read off the stored mapping (a bare ratingKey or a
          // "Collection: x" string carries neither, hence the defaults).
          episodes: value && typeof value === 'object' && value.episodes ? value.episodes : 1,
          weight: toWeight(value && typeof value === 'object' ? value.weight : null),
        };
      });
      return c.json({ members });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  return app;
}
