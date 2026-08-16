import { Hono } from 'hono';
import { statSync } from 'node:fs';
import * as cache from '../cache.js';
import { QUEUES_PATH } from '../config.js';
import { toWeight } from '../engine/weight.js';
import * as providerTiles from '../providers/tiles.js';
import type { ProviderTile } from '../providers/tiles.js';
import * as queues from '../queues.js';
import * as sets from '../sets.js';
import * as tiles from '../tiles.js';
import type { ResolvedTile } from '../tiles.js';
import type { QueueEntry, Start } from '../types.js';
import { mapLimit } from './mapLimit.js';
import { readBody } from './readBody.js';

/** The (mtimeMs, size) of a config file, for the ETag — a stat, not a read. */
function statPair(p: string): string {
  try {
    const st = statSync(p);
    return `${Math.round(st.mtimeMs)}-${st.size}`;
  } catch {
    return '0-0';
  }
}

/** A queue entry's manual start override ({season,episode}); null = automatic next-unwatched. */
const startOf = (e: QueueEntry): Start | null => (
  e.value && typeof e.value === 'object' && e.value.start ? e.value.start : null
);

/**
 * One resolved queue entry, as the grid reads it: the tile CORE (from whichever resolver
 * answered — Plex's tiles.ts or the provider's) plus the per-entry knobs, which are stored on
 * the entry and so are identical whatever resolved it.
 */
function queueTile(e: QueueEntry, core: ResolvedTile | ProviderTile) {
  const v = e.value && typeof e.value === 'object' ? e.value : null;
  // The entry's `batch_stops_at` override (null = follow the set): WHERE its batch may stop,
  // as opposed to `episodes` = how long it is.
  const batchStopsAt = v && v.batch_stops_at ? String(v.batch_stops_at).trim().toLowerCase() : null;
  return {
    key: e.key,
    raw: tiles.displayFor(e.value),
    ...core,
    episodes: v && v.episodes ? v.episodes : 1,
    volumes: v && v.volumes ? v.volumes : 1,
    // How often this entry comes up when the set is randomized (1 = normal; the editor shows
    // a tag only above 1).
    weight: toWeight(v ? v.weight : null),
    batch_stops_at: batchStopsAt === 'member' || batchStopsAt === 'season' ? batchStopsAt : null,
    start: startOf(e),
    // A finished-but-kept entry (Python tagged it done); the grid greys it and the
    // "Remove all completed" button targets these. False for every plain entry.
    done: Boolean(e.done),
  };
}

/**
 * Express spelled this `requireQueueSet(res, id)` and had it WRITE the 400 itself, returning
 * null so the caller could `return`. A Hono handler has to return its own Response, so the
 * check is a plain predicate and each caller returns the (identical) 400 body.
 */
async function isQueueSet(id: string): Promise<boolean> {
  const s = await sets.getSet(id);
  return Boolean(s && s.source === 'queue');
}

export function queuesRoutes(): Hono {
  const app = new Hono();

  // The SHELF SKELETON: the registry plus, per curated set, one entry per queued item carrying
  // only the raw title string already written in queues.yaml. ZERO Plex calls — one queues.yaml
  // read and one sets.yaml read, both memoized on mtime, so this answers in ~15 ms cold.
  //
  // This exists to unblock first paint. /api/queues has to talk to Plex (~60 calls: resolve,
  // next-episode, collection children) and takes 2.6-2.8 s, and until it landed the page was
  // blank and then inserted ten shelves at once — a 0.398 CLS and the entire "feels slow"
  // complaint. The frontend now renders the full shelf structure from THIS response, at final
  // geometry with skeleton tiles, then swaps posters and next-episode in place when /api/queues
  // arrives. Nothing moves when the second response lands.
  //
  // The response is deliberately a SUBSET of /api/queues' shape (same `sets`/`order` envelope,
  // same per-item `key`/`raw`/`title`/`done` fields) so the client can render one component
  // against either and the swap is a field-by-field merge, not a different code path.
  app.get('/shelves', async (c) => {
    try {
      const reg = await sets.getRegistry();
      const all = await queues.listAll();
      const result: Record<string, unknown> = {};
      for (const s of reg.sets) {
        const entries = s.source === 'queue' ? all.get(s.id) || [] : [];
        result[s.id] = {
          label: s.label,
          kind: s.kind,
          source: s.source,
          sections: s.sections,
          count: entries.length,
          items: entries.map((e) => ({
            key: e.key,
            raw: tiles.displayFor(e.value),
            // Unresolved: the title line shows the raw string until /api/queues supplies the
            // real Plex title. Same field the resolved response fills, so the merge is a
            // straight overwrite rather than a branch.
            title: tiles.displayFor(e.value),
            resolved: false,
            done: Boolean(e.done),
          })),
        };
      }
      return c.json({ sets: result, order: reg.sets.map((s) => s.id) });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // Every queue in registry order, each curated entry resolved (poster + type) for
  // rendering. Rotation channels appear with their metadata but no items — their lineup is
  // computed, not stored (the Channels view previews it separately).
  //
  // The fan-out is FLATTENED (B4.3): instead of ten sets resolved one after another (each set's
  // entries concurrent but the sets serial — ten serial batches), one work list across ALL sets
  // runs through a single mapLimit(8), then regroups. Wall-clock becomes the slowest single
  // batch, not their sum. Backed by the SQLite cache in plex.js, a warm call makes zero Plex
  // requests; a watch on the Shield busts exactly the affected show (mqttc.onNowPlaying).
  app.get('/queues', async (c) => {
    try {
      // ETag (B7): the two config files' stat pairs + the cache generation (bumped on every
      // invalidation, so a watch on the Shield correctly busts a browser's cached copy).
      //
      // `no-store` on purpose. This payload also carries PROVIDER progress (Kavita
      // pagesRead, Plex next-up). The tag above does not change when you mark a chapter
      // read in Kavita — Kavita has no webhook, and nothing here polls — so
      // `must-revalidate` made F5 send If-None-Match and get a 304 of the stale tiles.
      // The JS `apiConditional` path still uses the ETag for SSE storms; a real load
      // or a forced refresh must hit Kavita.
      //
      // Hand-rolled, and it STAYS hand-rolled: this is app logic over file mtimes and a cache
      // generation, nothing to do with the shared static handler's ETag on `web/dist`.
      const tag = `W/"${statPair(QUEUES_PATH)}-${statPair(sets.SETS_PATH)}-${await cache.generation()}"`;
      c.header('ETag', tag);
      c.header('Cache-Control', 'private, no-store');
      if (c.req.header('if-none-match') === tag) return c.body(null, 304);

      const reg = await sets.getRegistry();
      const all = await queues.listAll();
      const result: Record<string, { label: unknown; kind: unknown; source: unknown; sections: unknown; items: unknown[] }> = {};
      // One flat work list across every set, so the concurrency budget is spent globally.
      const work: { s: typeof reg.sets[number]; e: QueueEntry }[] = [];
      // A PULL set resolves through ITS provider instead — per set, because the provider seam
      // takes the whole set (one block, one client, one bounded fan-out) rather than one entry
      // at a time. Without this every reading entry resolves against Plex, which has never
      // heard of a Kavita seriesId: no poster, no next-up, just the stored title.
      const pull: { s: typeof reg.sets[number]; entries: QueueEntry[] }[] = [];
      for (const s of reg.sets) {
        result[s.id] = { label: s.label, kind: s.kind, source: s.source, sections: s.sections, items: [] };
        if (s.source !== 'queue') continue;
        const entries = all.get(s.id) || [];
        if (s.delivery === 'pull') {
          if (entries.length) pull.push({ s, entries });
          continue;
        }
        for (const e of entries) work.push({ s, e });
      }
      const resolvedItems = await mapLimit(work, 8, async ({ s, e }) => {
        // resolveTile surfaces, for a series, the next unwatched episode (queue plays it
        // TV-style until the whole show is watched); for a Collection, its first still-unwatched
        // member ("Next: <member>", not an opaque "N in order"). A manual start override on the
        // entry floors the pick — {season,episode} for a show, {series,season,episode} for a
        // collection (which member to begin at plus the floor inside it).
        const core = await tiles.resolveTile(s.sections, e.value, startOf(e), {});
        return { setId: s.id, tile: queueTile(e, core) };
      });
      // Regroup by set, preserving the flat list's order (set-then-entry order).
      for (const { setId, tile } of resolvedItems) result[setId]?.items.push(tile);

      // The pull sets, each in one provider round-trip, all of them concurrently.
      await Promise.all(pull.map(async ({ s, entries }) => {
        const cores = await providerTiles.resolveTiles(s, entries.map((e) => e.value));
        // `?.` only because `noUncheckedIndexedAccess` cannot see that the loop above wrote
        // this key; upstream indexed it directly and the entry is always there.
        const row = result[s.id];
        // `cores` is index-aligned with `entries` by contract, which is what the `!` says.
        if (row) row.items = entries.map((e, i) => queueTile(e, cores[i]!));
      }));

      return c.json({ sets: result, order: reg.sets.map((s) => s.id) });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- queue items ------------------------------------------------------------ //

  // Append an entry. Body: {value} — a title string, a ratingKey, or {ratingKey,title}. With
  // {type:'collection'} the entry is written as the literal "Collection: <name>" string the
  // Python resolver expands into that collection's ordered children (name taken from the
  // value's title, or the string itself).
  app.post('/queues/:set/items', async (c) => {
    const set = c.req.param('set');
    if (!(await isQueueSet(set))) return c.json({ error: 'unknown set' }, 400);
    const body = await readBody(c);
    let value = body.value;
    const type = body.type;
    const position = body.position === 'bottom' ? 'bottom' : 'top';
    if (type === 'collection') {
      const name = value && typeof value === 'object'
        ? (value as { title?: unknown; name?: unknown }).title || (value as { name?: unknown }).name
        : value;
      const nm = name == null ? '' : String(name).trim();
      if (!nm) return c.json({ error: 'empty collection name' }, 400);
      value = /^collection:/i.test(nm) ? nm : `Collection: ${nm}`;
    }
    if (value == null || value === '') return c.json({ error: 'empty value' }, 400);
    try {
      return c.json(await queues.addItem(set, value, position));
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // Remove ALL done (finished-but-kept) entries from a set's queues.yaml list. The ONLY path
  // that drops done entries (never automatic) — the grid's "Remove all completed" button.
  app.post('/queues/:set/remove-completed', async (c) => {
    const set = c.req.param('set');
    if (!(await isQueueSet(set))) return c.json({ error: 'unknown set' }, 400);
    try {
      return c.json(await queues.removeCompleted(set));
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.delete('/queues/:set/items/:key', async (c) => {
    const set = c.req.param('set');
    if (!(await isQueueSet(set))) return c.json({ error: 'unknown set' }, 400);
    try {
      return c.json(await queues.removeItem(set, decodeURIComponent(c.req.param('key'))));
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // Bulk multi-select move into `toSet`. Body: {items:[{fromSet,key}], toSet}.
  app.post('/queues/move-bulk', async (c) => {
    const { items, toSet } = await readBody(c);
    if (!(await isQueueSet(String(toSet ?? '')))) return c.json({ error: 'unknown set' }, 400);
    if (!Array.isArray(items)) return c.json({ error: 'items[] required' }, 400);
    try {
      return c.json(await queues.moveBulk(items, toSet));
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // Bulk multi-select remove. Body: {items:[{fromSet,key}]}.
  app.post('/queues/remove-bulk', async (c) => {
    const { items } = await readBody(c);
    if (!Array.isArray(items)) return c.json({ error: 'items[] required' }, 400);
    try {
      return c.json(await queues.removeBulk(items));
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // Cross-queue move (drag a card into another queue). Body: {fromSet, toSet, key, toKeys}.
  app.patch('/queues/move', async (c) => {
    const { fromSet, toSet, key, toKeys } = await readBody(c);
    if (!(await isQueueSet(String(fromSet ?? ''))) || !(await isQueueSet(String(toSet ?? '')))) {
      return c.json({ error: 'unknown set' }, 400);
    }
    if (!key || !Array.isArray(toKeys)) return c.json({ error: 'key + toKeys[] required' }, 400);
    try {
      return c.json(await queues.moveItem(fromSet, toSet, key, toKeys));
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // BULK-apply settings to many entries at once — the editor's selection bar. Body:
  // {items: [{set, key}], episodes?, weight?, batch_stops_at?, reset?}. Only the named fields
  // are touched, so "set every one of these to 3x" never disturbs their episode counts.
  //
  // One HTTP call rather than N: each queues.* writer takes the cross-process YAML lock and
  // rewrites the file, so a 20-entry selection fired as 20 PATCHes is 20 lock acquisitions and
  // 20 whole-file rewrites — and a half-applied bulk edit if one of them loses the race.
  //
  // Registered BEFORE `/queues/:set/order` so the literal wins; `bulk` is two segments and
  // `:set/order` is three, so they cannot actually collide, but the original order is kept.
  app.patch('/queues/bulk', async (c) => {
    const body = await readBody(c);
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) return c.json({ error: 'items[] required' }, 400);
    const wants = (k: string) => k in body && body[k] != null;
    const applied: { set: string; key: string }[] = [];
    const failed: { set: string; key: string; error: string }[] = [];
    try {
      for (const it of items) {
        const set = String(it.set || '');
        const key = String(it.key || '');
        if (!set || !key || !(await sets.getSet(set))) {
          failed.push({ set, key, error: 'unknown set' });
          continue;
        }
        // `reset` is "back to the defaults": clear every per-entry override in one pass. It runs
        // FIRST so an explicit field in the same request still wins (reset + weight: 3 = only the
        // weight survives), which is what the bar's "Reset to defaults" + a picked value means.
        if (body.reset) {
          await queues.setEpisodes(set, key, 1);
          await queues.setVolumes(set, key, 1);
          await queues.setWeight(set, key, 1);
          await queues.setBatchStop(set, key, null);
          await queues.setStart(set, key, null);
        }
        if (wants('episodes')) await queues.setEpisodes(set, key, body.episodes);
        if (wants('volumes')) await queues.setVolumes(set, key, body.volumes);
        if (wants('weight')) await queues.setWeight(set, key, body.weight);
        if (wants('batch_stops_at')) await queues.setBatchStop(set, key, body.batch_stops_at);
        applied.push({ set, key });
      }
      await cache.bumpGeneration();
      return c.json({ ok: failed.length === 0, applied: applied.length, failed });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // How many VOLUMES a volume-based series contributes per visit. Body: {volumes}.
  // Independent of `episodes` — a volume is a collection of chapters.
  app.patch('/queues/:set/items/:key/volumes', async (c) => {
    const set = c.req.param('set');
    if (!(await isQueueSet(set))) return c.json({ error: 'unknown set' }, 400);
    const { volumes } = await readBody(c);
    try {
      return c.json(await queues.setVolumes(set, decodeURIComponent(c.req.param('key')), volumes));
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // Set a series entry's per-show episodes-per-play. Body: {episodes}.
  app.patch('/queues/:set/items/:key/episodes', async (c) => {
    const set = c.req.param('set');
    if (!(await isQueueSet(set))) return c.json({ error: 'unknown set' }, 400);
    const { episodes } = await readBody(c);
    try {
      return c.json(await queues.setEpisodes(set, decodeURIComponent(c.req.param('key')), episodes));
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // Set a series/collection entry's `batch_stops_at` override (where its batch may stop, as
  // opposed to how long it is). Body: {batch_stops_at}. "none"/blank clears it = follow the set.
  app.patch('/queues/:set/items/:key/batch-stop', async (c) => {
    const set = c.req.param('set');
    if (!(await isQueueSet(set))) return c.json({ error: 'unknown set' }, 400);
    const body = await readBody(c);
    try {
      return c.json(await queues.setBatchStop(set, decodeURIComponent(c.req.param('key')), body.batch_stops_at));
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // Set an entry's WEIGHT — how many slots it takes per round when the set is randomized.
  // Body: {weight}. 1 (or anything unusable) clears the override.
  app.patch('/queues/:set/items/:key/weight', async (c) => {
    const set = c.req.param('set');
    if (!(await isQueueSet(set))) return c.json({ error: 'unknown set' }, 400);
    const { weight } = await readBody(c);
    try {
      return c.json(await queues.setWeight(set, decodeURIComponent(c.req.param('key')), weight));
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // Set/clear an entry's manual START point. Body: {start: {season, episode}} for a show,
  // {start: {series, season?, episode?}} for a collection (which member to begin at), or
  // {start: null} to revert to automatic next-unwatched.
  app.patch('/queues/:set/items/:key/start', async (c) => {
    const set = c.req.param('set');
    if (!(await isQueueSet(set))) return c.json({ error: 'unknown set' }, 400);
    // `req.body ? req.body.start : null` — and under express.json() `req.body` was always an
    // object, so this is `body.start` (undefined when the key is absent, which
    // queues.normalizeStart() treats as a clear, same as null).
    const { start } = await readBody(c);
    try {
      return c.json(await queues.setStart(set, decodeURIComponent(c.req.param('key')), start));
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.patch('/queues/:set/order', async (c) => {
    const set = c.req.param('set');
    if (!(await isQueueSet(set))) return c.json({ error: 'unknown set' }, 400);
    const { keys } = await readBody(c);
    if (!Array.isArray(keys)) return c.json({ error: 'keys[] required' }, 400);
    try {
      return c.json(await queues.reorder(set, keys));
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  return app;
}
