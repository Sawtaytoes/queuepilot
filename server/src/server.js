// plex-channels-web: the browser editor for the curated queues (queues.yaml) and the
// set registry (sets.yaml). Runs beside the Python plex-channels-queue MQTT service in
// one container. Read-only against Plex (search + poster proxy); its writes go to
// queues.yaml (coordinated with the Python prune via the cross-process lock in
// queues.js) and sets.yaml (which the Python service re-reads before every command).
import express from 'express';
import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WEB_PORT, QUEUES_PATH } from './config.js';
import * as history from './history.js';
import * as mqttc from './mqttc.js';
import * as plex from './plex.js';
import * as queues from './queues.js';
import * as sets from './sets.js';

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
app.use(express.static(PUBLIC_DIR));

// Every data mutation snapshots the files first → the undo/redo stack. /api/play only
// publishes MQTT and /api/undo|redo manage the stack themselves.
app.use('/api', async (req, _res, next) => {
  const mutating = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method);
  const managed = ['/play', '/undo', '/redo'].some((p) => req.path === p || req.path.startsWith(p + '/'));
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

// Every queue in registry order, each curated entry resolved (poster + type) for
// rendering. Rotation channels appear with their metadata but no items — their lineup is
// computed, not stored (the Channels view previews it separately).
app.get('/api/queues', async (_req, res) => {
  try {
    const reg = await sets.getRegistry();
    const result = {};
    for (const s of reg.sets) {
      const base = {
        label: s.label,
        kind: s.kind,
        source: s.source,
        sections: s.sections,
        items: [],
      };
      result[s.id] = base;
      if (s.source !== 'queue') continue;
      const entries = await queues.listSet(s.id);
      base.items = await mapLimit(entries, 6, async (e) => {
        let resolved = null;
        try {
          resolved = await plex.resolveValue(s.sections, e.value);
        } catch {
          /* leave unresolved */
        }
        // For a series, surface the next unwatched episode (queue plays it TV-style,
        // staying until the whole show is watched). For a Collection, surface its first
        // still-unwatched member (the show/movie that plays next in collection order) so
        // the tile shows a concrete "Next: <member>" instead of an opaque "N in order".
        // A manual start override {season, episode} on the entry floors the next-up pick.
        const start =
          e.value && typeof e.value === 'object' && e.value.start ? e.value.start : null;
        let nextEp = null;
        if (resolved && resolved.type === 'show') {
          try {
            nextEp = await plex.nextEpisode(resolved.ratingKey, start);
          } catch {
            /* ignore */
          }
        } else if (resolved && resolved.type === 'collection') {
          try {
            // A collection's start override names {series, season, episode} — the member to
            // begin at plus the floor inside it.
            nextEp = await plex.collectionNext(resolved.ratingKey, start);
          } catch {
            /* ignore — the tile falls back to the childCount "N in order" label */
          }
        }
        const episodes =
          e.value && typeof e.value === 'object' && e.value.episodes ? e.value.episodes : 1;
        return {
          key: e.key,
          raw: displayFor(e.value),
          resolved: Boolean(resolved),
          ratingKey: resolved ? resolved.ratingKey : null,
          type: resolved ? resolved.type : null,
          title: resolved ? resolved.title : displayFor(e.value),
          year: resolved ? resolved.year : null,
          // For a Collection entry: how many items it expands to (shown on the tile).
          childCount: resolved && resolved.type === 'collection' ? resolved.childCount : null,
          nextEp,
          episodes,
          // The manual start override (null = automatic next-unwatched).
          start,
          // A finished-but-kept entry (Python tagged it done); the grid greys it and the
          // "Remove all completed" button targets these. False for every plain entry.
          done: Boolean(e.done),
        };
      });
    }
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
    mqttc.invalidatePreview(req.params.id); // a filter change moves the channel's pool
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
    const members = await mapLimit(s.members || [], 6, async (value, index) => {
      // A hand-written {collection: <name>} mapping resolves like its string spelling.
      const v = value && typeof value === 'object' && value.collection && value.ratingKey == null
        ? `Collection: ${value.collection}`
        : value;
      let resolved = null;
      try {
        resolved = await plex.resolveValue(sections, v);
      } catch {
        /* leave unresolved */
      }
      const start = value && typeof value === 'object' && value.start ? value.start : null;
      let nextEp = null;
      if (resolved && resolved.type === 'show') {
        try {
          nextEp = await plex.nextEpisode(resolved.ratingKey, start);
        } catch {
          /* ignore */
        }
      } else if (resolved && resolved.type === 'collection') {
        // Same next-up member as the queue grid, so a member tile and a queue tile of the
        // same collection read identically (member poster + title, collection as the badge).
        try {
          nextEp = await plex.collectionNext(resolved.ratingKey, start);
        } catch {
          /* ignore — the tile falls back to the childCount "N in order" label */
        }
      }
      return {
        index,
        raw: value,
        resolved: Boolean(resolved),
        ratingKey: resolved ? resolved.ratingKey : null,
        type: resolved ? resolved.type : null,
        title: resolved ? resolved.title : displayFor(v),
        year: resolved ? resolved.year : null,
        childCount: resolved && resolved.type === 'collection' ? resolved.childCount : null,
        nextEp,
        start,
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

// --- the "Start from…" editor's pickers -------------------------------------- //
// A series' playable episodes grouped by season, and a collection's members in play order.
// Both are read-only lookups the start modal fills its dropdowns from, so a start point is
// PICKED (season + real episode title) instead of typed blind into a tiny number box.
app.get('/api/show/:ratingKey/episodes', async (req, res) => {
  try {
    const out = await plex.showEpisodes(req.params.ratingKey);
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
  const { set: setId, kind: kindReq, target, profile } = req.body || {};
  const tgt = target ? String(target) : undefined;
  // PR 4: an explicit profile names the binding on a profiles[] function channel (the
  // Play-landing profile selector); the auto path keeps letting the Shield decide.
  const prof = profile ? String(profile) : undefined;
  try {
    if (setId === 'auto') {
      return res.json({ sent: mqttc.play('auto', kindReq === 'movie' ? 'movie' : 'cartoons', tgt) });
    }
    const s = await sets.getSet(String(setId || ''));
    if (!s) return res.status(400).json({ error: 'unknown set' });
    const kind = s.source === 'rotation'
      ? (kindReq === 'movie' ? 'movie' : 'cartoons')
      : s.kind === 'anime' ? 'anime' : 'movie';
    res.json({ sent: mqttc.play(s.id, kind, tgt, prof) });
  } catch (e) {
    res.status(503).json({ error: String(e.message || e) });
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

// Channels view: a rotation set's eligible pool (request/response to the Python service).
app.get('/api/generic/:id/preview', async (req, res) => {
  try {
    const s = await sets.getSet(req.params.id);
    if (!s || s.source !== 'rotation') return res.status(400).json({ error: 'not a rotation channel' });
    const data = await mqttc.preview(s.id, {
      fresh: req.query.fresh === '1',
      profile: req.query.profile ? String(req.query.profile) : '',
    });
    res.json(data);
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
}

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('event: hello\ndata: {}\n\n');
  sseClients.add(res);
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

app.listen(WEB_PORT, () => {
  console.log(`[plex-channels-web] listening on :${WEB_PORT}`);
});
