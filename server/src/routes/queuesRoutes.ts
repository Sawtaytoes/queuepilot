import { Hono } from 'hono';
import { statSync } from 'node:fs';
import * as cache from '../cache.js';
import { QUEUES_PATH } from '../config.js';
import { liveClient } from '../engine/plex-live.js';
import { inProgress } from '../engine/resolve.js';
import * as routing from '../engine/routing.js';
import { toWeight } from '../engine/weight.js';
import { COLLECTION_PREFIX_RE, isLegacyScalarEntry } from '../entryFormat.js';
import { findDuplicateItem } from '../entryIdentity.js';
import * as finished from '../finished.js';
import * as plex from '../plex.js';
import type { AccountScope } from '../plex.js';
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
 * Will the next scan REVIVE this entry? The mirror image of `isFinished`.
 *
 * `done` is a cache of a resolution result, and the resolver clears it the moment the entry
 * resolves to anything playable again — a new season, a new episode, a new member in a
 * collection (decision 2026-08-15-a-done-entry-revives-when-there-is-something-to-play). But
 * an episode AIRING triggers no scan, so the flag stays true until the card is next tapped:
 * the tile greys out and wears "Completed" while its own yellow line names the very episode
 * that is about to play. That contradiction is what the owner reported, on the same Dating
 * Sim collection the 2026-08-15 decision was written about, the week its S2E7 landed.
 *
 * So this says now what that scan will decide, exactly as `isFinished` does in the other
 * direction. It changes the BADGE only — the file stays the record of truth for everything
 * that writes, and the next scan is still what clears the flag.
 *
 * A HAND-marked `done: true` carries no `done_at`, which is what marks it a deliberate skip.
 * The resolver revives one of those only for an in-progress head, and an in-progress tile
 * already reads "In Progress" over "Completed" — so it keeps its badge here and the two agree.
 *
 * Shows, collections and reading series only. "Something to play" is `nextEp`, which this
 * endpoint has already resolved per entry, and a next-up lookup that ERRORED reports no
 * `nextEp` — so a Plex hiccup leaves every badge exactly as it was. A MOVIE is deliberately
 * out: its head is the watched HISTORY, and a history read that fails comes back as an empty
 * set (`finished.watchedFor`), which is indistinguishable from "nothing is watched" — reviving
 * off that would drop the badge from every finished film in the app on one bad read. A movie
 * gains no new content anyway; the one revival it has is an in-progress head, which the
 * "In Progress" badge already covers.
 */
function isRevivedEntry(e: QueueEntry, core: ResolvedTile | ProviderTile): boolean {
  if (!e.done || e.doneAt == null) return false;
  if (core.type !== 'show' && core.type !== 'collection') return false;
  // `collectionNext` answers null (never a memberless object) once a collection is played
  // out, so this is the same test for both types, and the same one the tile face turns into
  // its "All watched" line.
  return Boolean(core.nextEp);
}

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
    // null = follow the set. Never coerce a missing key to 1: the set default may
    // be 2, and a stored 1 is then a real override (queues.storedCount).
    episodes: queues.storedCount(v ? v.episodes : null),
    volumes: queues.storedCount(v ? v.volumes : null),
    // How often this entry comes up when the set is randomized (1 = normal; the editor shows
    // a tag only above 1).
    weight: toWeight(v ? v.weight : null),
    batch_stops_at: batchStopsAt === 'member' || batchStopsAt === 'season' ? batchStopsAt : null,
    start: startOf(e),
    // A finished-but-kept entry (Python tagged it done); the grid greys it and the
    // "Remove all completed" button targets these. False for every plain entry.
    done: Boolean(e.done),
    // The same thing judged LIVE rather than read off the file — see `tagFinishedMovies`.
    // Overwritten there; false here so the field is never absent on a tile.
    isFinished: false,
    // The opposite prediction — see `isRevivedEntry`.
    isRevived: isRevivedEntry(e, core),
  };
}

/** A tile as the pass below mutates it: the `queueTile` fields it reads and writes. */
type FinishableTile = ReturnType<typeof queueTile> & {
  type?: string | null;
  ratingKey?: string | null;
  partiallyWatched?: boolean;
  viewOffset?: number;
  duration?: number;
};

/**
 * Tag the MOVIE tiles the next scan would find nothing left to play in.
 *
 * `done` is only ever as fresh as the last scan (a session start, or now the end of
 * playback), so on its own the grid cannot tell you about a film you finished a minute ago —
 * or one watched somewhere QueuePilot never saw, on a phone. This says what the engine WOULD
 * say, evaluated now, and it is deliberately the engine's own rule, not a second opinion:
 * `resolveMember`'s movie branch is `keepMovie = !watched.has(rk)`, un-dropped when the film
 * is actually in progress (`resolve.inProgress`) — so this is `watched && !inProgress`.
 *
 * Only movies. A show or collection already reports "nothing left" through `nextEp: null`,
 * which the tile face turns into "All watched"
 * (decision 2026-08-15-a-done-entry-revives-when-there-is-something-to-play), and a series'
 * remaining-episode rules (specials, start floors, batch stops) live in the resolver — a
 * cheap re-implementation here would be a SECOND rule that could disagree with the flag.
 *
 * Two reads back this: the set's watched history, memoized per accounts×sections
 * (`finished.watchedFor`), and one batched view-state call for the watched candidates only,
 * because a movie tile's cached viewCount can be up to 7 days old. The view state is read
 * with the ADMIN token, exactly like every other watch-state field on this endpoint.
 */
async function tagFinishedMovies(
  rows: readonly { setId: string; tile: FinishableTile }[],
): Promise<void> {
  const engineReg = routing.loadSets();
  if (!engineReg) return;
  const movies = rows.filter((r) => r.tile.type === 'movie' && r.tile.ratingKey);
  if (!movies.length) return;

  const setIds = [...new Set(movies.map((r) => r.setId))];
  const watchedBySet = new Map<string, Set<string>>();
  await Promise.all(setIds.map(async (id) => {
    const cfg = engineReg.sets[id];
    if (!cfg) return;
    watchedBySet.set(id, await finished.watchedFor(cfg, routing.bindingFor(cfg, null)));
  }));

  const isWatched = (r: { setId: string; tile: FinishableTile }): boolean =>
    Boolean(watchedBySet.get(r.setId)?.has(String(r.tile.ratingKey)));
  const candidates = movies.filter(isWatched);
  if (!candidates.length) return;

  const live = await plex.viewStates(candidates.map((r) => String(r.tile.ratingKey)));
  for (const { tile } of candidates) {
    const state = live.get(String(tile.ratingKey));
    // No live answer (Plex hiccup, or the item is gone): keep what the tile already said
    // rather than promote a possibly-stale cached view state into a Completed badge.
    if (!state) continue;
    tile.partiallyWatched = inProgress(state.viewOffset, state.viewCount);
    tile.viewOffset = state.viewOffset;
    tile.duration = state.duration;
    tile.isFinished = !tile.partiallyWatched;
  }
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
      // Every next-up below is read as the profile the queue PLAYS UNDER, not as the owner.
      // This grid used to pass an empty scope unconditionally, which was invisible for as
      // long as every curated queue was Bob's own: the admin token was the right answer by
      // accident. The first queue gated to a kid ("Carol 1" -> Older Kids) exposed it — a
      // Dragon Ball collection tile read "Next: Dragon Ball Z E109", which is where the OWNER
      // is, 246 episodes past where Carol is.
      //
      // Resolved once per distinct profile rather than per tile: the lookup is memoized in
      // plex.js, but a mint on a cold cache is two plex.tv round-trips and this grid fans out
      // over every entry in every set.
      const scopes = new Map<string, AccountScope>();
      await Promise.all(
        [...new Set(reg.sets.map((s) => s.requires_profile || ''))].map(async (p) => {
          scopes.set(p, await plex.profileScope(p));
        }),
      );
      const resolvedItems = await mapLimit(work, 8, async ({ s, e }) => {
        // resolveTile surfaces, for a series, the next unwatched episode (queue plays it
        // TV-style until the whole show is watched); for a Collection, its first still-unwatched
        // member ("Next: <member>", not an opaque "N in order"). A manual start override on the
        // entry floors the pick — {season,episode} for a show, {series,season,episode} for a
        // collection (which member to begin at plus the floor inside it).
        // A LEGACY SCALAR entry is not resolved at all. The engine refuses to play one
        // (`loadEntries`), so resolving it here would paint a normal poster for a line that
        // never plays — the one genuinely dangerous failure of a per-entry refusal. An
        // unresolved tile is what the grid already paints red.
        const core = isLegacyScalarEntry(e.value)
          ? tiles.unresolvedTile(e.value)
          : await tiles.resolveTile(s.sections, e.value, startOf(e), scopes.get(s.requires_profile || '') ?? {});
        return { setId: s.id, tile: queueTile(e, core) };
      });
      // What the next scan would call finished, said now — one pass over the flat list, so
      // the watched-history reads and the view-state call are shared across every set.
      await tagFinishedMovies(resolvedItems);
      // Regroup by set, preserving the flat list's order (set-then-entry order).
      for (const { setId, tile } of resolvedItems) result[setId]?.items.push(tile);

      // The pull sets, each in one provider round-trip, all of them concurrently.
      await Promise.all(pull.map(async ({ s, entries }) => {
        const cores = await providerTiles.resolveTiles(s, entries.map((e) => e.value));
        // `?.` only because `noUncheckedIndexedAccess` cannot see that the loop above wrote
        // this key; upstream indexed it directly and the entry is always there.
        const row = result[s.id];
        // `cores` is index-aligned with `entries` by contract, which is what the `!` says.
        // Same refusal on the PULL path — the provider would happily resolve a bare title
        // against Kavita and paint a cover for an entry the engine will not queue.
        if (row) {
          row.items = entries.map((e, i) => queueTile(
            e,
            isLegacyScalarEntry(e.value) ? tiles.unresolvedTile(e.value) : cores[i]!,
          ));
        }
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
  //
  // THE DUPLICATE TEST LIVES HERE, not in `queues.addItem` and not in `entryKey`.
  //
  // `entryKey` is the LINE identity and is pinned — the Python writer addresses the same lines
  // by it and `e2e/fixtures/golden/` records what it returns — so the looser ITEM test is a
  // second, separate check (`entryIdentity.findDuplicateItem`). `addItem` keeps its exact-key
  // refusal untouched and stays a pure YAML editor with no Plex dependency, which is what lets
  // every offline gate keep calling it. This route is the one place every user-initiated add
  // passes through (Pending, the toolbar search, the queue search row), and it already holds
  // both a Plex client and the set's cfg.
  //
  // Reported 2026-08-21: an anime queue named a show by BARE TITLE, the Pending tile posted the
  // same show by rating key, the two keyed differently, and a second copy landed.
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
      // `{collection: <name>}`, not the `"Collection: <name>"` STRING this used to write.
      // Same `entryKey` either way (`title:Collection: <name>`), so nothing is re-keyed — but
      // the file holds mappings now, and a collection says what it is in its key rather than
      // in a prefix every reader has to re-parse.
      value = { collection: COLLECTION_PREFIX_RE.exec(nm)?.[1]?.trim() ?? nm };
    }
    if (value == null || value === '') return c.json({ error: 'empty value' }, 400);
    try {
      // `added: false` is what `addItem` already answers for an exact key repeat, so the wire
      // shape is unchanged; `duplicateOf` names the line that made it a repeat. The cfg is the
      // ENGINE's (`routing.loadSets`), because it is the engine's resolver that runs — the
      // registry entry `isQueueSet` reads is the file shape, which is a different object.
      const cfg = routing.loadSets()?.sets[set];
      if (cfg) {
        const dup = await findDuplicateItem(liveClient(), cfg, await queues.listSet(set), value);
        if (dup) return c.json({ added: false, key: dup.key, duplicateOf: dup.key });
      }
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
          // Follow THIS set's defaults, not the engine floor of 1 — a queue at
          // episodes: 2 must not grow an `episodes: 1` override on every reset.
          const s = await sets.getSet(set);
          const chapterDefault = s && s.source === 'queue' ? (s.episodes ?? 1) : 1;
          const volumeDefault = s && s.source === 'queue' ? (s.volumes ?? 1) : 1;
          await queues.setEpisodes(set, key, chapterDefault);
          await queues.setVolumes(set, key, volumeDefault);
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
