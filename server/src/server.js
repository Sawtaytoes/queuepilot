// queuepilot-web: the browser editor for the curated queues (queues.yaml) and the
// set registry (sets.yaml). This is the whole application; the only other process in the
// container is the Python cast_sidecar. Read-only against Plex (search + poster proxy);
// its writes go to queues.yaml (still guarded by the cross-process lock in queues.js) and
// sets.yaml.
import compression from 'compression';
import express from 'express';
import { existsSync, watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WEB_PORT, QUEUES_PATH } from './config.js';
import * as mqttd from './mqttd.js';
import * as engineRouting from './engine/routing.js';
import { toWeight } from './engine/weight.js';
import * as enginePreview from './engine/preview.js';
import * as cache from './cache.js';
import * as history from './history.js';
import * as mqttc from './mqttc.js';
import * as plex from './plex.js';
import * as providers from './providers/config.js';
import { providerFor } from './providers/index.js';
import * as providerBlocks from './providers/blocks.js';
import { mountLauncher } from './providers/launcher.js';
import * as queues from './queues.js';
import * as sets from './sets.js';
import * as tiles from './tiles.js';
import * as warm from './warm.js';
import { statSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Monorepo layout: server/ (this JS API) + web/ (the React frontend) + queue_builder/
// (the Python playback/MQTT engine) — one container, user decision 2026-07-20.
//
// `web/` is a Vite project since M6d, so what gets served is its BUILD OUTPUT, not
// its sources. Run `npm --prefix web run build` before starting this server (the
// Dockerfile does it in a builder stage; e2e/run.sh and CI do it inline). The app
// routes on `location.hash`, so every URL the browser requests is `/` — there is no
// SPA fallback to add.
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'web', 'dist');

const app = express();
app.use(express.json());

// --- transfer encoding + caching for the static build ------------------------- //
// Measured 2026-08-03 against the live host: 376 KB of JS+CSS on EVERY load, served
// uncompressed with `cache-control: max-age=0` on content-hashed filenames. Both halves of
// that are fixed here rather than in the reverse proxy, because openresty is not versioned
// with this app (see web/scripts/precompress.mjs).

// Dynamic responses (the JSON API). Two exclusions are load-bearing:
//   * text/event-stream — compression buffers, so /api/events would deliver nothing until
//     the buffer filled and SSE would look dead. e2e/sse-test.mjs is the regression gate.
//   * image/* — /api/thumb already serves a Plex-transcoded JPEG; re-compressing spends CPU
//     to make it marginally bigger.
app.use(
  compression({
    filter: (req, res) => {
      const type = String(res.getHeader('Content-Type') || '');
      if (type.includes('text/event-stream')) return false;
      if (type.startsWith('image/')) return false;
      return compression.filter(req, res);
    },
  }),
);

// Serve the `.br` / `.gz` sibling that `npm run build` produced, when the client accepts it.
// Mounted BEFORE express.static: it rewrites req.url to the encoded file and falls through,
// so express.static does the actual sending (and keeps ETag/Range/304 handling).
const ENCODINGS = [
  ['br', '.br'],
  ['gzip', '.gz'],
];
const CONTENT_TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

function staticCompressed(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  // Only the content-hashed build output. index.html is negotiated by `compression` above.
  if (!req.path.startsWith('/assets/')) return next();
  const ext = path.extname(req.path);
  const type = CONTENT_TYPES[ext];
  if (!type) return next();
  const accept = String(req.headers['accept-encoding'] || '');
  for (const [token, suffix] of ENCODINGS) {
    if (!accept.includes(token)) continue;
    // req.path is already URL-decoded and normalized by Express; join() then rejects any
    // traversal that survived, because the result must stay under PUBLIC_DIR.
    const abs = path.join(PUBLIC_DIR, req.path + suffix);
    if (!abs.startsWith(PUBLIC_DIR + path.sep) || !existsSync(abs)) continue;
    // The Content-Type must come from the ORIGINAL extension — express.static would
    // otherwise type a `.js.br` as application/octet-stream and the browser would refuse it.
    res.setHeader('Content-Encoding', token);
    res.setHeader('Content-Type', type);
    // Caches key on Accept-Encoding, or a `br` body reaches a gzip-only client.
    res.setHeader('Vary', 'Accept-Encoding');
    req.url = req.url.replace(req.path, req.path + suffix);
    return next();
  }
  next();
}
app.use(staticCompressed);

// Content-hashed filenames — the whole point of the hash is that the URL changes when the
// bytes do, so a year of `immutable` is safe and a repeat visit costs ZERO asset bytes.
app.use(
  '/assets',
  express.static(path.join(PUBLIC_DIR, 'assets'), { immutable: true, maxAge: '1y' }),
);
// index.html and /icon.svg are NOT hashed, so they must revalidate. `no-cache` (revalidate
// before use), not `no-store` (never cache) — the cheap 304 path stays available.
app.use(
  express.static(PUBLIC_DIR, {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }),
);

// Every data mutation snapshots the files first → the undo/redo stack. /api/play only
// publishes MQTT and /api/undo|redo manage the stack themselves.
//
// A PROVIDER TOKEN WRITE IS EXCLUDED, and that exclusion is load-bearing rather than an
// optimisation: history.snapshot() copies the managed config files into the undo stack and
// its .history.json mirror. A credential that gets copied into an undo stack has escaped
// its file, which is exactly what decision
// 2026-08-12-provider-tokens-live-in-a-separate-config-file forbids. The token file is
// written only by providers/config.js writeSecret(), which is outside this machinery.
app.use('/api', async (req, _res, next) => {
  const mutating = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method);
  const managed = ['/play', '/undo', '/redo'].some((p) => req.path === p || req.path.startsWith(p + '/'))
    || /^\/providers\/[^/]+\/token$/.test(req.path);
  if (mutating && !managed) {
    try {
      await history.snapshot();
    } catch (e) {
      console.log(`[history] snapshot failed: ${e.message}`);
    }
  }
  next();
});

app.post('/api/undo', async (_req, res) => res.json(await history.undo()));
app.post('/api/redo', async (_req, res) => res.json(await history.redo()));
app.get('/api/history', (_req, res) => res.json(history.counts()));

// Run async mappers with bounded concurrency (poster/resolve fan-out on load).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}

function displayFor(value) {
  if (value && typeof value === 'object') return value.title || `ratingKey ${value.ratingKey}`;
  return String(value);
}

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
app.get('/api/shelves', async (_req, res) => {
  try {
    const reg = await sets.getRegistry();
    const all = await queues.listAll();
    const result = {};
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
          raw: displayFor(e.value),
          // Unresolved: the title line shows the raw string until /api/queues supplies the
          // real Plex title. Same field the resolved response fills, so the merge is a
          // straight overwrite rather than a branch.
          title: displayFor(e.value),
          resolved: false,
          done: Boolean(e.done),
        })),
      };
    }
    res.json({ sets: result, order: reg.sets.map((s) => s.id) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// The (mtimeMs, size) of a config file, for the ETag — a stat, not a read.
function statPair(p) {
  try {
    const st = statSync(p);
    return `${Math.round(st.mtimeMs)}-${st.size}`;
  } catch {
    return '0-0';
  }
}

// Every queue in registry order, each curated entry resolved (poster + type) for
// rendering. Rotation channels appear with their metadata but no items — their lineup is
// computed, not stored (the Channels view previews it separately).
//
// The fan-out is FLATTENED (B4.3): instead of ten sets resolved one after another (each set's
// entries concurrent but the sets serial — ten serial batches), one work list across ALL sets
// runs through a single mapLimit(8), then regroups. Wall-clock becomes the slowest single
// batch, not their sum. Backed by the SQLite cache in plex.js, a warm call makes zero Plex
// requests; a watch on the Shield busts exactly the affected show (mqttc.onNowPlaying below).
app.get('/api/queues', async (req, res) => {
  try {
    // ETag (B7): the two config files' stat pairs + the cache generation (bumped on every
    // invalidation, so a watch on the Shield correctly busts a browser's cached copy).
    // `private` because the response is per-install; must-revalidate so the browser always
    // sends If-None-Match rather than serving a stale body without asking.
    const tag = `W/"${statPair(QUEUES_PATH)}-${statPair(sets.SETS_PATH)}-${await cache.generation()}"`;
    res.set('ETag', tag);
    res.set('Cache-Control', 'private, max-age=0, must-revalidate');
    if (req.headers['if-none-match'] === tag) return res.status(304).end();

    const reg = await sets.getRegistry();
    const all = await queues.listAll();
    const result = {};
    // One flat work list across every set, so the concurrency budget is spent globally.
    const work = [];
    for (const s of reg.sets) {
      result[s.id] = { label: s.label, kind: s.kind, source: s.source, sections: s.sections, items: [] };
      if (s.source !== 'queue') continue;
      for (const e of all.get(s.id) || []) work.push({ s, e });
    }
    const resolvedItems = await mapLimit(work, 8, async ({ s, e }) => {
      // resolveTile surfaces, for a series, the next unwatched episode (queue plays it
      // TV-style until the whole show is watched); for a Collection, its first still-unwatched
      // member ("Next: <member>", not an opaque "N in order"). A manual start override on the
      // entry floors the pick — {season,episode} for a show, {series,season,episode} for a
      // collection (which member to begin at plus the floor inside it).
      const start = e.value && typeof e.value === 'object' && e.value.start ? e.value.start : null;
      const core = await tiles.resolveTile(s.sections, e.value, start);
      const episodes = e.value && typeof e.value === 'object' && e.value.episodes ? e.value.episodes : 1;
      // How often this entry comes up when the set is randomized (1 = normal; the editor shows
      // a tag only above 1).
      const weight = toWeight(e.value && typeof e.value === 'object' ? e.value.weight : null);
      // The entry's `batch_stops_at` override (null = follow the set): WHERE its batch may
      // stop, as opposed to `episodes` = how long it is.
      const batchStopsAt = e.value && typeof e.value === 'object' && e.value.batch_stops_at
        ? String(e.value.batch_stops_at).trim().toLowerCase() : null;
      return {
        setId: s.id,
        tile: {
          key: e.key,
          raw: tiles.displayFor(e.value),
          ...core,
          episodes,
          weight,
          batch_stops_at: ['member', 'season'].includes(batchStopsAt) ? batchStopsAt : null,
          // The manual start override (null = automatic next-unwatched).
          start,
          // A finished-but-kept entry (Python tagged it done); the grid greys it and the
          // "Remove all completed" button targets these. False for every plain entry.
          done: Boolean(e.done),
        },
      };
    });
    // Regroup by set, preserving the flat list's order (set-then-entry order).
    for (const { setId, tile } of resolvedItems) result[setId].items.push(tile);

    res.json({ sets: result, order: reg.sets.map((s) => s.id) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// --- set registry ------------------------------------------------------------ //

// The registry + the Plex library list (all video libraries) — one call feeds the
// queue-editor modal and the Channels filter editor. Membership is opt-in per set; there
// is no global hide list, so every video library is offered.
app.get('/api/sets', async (_req, res) => {
  try {
    const reg = await sets.getRegistry();
    let libraries = [];
    try {
      libraries = await plex.sections();
    } catch {
      /* Plex down: registry still serves */
    }
    res.json({ ...reg, libraries });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Create a curated queue. Body: {label, kind, sections}. Returns its generated id.
app.post('/api/sets', async (req, res) => {
  try {
    res.json(await sets.createSet(req.body || {}));
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// Shelf order. Body: {ids} — the new full order.
app.patch('/api/sets-order', async (req, res) => {
  const ids = req.body && req.body.ids;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids[] required' });
  try {
    res.json(await sets.reorderSets(ids.map(String)));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Edit one set: label/kind/sections (+ rotation filter knobs). Ids never change.
app.patch('/api/sets/:id', async (req, res) => {
  try {
    const out = await sets.updateSet(req.params.id, req.body || {});
    // Config mutation → cache invalidation (B3.3), cheapest useful thing: bump the generation
    // so open browsers' /api/queues ETags bust, and if the libraries a set draws from changed,
    // drop those section listings so the next read reflects the new pool.
    await cache.bumpGeneration();
    const body = req.body || {};
    if ('sections' in body || 'item_sections' in body) {
      const secs = [...(Array.isArray(body.sections) ? body.sections : []), ...(Array.isArray(body.item_sections) ? body.item_sections : [])];
      await cache.dropSectionListings(secs.map(String));
    }
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// Delete a curated queue — registry entry AND its queues.yaml list.
app.delete('/api/sets/:id', async (req, res) => {
  try {
    const out = await sets.deleteSet(req.params.id);
    if (out.deleted) await queues.deleteSetKey(req.params.id);
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// A rotation channel's explicit members, resolved for DISPLAY (poster, type, next-episode)
// through the same resolvers the queue grid uses — so the member grid shows exactly what
// the Python service will resolve at scan time (v3 PR 3). `raw` + `index` round-trip so
// the grid can PATCH the whole members array back (whole-array replace, like profiles).
app.get('/api/sets/:id/members', async (req, res) => {
  try {
    const s = await sets.getSet(req.params.id);
    if (!s || s.source !== 'rotation') return res.status(400).json({ error: 'not a rotation channel' });
    const sections = [...new Set([...(s.sections || []), ...(s.item_sections || [])])];
    // A per-profile channel passes the active binding's user_uuid so each member tile's next-up
    // reflects THAT profile's watched state, not the admin's — matching the per-account pool
    // below it. Absent (legacy/admin) => admin view, unchanged; a mint failure degrades to admin.
    const uuidQ = String(req.query.uuid || '').trim();
    let scope = {};
    if (uuidQ) {
      try { scope = { token: await plex.accountToken(uuidQ), account: uuidQ }; } catch { scope = {}; }
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
    res.json({ members });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// --- search ------------------------------------------------------------------ //
// With ?set= : scoped to that set's sections (the in-queue add box).
// Without    : the Home header's add-to-ANY-queue search — spans every section any set
//              draws from, deduped; each result carries its sectionId so the UI can
//              offer only the queues whose libraries include it.
// `?collections=1` also returns Plex Collections (type=18) in the same sections, tagged
// {type:'collection', ratingKey, title, sectionId, childCount}. Movie/show results carry
// type:'movie'|'show'. Default (no flag) is unchanged — items only.
// `?scope=all` searches EVERY video library, ignoring the set's own sections — the member
// picker uses it because a curated member is a manual INCLUDE, not bound to the channel's
// pool libraries (e.g. adding an Anime show to a Shows-only channel).
app.get('/api/search', async (req, res) => {
  const setId = String(req.query.set || '');
  const q = String(req.query.q || '').trim();
  const withCollections = req.query.collections === '1' || req.query.collections === 'true';
  const allLibraries = req.query.scope === 'all';
  if (!q) return res.json({ results: [] });
  try {
    // A PULL set searches ITS provider, not Plex. Routed here rather than at the four call
    // sites so every existing caller (queue add, channel members, channel filters) gets
    // provider-correct results without knowing providers exist — searching Plex for a Kavita
    // queue is what made "dungeon port" return nothing while the series sat in Webtoons.
    if (setId) {
      const s = await sets.getSet(setId);
      if (!s) return res.status(400).json({ error: 'unknown set' });
      if (s.delivery === 'pull') {
        const block = providerBlocks.resolveSingle(s);
        const p = providerFor(block.provider);
        if (typeof p.search !== 'function') return res.json({ results: [] });
        // Scoped to the queue's own libraries unless the caller explicitly asked to see
        // everything (the members picker's `scope=all`).
        const libraries = allLibraries ? [] : block.libraries;
        const found = await p.search(q, { libraries });
        return res.json({
          results: found.map((r) => ({
            // `ratingKey` is the shape every caller already stores and renders; here it
            // carries the provider's own item id, which is unambiguous because a queue draws
            // from exactly one provider.
            ratingKey: r.id,
            title: r.title,
            type: 'show',
            librarySectionTitle: r.libraryTitle,
            librarySectionID: r.libraryId,
          })),
        });
      }
    }

    let sections;
    let collectionSections;
    if (allLibraries) {
      // Every video library (movie + show), regardless of any set's configured sections —
      // so a manual include can come from a library no channel's rule pool draws from.
      let libs = [];
      try { libs = await plex.sections(); } catch { /* Plex down: empty search */ }
      sections = libs.filter((l) => l.video).map((l) => l.id);
      collectionSections = sections;
    } else if (setId) {
      const s = await sets.getSet(setId);
      if (!s) return res.status(400).json({ error: 'unknown set' });
      // Every section the set draws from: a rotation channel's members can be shorts/movies
      // out of its item_sections, not just shows (queue sets have item_sections: [] — no change).
      sections = [...new Set([...s.sections, ...s.item_sections])];
      // Collections can live in either the show sections OR the item (shorts/movie) sections.
      collectionSections = sections;
    } else {
      const reg = await sets.getRegistry();
      sections = [...new Set(reg.sets.flatMap((s) => [...s.sections, ...s.item_sections]))];
      collectionSections = sections;
    }
    const results = await plex.search(sections, q);
    if (withCollections) {
      try {
        // Collections lead the list: typing a franchise name ("Mobile Suit Gundam") turns up
        // dozens of individual show/movie hits, and the frontend caps the dropdown — so a
        // collection appended AFTER the items was pushed past the cap and never shown. The
        // collection is usually the higher-level thing the user wants, so it goes first.
        results.unshift(...(await plex.collections(collectionSections, q)));
      } catch {
        /* collections are additive — a Plex hiccup there never fails item search */
      }
    }
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// --- Plex Home users (the channel form's profile dropdown) -------------------- //
// Lists the account's Plex Home users so the dynamic-channel form offers a dropdown that
// fills plex_user/account_id/user_uuid, instead of three hand-typed fields (workstream #1,
// Bob: "Gimme a dropdown"). Best-effort: an empty list means the form falls back to the
// manual advanced inputs (so a plex.tv hiccup never blocks channel authoring).
app.get('/api/profiles', async (_req, res) => {
  try {
    res.json({ profiles: await plex.homeUsers() });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// --- content ratings (per-account facet) ------------------------------------- //
// The contentRating values actually present in a set's libraries, scoped to that set's
// ACCOUNT (a managed user sees only its allowed libraries; admin sees all). Feeds the
// rating checkboxes so each channel offers only the ratings its account can pick. Falls
// back to a small static list when Plex/plex.tv is unreachable.
const STATIC_RATINGS = [
  'TV-Y', 'TV-Y7', 'TV-Y7-FV', 'TV-G', 'G', 'TV-PG', 'PG', 'PG-13', 'TV-14', 'R', 'TV-MA', 'NC-17',
];
app.get('/api/ratings', async (req, res) => {
  const setId = String(req.query.set || '');
  // Pre-save scoping for the channel form (no set exists yet): the form passes the picked
  // profile's uuid + the currently-checked libraries so the ratings reflect that profile's
  // restricted view of those sections, matching the decision that the picker is scoped to a
  // profile's Plex-available ratings (2026-07-21-channels-function-first-generalized-members).
  const uuidQ = String(req.query.uuid || '').trim();
  const sectionsQ = String(req.query.sections || '').trim();
  try {
    let sections = [];
    let token = null;
    if (setId) {
      const s = await sets.getSet(setId);
      if (!s) return res.status(400).json({ error: 'unknown set' });
      sections = [...new Set([...(s.sections || []), ...(s.item_sections || [])])];
      if (s.user_uuid) {
        try {
          token = await plex.accountToken(s.user_uuid);
        } catch {
          token = null; // managed-token mint failed → admin token / static fallback
        }
      }
    } else if (sectionsQ) {
      sections = [...new Set(sectionsQ.split(',').map((n) => parseInt(n, 10)).filter((n) => !Number.isNaN(n)))];
      if (uuidQ) {
        try {
          token = await plex.accountToken(uuidQ);
        } catch {
          token = null;
        }
      }
    }
    let ratings = [];
    try {
      ratings = await plex.contentRatings(sections, token);
    } catch {
      ratings = [];
    }
    if (!ratings.length) ratings = STATIC_RATINGS;
    res.json({ ratings });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// --- queue items ------------------------------------------------------------- //

async function requireQueueSet(res, id) {
  const s = await sets.getSet(id);
  if (!s || s.source !== 'queue') {
    res.status(400).json({ error: 'unknown set' });
    return null;
  }
  return s;
}

// Append an entry. Body: {value} — a title string, a ratingKey, or {ratingKey,title}. With
// {type:'collection'} the entry is written as the literal "Collection: <name>" string the
// Python resolver expands into that collection's ordered children (name taken from the
// value's title, or the string itself).
app.post('/api/queues/:set/items', async (req, res) => {
  const set = req.params.set;
  if (!(await requireQueueSet(res, set))) return;
  let value = req.body && req.body.value;
  const type = req.body && req.body.type;
  const position = req.body && req.body.position === 'bottom' ? 'bottom' : 'top';
  if (type === 'collection') {
    const name = value && typeof value === 'object' ? value.title || value.name : value;
    const nm = name == null ? '' : String(name).trim();
    if (!nm) return res.status(400).json({ error: 'empty collection name' });
    value = /^collection:/i.test(nm) ? nm : `Collection: ${nm}`;
  }
  if (value == null || value === '') return res.status(400).json({ error: 'empty value' });
  try {
    res.json(await queues.addItem(set, value, position));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Remove ALL done (finished-but-kept) entries from a set's queues.yaml list. The ONLY path
// that drops done entries (never automatic) — the grid's "Remove all completed" button.
app.post('/api/queues/:set/remove-completed', async (req, res) => {
  const set = req.params.set;
  if (!(await requireQueueSet(res, set))) return;
  try {
    res.json(await queues.removeCompleted(set));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.delete('/api/queues/:set/items/:key', async (req, res) => {
  const set = req.params.set;
  if (!(await requireQueueSet(res, set))) return;
  try {
    res.json(await queues.removeItem(set, decodeURIComponent(req.params.key)));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Bulk multi-select move into `toSet`. Body: {items:[{fromSet,key}], toSet}.
app.post('/api/queues/move-bulk', async (req, res) => {
  const { items, toSet } = req.body || {};
  if (!(await requireQueueSet(res, toSet))) return;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items[] required' });
  try {
    res.json(await queues.moveBulk(items, toSet));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Bulk multi-select remove. Body: {items:[{fromSet,key}]}.
app.post('/api/queues/remove-bulk', async (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items[] required' });
  try {
    res.json(await queues.removeBulk(items));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Cross-queue move (drag a card into another queue). Body: {fromSet, toSet, key, toKeys}.
app.patch('/api/queues/move', async (req, res) => {
  const { fromSet, toSet, key, toKeys } = req.body || {};
  if (!(await requireQueueSet(res, fromSet)) || !(await requireQueueSet(res, toSet))) return;
  if (!key || !Array.isArray(toKeys)) return res.status(400).json({ error: 'key + toKeys[] required' });
  try {
    res.json(await queues.moveItem(fromSet, toSet, key, toKeys));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Set a series entry's per-show episodes-per-play. Body: {episodes}.
app.patch('/api/queues/:set/items/:key/episodes', async (req, res) => {
  const set = req.params.set;
  if (!(await requireQueueSet(res, set))) return;
  const episodes = req.body && req.body.episodes;
  try {
    res.json(await queues.setEpisodes(set, decodeURIComponent(req.params.key), episodes));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Set a series/collection entry's `batch_stops_at` override (where its batch may stop, as
// opposed to how long it is). Body: {batch_stops_at}. "none"/blank clears it = follow the set.
app.patch('/api/queues/:set/items/:key/batch-stop', async (req, res) => {
  const set = req.params.set;
  if (!(await requireQueueSet(res, set))) return;
  const value = req.body && req.body.batch_stops_at;
  try {
    res.json(await queues.setBatchStop(set, decodeURIComponent(req.params.key), value));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Set an entry's WEIGHT — how many slots it takes per round when the set is randomized.
// Body: {weight}. 1 (or anything unusable) clears the override.
app.patch('/api/queues/:set/items/:key/weight', async (req, res) => {
  const set = req.params.set;
  if (!(await requireQueueSet(res, set))) return;
  const weight = req.body && req.body.weight;
  try {
    res.json(await queues.setWeight(set, decodeURIComponent(req.params.key), weight));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// BULK-apply settings to many entries at once — the editor's selection bar. Body:
// {items: [{set, key}], episodes?, weight?, batch_stops_at?, reset?}. Only the named fields
// are touched, so "set every one of these to 3x" never disturbs their episode counts.
//
// One HTTP call rather than N: each queues.* writer takes the cross-process YAML lock and
// rewrites the file, so a 20-entry selection fired as 20 PATCHes is 20 lock acquisitions and
// 20 whole-file rewrites — and a half-applied bulk edit if one of them loses the race.
app.patch('/api/queues/bulk', async (req, res) => {
  const body = req.body || {};
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return res.status(400).json({ error: 'items[] required' });
  const wants = (k) => k in body && body[k] != null;
  const applied = [];
  const failed = [];
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
        await queues.setWeight(set, key, 1);
        await queues.setBatchStop(set, key, null);
        await queues.setStart(set, key, null);
      }
      if (wants('episodes')) await queues.setEpisodes(set, key, body.episodes);
      if (wants('weight')) await queues.setWeight(set, key, body.weight);
      if (wants('batch_stops_at')) await queues.setBatchStop(set, key, body.batch_stops_at);
      applied.push({ set, key });
    }
    await cache.bumpGeneration();
    res.json({ ok: failed.length === 0, applied: applied.length, failed });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// --- the "Start from…" editor's pickers -------------------------------------- //
// A series' playable episodes grouped by season, and a collection's members in play order.
// Both are read-only lookups the start modal fills its dropdowns from, so a start point is
// PICKED (season + real episode title) instead of typed blind into a tiny number box.
app.get('/api/show/:ratingKey/episodes', async (req, res) => {
  try {
    // `uuid` (a Plex Home profile's user_uuid) scopes the `watched` marks to that profile, so
    // a per-profile channel's start editor reflects that profile's history, not the admin's.
    // Absent (queues/members/admin) => admin token, unchanged. A mint failure degrades to admin.
    const uuidQ = String(req.query.uuid || '').trim();
    let scope = {};
    if (uuidQ) {
      try { scope = { token: await plex.accountToken(uuidQ), account: uuidQ }; } catch { scope = {}; }
    }
    const out = await plex.showEpisodes(req.params.ratingKey, scope);
    if (!out) return res.status(404).json({ error: 'no episodes' });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/collection/:ratingKey/children', async (req, res) => {
  try {
    const children = await plex.collectionChildren(req.params.ratingKey);
    if (!children) return res.status(404).json({ error: 'no collection' });
    res.json({ children });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Set/clear an entry's manual START point. Body: {start: {season, episode}} for a show,
// {start: {series, season?, episode?}} for a collection (which member to begin at), or
// {start: null} to revert to automatic next-unwatched.
app.patch('/api/queues/:set/items/:key/start', async (req, res) => {
  const set = req.params.set;
  if (!(await requireQueueSet(res, set))) return;
  const start = req.body ? req.body.start : null;
  try {
    res.json(await queues.setStart(set, decodeURIComponent(req.params.key), start));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.patch('/api/queues/:set/order', async (req, res) => {
  const set = req.params.set;
  if (!(await requireQueueSet(res, set))) return;
  const keys = req.body && req.body.keys;
  if (!Array.isArray(keys)) return res.status(400).json({ error: 'keys[] required' });
  try {
    res.json(await queues.reorder(set, keys));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// --- playback + channels (via the MQTT bridge) ------------------------------- //

// The "Play on ▾" dropdown — the Python service's retained device registry.
app.get('/api/devices', (_req, res) => {
  if (!mqttc.connected()) return res.status(503).json({ error: 'MQTT not connected', devices: [] });
  res.json({ devices: mqttc.devices() });
});

// Start a queue/channel on a device. Body: {set, kind?, target?}. kind normally comes
// from the registry; the two overrides mirror the physical cards: set='auto' lets the
// Shield's signed-in profile pick the tier, and kind='movie' on a rotation set plays
// that tier's Movies channel (weighted rewatch) instead of the shows rotation.
app.post('/api/play', async (req, res) => {
  const { set: setId, kind: kindReq, target, profile, only } = req.body || {};
  const tgt = target ? String(target) : undefined;
  // PR 4: an explicit profile names the binding on a profiles[] function channel (the
  // Play-landing profile selector); the auto path keeps letting the Shield decide.
  const prof = profile ? String(profile) : undefined;
  // The grid's per-tile ▶: play ONE entry of a curated set. Only a curated set has entries
  // to name, so asking for one on a rotation channel is a request error rather than a
  // silently-ignored field — a rotation's pool is a rule, and nothing in it has a key.
  const entryKey = only ? String(only) : undefined;
  try {
    if (setId === 'auto') {
      if (entryKey) return res.status(400).json({ error: 'set "auto" cannot play a single entry' });
      return res.json({ sent: mqttc.play('auto', kindReq === 'movie' ? 'movie' : 'cartoons', tgt) });
    }
    const s = await sets.getSet(String(setId || ''));
    if (!s) return res.status(400).json({ error: 'unknown set' });
    if (entryKey && s.source !== 'queue') {
      return res.status(400).json({ error: `'${s.label || s.id}' is a rule-based channel — it has no entries to play one of` });
    }
    const kind = s.source === 'rotation'
      ? (kindReq === 'movie' ? 'movie' : 'cartoons')
      : s.kind === 'anime' ? 'anime' : 'movie';
    res.json({ sent: mqttc.play(s.id, kind, tgt, prof, entryKey) });
  } catch (e) {
    res.status(503).json({ error: String(e.message || e) });
  }
});

// --- App Connectors ----------------------------------------------------------- //
// The provider surface. Definitions are plaintext and freely readable; TOKENS ARE
// WRITE-ONLY — there is no route that returns one, and `configured` is a boolean rather
// than a masked prefix, because a masked token is still a leak when the secret is short.

app.get('/api/providers', (_req, res) => {
  res.json({ providers: providers.publicList() });
});

// Set or replace one provider's token. Write-only by design.
app.post('/api/providers/:id/token', async (req, res) => {
  const token = (req.body || {}).token;
  if (typeof token !== 'string' || !token.trim()) {
    return res.status(400).json({ error: 'a non-empty token is required' });
  }
  try {
    const def = providers.definitionFor(String(req.params.id));
    if (!def) return res.status(404).json({ error: 'unknown provider' });
    await providers.writeSecret(def.id, token.trim());
    // Echo the PUBLIC view only. Never the token, not even the one just supplied.
    return res.json({ ok: true, provider: providers.publicView(def) });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

app.delete('/api/providers/:id/token', async (req, res) => {
  try {
    const def = providers.definitionFor(String(req.params.id));
    if (!def) return res.status(404).json({ error: 'unknown provider' });
    await providers.deleteSecret(def.id);
    return res.json({ ok: true, provider: providers.publicView(def) });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// The libraries a provider offers, for the queue editor's provider block. Plex keeps its own
// long-standing routes; this is the provider-scoped one a non-Plex block needs.
app.get('/api/providers/:id/libraries', async (req, res) => {
  try {
    const p = providerFor(String(req.params.id));
    if (typeof p.libraries !== 'function') {
      return res.json({ libraries: [], note: `${p.label} does not enumerate libraries here` });
    }
    return res.json({ libraries: await p.libraries() });
  } catch (e) {
    return res.status(503).json({ error: String(e.message || e) });
  }
});

// Provider-scoped series search — the non-Plex half of /api/search. Scoped to the libraries
// the queue draws from, so it never offers something that queue could not play.
app.get('/api/providers/:id/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  try {
    const p = providerFor(String(req.params.id));
    if (typeof p.search !== 'function') return res.json({ results: [] });
    const libraries = String(req.query.libraries || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    return res.json({ results: await p.search(q, { libraries }) });
  } catch (e) {
    return res.status(503).json({ error: String(e.message || e) });
  }
});

// Cover proxy. The Kavita image endpoint REQUIRES the API key as a query parameter, so the
// browser must never be handed one of its URLs — that would put a live credential in the
// page source, the network tab and any screenshot (the hazard docs/kavita-feasibility.md
// flags about /api/opds/<apiKey>). The key stays here; the browser gets bytes. Same shape as
// /api/thumb for Plex.
app.get('/api/providers/:id/cover/:itemId', async (req, res) => {
  try {
    const p = providerFor(String(req.params.id));
    if (typeof p.cover !== 'function') return res.status(404).end();
    const { buffer, contentType } = await p.cover(String(req.params.itemId));
    res.setHeader('Content-Type', contentType);
    // Covers change only when the series art does; a day is the same bet /api/thumb makes.
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.end(buffer);
  } catch {
    // A missing cover is normal (a series with no art). 404 rather than 500 so the tile
    // falls back to its placeholder instead of logging an error per render.
    return res.status(404).end();
  }
});

// Last session state (retained plex-channels/state) — the play-result toast's source.
app.get('/api/state', (_req, res) => {
  res.json({ state: mqttc.lastState(), mqtt: mqttc.connected() });
});

// --- live now-playing -------------------------------------------------------- //
// Attach the parent series/collection to the raw HA payload so the UI can match a playing
// episode to its SERIES tile. Only worth resolving while something is actually on screen.
let LAST_NOW = null; // withContext()-enriched, kept fresh by the onNowPlaying subscription
async function withContext(now) {
  if (!now || !now.ratingKey) return now || null;
  if (now.state !== 'playing' && now.state !== 'paused') return { ...now, context: null };
  return { ...now, context: await plex.playingContext(now.ratingKey) };
}

// Which queue is live, and what's on screen. `set` comes from the session state (the queue
// we STARTED) — authoritative for "which queue is active" in a way the Plex-side payload
// can't be, since Plex has no idea our queues exist.
app.get('/api/now', async (_req, res) => {
  // A retained payload can land before the first fetch, so fall back to resolving it here.
  const now = LAST_NOW || (await withContext(mqttc.lastNowPlaying()));
  const st = mqttc.lastState() || {};
  res.json({ now, set: st.set || null, kind: st.kind || null, mqtt: mqttc.connected() });
});

// Channels view: a rotation set's eligible pool, computed in-process by the engine.
app.get('/api/generic/:id/preview', async (req, res) => {
  try {
    const s = await sets.getSet(req.params.id);
    if (!s || s.source !== 'rotation') return res.status(400).json({ error: 'not a rotation channel' });

    // A PULL channel's pool is its provider's, not the Plex engine's. Without this the
    // Channels view renders "Empty" for a reading channel that in fact has a full lineup —
    // previewRotation walks Plex sections, and a Kavita channel has none.
    if (s.delivery === 'pull') {
      const block = providerBlocks.resolveSingle(s);
      const p = providerFor(block.provider);
      const pool = await p.pool({ libraries: block.libraries, members: (s.members || []).map(String) });
      // Returned as `buckets`, the SAME key and shape the Plex preview uses, so the Channels
      // grid renders a reading pool with no second code path. See kavita.js pool().
      return res.json({
        id: s.id,
        label: s.label,
        provider: block.provider,
        delivery: 'pull',
        buckets: pool,
      });
    }

    const profile = req.query.profile ? String(req.query.profile) : '';
    const node = await enginePreview.previewRotation(s.id, profile);
    try {
      node.routing = engineRouting.forSet(s.id, profile);
    } catch (e) {
      console.log(`[engine] routing preview failed for ${s.id}: ${e.message}`);
    }
    res.json(node);
  } catch (e) {
    res.status(503).json({ error: String(e.message || e) });
  }
});

// --- live updates (SSE) ------------------------------------------------------ //
// The UI re-fetches whenever the data actually changes — a web edit from another tab,
// the Python prune after a scan, or a hand-edit over SMB. Watch the DIRECTORY (the
// atomic rename-replace writes would orphan a file watch) and debounce bursts.
const sseClients = new Set();

export function broadcast(type, data = {}) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(msg);
  // A `data` event means the config changed (edit, prune, SMB hand-edit) — warm the cache so
  // the next load is hot. Debounced inside warm.kick(), so an edit burst coalesces.
  if (type === 'data') warm.kick();
}

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('event: hello\ndata: {}\n\n');
  sseClients.add(res);
  // Re-sync on (re)connect: a phone that slept its tab dropped this SSE stream and missed
  // every `now` published while it was gone, so it would show the stale page-load value until
  // a manual refresh. Replay the CURRENT retained now-playing snapshot to JUST this client —
  // same `{ now, set }` shape the live onNowPlaying/onState broadcasts use — so a resumed tab
  // reconciles the playing tile + active-queue badge without waiting for the next MQTT change.
  // (The `state` event only drives play-result toasts, so it is deliberately NOT replayed here
  // — re-toasting an old result on every wake would be noise; the tile hydrates from `now`.)
  res.write(`event: now\ndata: ${JSON.stringify({ now: LAST_NOW, set: (mqttc.lastState() || {}).set || null })}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000); // keep proxies from idling us out
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
});

{
  let timer = null;
  const byDir = new Map(); // dir -> Set of filenames we care about (paths may share a dir)
  for (const p of [QUEUES_PATH, sets.SETS_PATH]) {
    const d = path.dirname(p);
    if (!byDir.has(d)) byDir.set(d, new Set());
    byDir.get(d).add(path.basename(p));
  }
  for (const [dir, names] of byDir) {
    try {
      watch(dir, (_ev, filename) => {
        if (filename && !names.has(filename)) return;
        clearTimeout(timer);
        timer = setTimeout(() => broadcast('data'), 300);
      });
    } catch (e) {
      console.log(`[sse] watch unavailable for ${dir} (${e.message}) — UI updates on its own actions only`);
    }
  }
}

// Session state changes (a play result landing) push to the UI the same way.
mqttc.onState((state) => {
  broadcast('state', state || {});
  // The active-queue badge keys off state.set, so a new session must repaint it even when
  // the Plex-side payload hasn't changed yet.
  broadcast('now', { now: LAST_NOW, set: (state || {}).set || null });
});

// Live playback pushes the same way — every state/attribute change on the Shield's
// media_player, so the highlight follows the queue as it auto-advances.
mqttc.onNowPlaying(async (now) => {
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
    const st = LAST_NOW && (LAST_NOW.state === 'playing' || LAST_NOW.state === 'stopped' || LAST_NOW.state === 'paused');
    if (showRk && st) {
      await cache.dropLeaves(showRk);
      await cache.bumpGeneration();
    }
  } catch {
    /* cache is best-effort */
  }
  broadcast('now', { now: LAST_NOW, set: (mqttc.lastState() || {}).set || null });
});

// Minimal metadata for one ratingKey — the blocklist chips need display titles.
app.get('/api/item/:ratingKey', async (req, res) => {
  try {
    const md = await plex.resolveValue([], { ratingKey: req.params.ratingKey });
    if (!md) return res.status(404).json({ error: 'not found' });
    res.json(md);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Poster proxy — the Plex token stays server-side, never handed to the browser.
app.get('/api/thumb/:ratingKey', async (req, res) => {
  try {
    const t = await plex.thumb(req.params.ratingKey);
    if (!t) return res.status(404).end();
    res.set('Content-Type', t.contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.end(t.buffer);
  } catch {
    res.status(502).end();
  }
});

// The per-queue launcher: GET /go/<setId> rebuilds a pull provider's runtime artifact and
// 302s into it. Deliberately NOT under /api — it is a URL a person bookmarks or puts on a
// home screen, so it stays short and stable, and it is exempt from the /api mutation
// snapshot above (it writes no config).
mountLauncher(app);

// Open the derived Plex cache (decision 2026-08-03-sqlite-is-a-derived-plex-cache) before
// listening. A failure here disables caching but never blocks the server — every reader in
// cache.js degrades to a miss.
await cache.init();

app.listen(WEB_PORT, () => {
  console.log(`[queuepilot-web] listening on :${WEB_PORT}`);
  mqttd.start();
  warm.start();
});
