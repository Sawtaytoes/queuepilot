// Read-only Plex client for the queue editor: title search, title→item resolution,
// and poster proxying. Deliberately mirrors queue_builder/plex.py's resolver so the UI
// shows exactly what the Python service will resolve at scan time.
//
// TLS: Plex presents a self-signed cert. The container sets NODE_TLS_REJECT_UNAUTHORIZED=0
// for this process (see entrypoint), the Node equivalent of the Python client's CERT_NONE.
import { PLEX_URL, PLEX_TOKEN, PLEX_CLIENT_IDENTIFIER } from './config.js';

// `token` overrides the admin PLEX_TOKEN — used for per-account (managed-user) queries so
// the section listing/facets reflect THAT account's restricted library view (workstream D).
async function plexGet(path, token = null) {
  const res = await fetch(PLEX_URL + path, {
    headers: { 'X-Plex-Token': token || PLEX_TOKEN, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`plex ${res.status} for ${path}`);
  return res.json();
}

function container(json) {
  return (json && json.MediaContainer) || {};
}

// --- per-account (managed-user) tokens (mirrors queue_builder/plex.py account_token) --- //
// The raw plex.tv switch token 401s against the LOCAL server; the per-server accessToken
// from /api/v2/resources does not. Minting it lets a facet query see exactly that account's
// restricted library. Cached per uuid. Best-effort — any failure returns null (caller uses
// the admin token / static fallback), so the API degrades cleanly with plex.tv unreachable.
const _accountTokens = new Map(); // user_uuid -> server-scoped access token (or null)

async function plextv(path, token, method = 'GET') {
  const res = await fetch('https://plex.tv' + path, {
    method,
    headers: {
      'X-Plex-Token': token,
      'X-Plex-Client-Identifier': PLEX_CLIENT_IDENTIFIER,
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`plex.tv ${res.status} for ${path}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function machineIdentifier() {
  return container(await plexGet('/')).machineIdentifier || '';
}

export async function accountToken(userUuid) {
  if (!userUuid) return null; // no managed user => admin PLEX_TOKEN (Bob)
  if (_accountTokens.has(userUuid)) return _accountTokens.get(userUuid);
  let token = null;
  try {
    const sw = await plextv(`/api/v2/home/users/${userUuid}/switch`, PLEX_TOKEN, 'POST');
    const auth = sw && sw.authToken;
    if (auth) {
      const resources = await plextv('/api/v2/resources?includeHttps=1', auth);
      const rows = Array.isArray(resources) ? resources : resources.resources || [];
      const mid = await machineIdentifier();
      const row = rows.find((r) => r.clientIdentifier === mid);
      token = (row && row.accessToken) || null;
    }
  } catch {
    token = null; // network/plex.tv hiccup: fall back to admin token
  }
  _accountTokens.set(userUuid, token);
  return token;
}

// --- Plex Home users (managed profiles) — the channel form's profile dropdown ---------- //
// Lists the admin account's Plex Home users so the dynamic-channel form can offer a DROPDOWN
// instead of three hand-typed fields (Bob: "Gimme a dropdown. You should have all profiles
// on my account."). GET plex.tv /api/v2/home/users with the admin token → the same
// name/id/uuid the set binding needs (plex_user/account_id/user_uuid). For a MANAGED user the
// plex.tv home-user `id` equals the local server accountID (verified: Younger Kids = 11111111
// on both), so it maps 1:1 onto `account_id`; the admin's plex.tv id differs from the server's
// admin accountID (1), so the admin row is flagged `admin` and the form fills account_id=1 for
// it. Best-effort: any failure returns [] and the form falls back to the manual advanced fields.
export async function homeUsers() {
  let data;
  try {
    data = await plextv('/api/v2/home/users', PLEX_TOKEN);
  } catch {
    return [];
  }
  const rows = Array.isArray(data) ? data : data.users || [];
  return rows
    .map((u) => ({
      name: u.title || u.username || u.friendlyName || '',
      // Managed users: plex.tv id == server accountID. Admin: server accountID is 1.
      id: u.admin ? 1 : u.id != null ? Number(u.id) : null,
      uuid: u.admin ? null : u.uuid || null, // admin => no managed-user uuid (admin PLEX_TOKEN)
      admin: Boolean(u.admin),
      restricted: Boolean(u.restricted),
    }))
    .filter((u) => u.name);
}

// --- content-rating facet present in a set's sections, scoped to an account token ------- //
// Union of the distinct `contentRating` values across `sections`. With a managed-user token
// the section listing is already that account's restricted view, so the facet reflects only
// the ratings that account can actually see (the per-account list workstream D wants). Reads
// the lightweight filter-values endpoint (`/library/sections/<id>/contentRating`) and falls
// back to grouping `all?group=contentRating` if the former isn't served. Best-effort per
// section; a section that errors is skipped.
export async function contentRatings(sections, token = null) {
  const out = new Set();
  for (const section of [].concat(sections)) {
    let dirs = [];
    try {
      dirs = container(await plexGet(`/library/sections/${section}/contentRating`, token)).Directory || [];
    } catch {
      dirs = [];
    }
    if (!dirs.length) {
      // Fallback: the grouped listing surfaces the same facet values (title = the rating).
      try {
        const mc = container(await plexGet(`/library/sections/${section}/all?group=contentRating&X-Plex-Container-Size=0`, token));
        dirs = mc.Directory || mc.Metadata || [];
      } catch {
        dirs = [];
      }
    }
    for (const d of dirs) {
      const v = d.title || d.key || d.contentRating;
      if (v == null) continue;
      const s = String(v).trim();
      if (s && s.toLowerCase() !== 'unrated' && s.toLowerCase() !== 'none') out.add(s);
    }
  }
  return [...out];
}

// --- title-string parsing (matches queues.parse_title_string) ---------------- //
export function parseTitleString(text) {
  let s = String(text).trim();
  let guid = null;
  let m = s.match(/\s*\[([^\]]+)\]\s*$/);
  if (m) {
    guid = m[1].trim();
    s = s.slice(0, m.index).trimEnd();
  }
  let year = null;
  m = s.match(/\s*\((\d{4})\)\s*$/);
  if (m) {
    year = parseInt(m[1], 10);
    s = s.slice(0, m.index).trimEnd();
  }
  return { title: s.trim(), year, guid };
}

// `source-id` folder hint (anidb-16172) → Plex Guid id (anidb://16172). Best-effort.
function matchGuidHint(hint, guids) {
  if (!hint) return false;
  const i = hint.indexOf('-');
  if (i <= 0) return false;
  const want = `${hint.slice(0, i)}://${hint.slice(i + 1)}`.toLowerCase();
  return guids.some((g) => (g || '').toLowerCase() === want);
}

function posterFields(md) {
  return {
    ratingKey: String(md.ratingKey),
    type: md.type,
    title: md.title,
    year: md.year ?? null,
    sectionId: md.librarySectionID != null ? Number(md.librarySectionID) : null,
    hasThumb: Boolean(md.thumb),
  };
}

// All library sections, video-flagged (movie/show only are ever queueable). Feeds the
// per-queue library picker + the global-exclude editor.
export async function sections() {
  const mc = container(await plexGet('/library/sections'));
  return (mc.Directory || []).map((d) => ({
    id: Number(d.key),
    title: d.title,
    type: d.type,
    video: d.type === 'movie' || d.type === 'show',
    // Plex "Other Videos" libraries (Personal Media, no metadata agent) — the UI groups
    // these apart from real Movie libraries, matching Plex's own library styles.
    other: d.type === 'movie' && d.agent === 'com.plexapp.agents.none',
  }));
}

// --- search within a set's section(s) (title filter) ------------------------- //
export async function search(sections, query) {
  const q = encodeURIComponent(query);
  const out = [];
  const seen = new Set();
  for (const section of [].concat(sections)) {
    let json;
    try {
      json = await plexGet(
        `/library/sections/${section}/all?title=${q}&includeGuids=1&X-Plex-Container-Size=50`,
      );
    } catch {
      continue;
    }
    for (const e of container(json).Metadata || []) {
      if (e.type !== 'movie' && e.type !== 'show') continue;
      const rk = String(e.ratingKey);
      if (seen.has(rk)) continue;
      seen.add(rk);
      // The section is authoritative from the query itself (per-item librarySectionID is
      // not reliably present on section listings) — it drives "which queues can take this".
      // Every real item carries a `type` ('movie'|'show') from posterFields — the frontend
      // switches its result row on it (vs. the 'collection' rows below).
      out.push({ ...posterFields(e), sectionId: Number(section) });
    }
  }
  return out;
}

// --- Plex Collections (type=18) within a set's section(s) -------------------- //
// Collections are their own listing (`/library/sections/<id>/collections`), not part of the
// `all?title=` search, so they're fetched separately and title-filtered client-side (the
// collections endpoint doesn't reliably honor `?title=`). Each result is tagged
// {type:'collection', ...} so the add flow writes it as the literal "Collection: <name>"
// entry the Python resolver expands. Collections per library are few, so this stays cheap.
export async function collections(sections, query) {
  const ql = String(query || '').trim().toLowerCase();
  const out = [];
  const seen = new Set();
  for (const section of [].concat(sections)) {
    let json;
    try {
      json = await plexGet(`/library/sections/${section}/collections?X-Plex-Container-Size=500`);
    } catch {
      continue;
    }
    for (const e of container(json).Metadata || []) {
      if (e.type !== 'collection') continue;
      if (ql && !String(e.title || '').toLowerCase().includes(ql)) continue;
      const rk = String(e.ratingKey);
      if (seen.has(rk)) continue;
      seen.add(rk);
      out.push({
        type: 'collection',
        ratingKey: rk,
        title: e.title,
        sectionId: Number(section),
        childCount: e.childCount != null ? Number(e.childCount) : null,
        hasThumb: Boolean(e.thumb),
      });
    }
  }
  return out;
}

// Resolve a "Collection: <name>" queue entry to its collection (type=18), for DISPLAY —
// mirrors the Python resolver so the grid tile shows the collection (poster + item count)
// instead of flagging it "Not in library". Exact title match wins, else the first hit.
export async function resolveCollection(sections, name) {
  const list = await collections(sections, name);
  if (!list.length) return null;
  const nl = String(name).trim().toLowerCase();
  const c = list.find((x) => String(x.title).trim().toLowerCase() === nl) || list[0];
  return {
    type: 'collection',
    ratingKey: c.ratingKey,
    title: c.title,
    childCount: c.childCount,
    hasThumb: c.hasThumb,
  };
}

// --- resolve one parsed title to a section item (mirrors plex._resolve_title) - //
const _titleCache = new Map(); // `${section}|${title}|${year}|${guid}` -> item|null(never cached null)

export async function resolveTitle(section, title, year = null, guid = null) {
  const ck = `${section}|${title.toLowerCase()}|${year}|${(guid || '').toLowerCase()}`;
  if (_titleCache.has(ck)) return _titleCache.get(ck);
  let mc;
  try {
    mc = container(
      await plexGet(
        `/library/sections/${section}/all?title=${encodeURIComponent(title)}&includeGuids=1&X-Plex-Container-Size=50`,
      ),
    );
  } catch {
    return null;
  }
  const tl = title.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const e of mc.Metadata || []) {
    if (e.type !== 'movie' && e.type !== 'show') continue;
    const candTitle = (e.title || '').toLowerCase();
    const guids = (e.Guid || []).map((g) => g.id);
    let score = 0;
    if (guid && matchGuidHint(guid, guids)) score += 100;
    if (year != null && e.year === year) score += 10;
    else if (year != null && e.year != null && e.year !== year) score -= 5;
    if (candTitle === tl) score += 5;
    else if (candTitle.startsWith(tl)) score += 1;
    const rk = String(e.ratingKey);
    const better =
      best === null ||
      score > bestScore ||
      (score === bestScore && /^\d+$/.test(rk) && parseInt(rk, 10) < parseInt(best.ratingKey, 10));
    if (better) {
      best = posterFields(e);
      bestScore = score;
    }
  }
  if (best === null || bestScore <= 0) return null;
  _titleCache.set(ck, best);
  return best;
}

// --- resolve a raw queue value (ratingKey | title | {ratingKey,title}) -------- //
// `sections` is the set's section list; a title is tried in each (first hit wins), a
// ratingKey resolves globally via metadata.
export async function resolveValue(sections, value) {
  // ratingKey (scalar number/numeric-string, or a mapping carrying one)
  let ratingKey = null;
  let titleText = null;
  if (value && typeof value === 'object') {
    if (value.ratingKey != null) ratingKey = String(value.ratingKey);
    if (value.title) titleText = String(value.title);
  } else if (typeof value === 'number' || /^\d+$/.test(String(value).trim())) {
    ratingKey = String(value).trim();
  } else {
    titleText = String(value);
  }
  if (ratingKey) {
    try {
      const md = (container(await plexGet(`/library/metadata/${ratingKey}`)).Metadata || [])[0];
      if (md && (md.type === 'movie' || md.type === 'show')) return posterFields(md);
    } catch {
      /* dead id */
    }
    return null;
  }
  if (!titleText) return null;
  const collMatch = /^\s*collection:\s*(.+)$/i.exec(titleText);
  if (collMatch) return resolveCollection(sections, collMatch[1]);
  const { title, year, guid } = parseTitleString(titleText);
  if (!title) return null;
  for (const section of [].concat(sections)) {
    const hit = await resolveTitle(section, title, year, guid);
    if (hit) return hit;
  }
  return null;
}

// A manual START floor {season, episode}: `e` is at-or-after it (so it's eligible to play).
// Earlier episodes are skipped from the pick but never marked watched. No start => always.
// Season defaults to 1 (single-season anime stores the sole season).
function atOrAfterStart(e, start) {
  if (!start) return true;
  const es = Number(e.parentIndex) || 0;
  const ee = Number(e.index) || 0;
  const ss = Number(start.season) || 1;
  const se = Number(start.episode) || 1;
  return es > ss || (es === ss && ee >= se);
}

// --- next unwatched episode for a series (queue sets run as admin/Bob, so allLeaves'
// viewCount IS Bob's watched state — no history API needed). Skips Season 0 specials and
// zero-duration items, matching the Python _keep_episode rule. null = fully watched.
// `start` (optional {season, episode}) floors the pick — the tile shows where a manual
// start override will actually begin, mirroring the engine's resolve_member floor.
export async function nextEpisode(showRatingKey, start = null) {
  let mc;
  try {
    mc = container(await plexGet(`/library/metadata/${showRatingKey}/allLeaves`));
  } catch {
    return null;
  }
  const eps = mc.Metadata || [];
  // A single-season show (every anime — Japan doesn't do American-style seasons) hides its
  // "S1", so the tile shows just "E5". Count DISTINCT real seasons (S0 specials don't count).
  const seasons = new Set();
  for (const e of eps) {
    if (String(e.parentIndex) === '0' || !e.duration) continue;
    if (e.parentIndex != null) seasons.add(String(e.parentIndex));
  }
  const multiSeason = seasons.size > 1;
  for (const e of eps) {
    if (String(e.parentIndex) === '0') continue; // a series never opens on a special
    if (!e.duration) continue;
    if (e.viewCount && e.viewCount > 0) continue; // already watched by Bob
    if (!atOrAfterStart(e, start)) continue; // manual start floor
    return { season: e.parentIndex ?? null, episode: e.index ?? null, title: e.title || '', multiSeason };
  }
  return null;
}

// --- ordered children of a Collection (shared by collectionNext + the start editor) --- //
// `/library/collections/<rk>/children` returns them in the collection's own order
// (collectionSort), so no client-side re-sort is needed.
export async function collectionChildren(collectionRatingKey) {
  let mc;
  try {
    mc = container(await plexGet(`/library/collections/${collectionRatingKey}/children`));
  } catch {
    return null;
  }
  // NOTE a SHOW's `viewCount` is its number of watched episodes, not a boolean — only a
  // movie/standalone child is "watched" by viewCount. A show reports progress instead
  // (viewedLeafCount/leafCount), which the start editor shows as "12/14 watched".
  return (mc.Metadata || []).map((ch) => ({
    ratingKey: String(ch.ratingKey),
    type: ch.type,
    title: ch.title || '',
    year: ch.year ?? null,
    watched: ch.type !== 'show' && Boolean(ch.viewCount && ch.viewCount > 0),
    viewedLeafCount: ch.type === 'show' && ch.viewedLeafCount != null ? Number(ch.viewedLeafCount) : null,
    leafCount: ch.type === 'show' && ch.leafCount != null ? Number(ch.leafCount) : null,
  }));
}

// A start floor for a COLLECTION entry: {series, season, episode} — `series` names the member
// to begin at (its ratingKey, or its title for a hand-written YAML entry). Members BEFORE it
// in collection order are skipped entirely. Returns the index of that member, or -1.
function startMemberIndex(children, start) {
  if (!start || start.series == null) return -1;
  const want = String(start.series).trim().toLowerCase();
  return children.findIndex(
    (ch) => String(ch.ratingKey) === want || ch.title.trim().toLowerCase() === want,
  );
}

// --- every playable episode of a series, grouped by season -------------------- //
// Feeds the "Start from…" editor, which picks a real episode by name instead of asking for a
// number typed blind. Same filters the engine plays by (`_keep_episode`): Season 0 specials
// and zero-duration items never appear, because a start can never land on one. `watched` is
// Bob's admin view state, so the editor can mark what's already seen.
export async function showEpisodes(showRatingKey) {
  let mc;
  try {
    mc = container(await plexGet(`/library/metadata/${showRatingKey}/allLeaves`));
  } catch {
    return null;
  }
  const seasons = new Map(); // season number -> [{episode, title, watched}]
  for (const e of mc.Metadata || []) {
    if (String(e.parentIndex) === '0' || !e.duration) continue;
    const s = Number(e.parentIndex ?? 1);
    if (!seasons.has(s)) seasons.set(s, []);
    seasons.get(s).push({
      episode: e.index ?? null,
      title: e.title || '',
      watched: Boolean(e.viewCount && e.viewCount > 0),
    });
  }
  const out = [...seasons.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([season, episodes]) => ({ season, episodes }));
  return { multiSeason: out.length > 1, seasons: out };
}

// --- next-up member of a Collection (mirrors queue_builder collection_items) --- //
// A Collection tile plays its members in collection order, each member's unwatched episodes
// back-to-back (queue_builder/plex.py collection_children + collection_items). So the tile's
// "next" is the FIRST member (in that order) that still has something unwatched: a show's
// next unwatched episode, or an unwatched movie/standalone member. Null = every member
// watched (or the children couldn't be fetched — the caller falls back to the item count).
// viewCount is Bob's admin watched state, same basis as nextEpisode().
//
// The result carries the MEMBER's identity (ratingKey/year/position) as well as the episode,
// because the tile renders member-first: the poster and the title line are the member series,
// and the collection itself becomes the badge (decision `…-collection-tiles-are-member-first`).
// `start` (optional {series, season, episode}) floors the pick exactly like the engine does:
// members before `series` are skipped, and that member's episodes are floored at {season,
// episode}.
export async function collectionNext(collectionRatingKey, start = null) {
  const children = await collectionChildren(collectionRatingKey);
  if (!children) return null;
  const floorAt = startMemberIndex(children, start);
  // Which member the manual start names — the tile's start chip says so in its tooltip (the
  // member that plays NEXT can be a later one, once the start member is fully watched).
  const startMember = floorAt >= 0 ? children[floorAt].title : null;
  for (let i = 0; i < children.length; i++) {
    if (floorAt >= 0 && i < floorAt) continue; // member is before the manual start
    const ch = children[i];
    const where = { member: ch.title, memberRatingKey: ch.ratingKey, memberYear: ch.year, position: i + 1, startMember };
    if (ch.type === 'show') {
      let ep = null;
      try {
        // The episode floor applies only to the member the start names, not to later ones.
        ep = await nextEpisode(ch.ratingKey, floorAt === i ? start : null);
      } catch {
        /* skip a show we can't read; try the next member */
      }
      if (ep) return { ...where, kind: 'show', ...ep };
    } else {
      // movie / episode / standalone member: unwatched unless it carries a viewCount.
      if (ch.watched) continue;
      return { ...where, kind: 'movie', title: ch.title };
    }
  }
  return null;
}

// --- live now-playing -> which TILE is it? ----------------------------------- //
// HA hands us only the ratingKey of the exact item on screen, but a queue tile can be a
// SERIES (the key is one of its episodes) or a COLLECTION (the key is one of its members).
// One metadata read per newly-seen key resolves both parents; cached because the answer is
// immutable for that key, so re-plays and pause/resume storms cost nothing.
const _playCtx = new Map(); // ratingKey -> context
export async function playingContext(ratingKey) {
  const key = String(ratingKey);
  if (_playCtx.has(key)) return _playCtx.get(key);
  let md;
  try {
    md = (container(await plexGet(`/library/metadata/${key}`)).Metadata || [])[0];
  } catch {
    return null; // transient — don't cache a failure
  }
  if (!md) return null;
  const ctx = {
    ratingKey: key,
    type: md.type || null,
    // An episode's grandparent IS its series, which is what a series tile stores.
    showRatingKey: md.grandparentRatingKey != null ? String(md.grandparentRatingKey) : null,
    // Collection membership comes back as name tags, and a collection tile is stored by
    // name ("Collection: <name>") — so names are the only join available here.
    collections: (md.Collection || []).map((c) => c.tag).filter(Boolean),
  };
  _playCtx.set(key, ctx);
  return ctx;
}

// --- poster proxy: fetch a transcoded poster server-side (token never hits the
// browser). 480x720 (not the full-res art): tiles render ~158 CSS px, so this stays
// sharp through 150% zoom / 2-3x DPR screens — 300px visibly pixelated there — while
// still ~10x smaller than the originals. Falls back to the raw thumb.
const _thumbPath = new Map(); // ratingKey -> thumb path
export async function thumb(ratingKey) {
  let tp = _thumbPath.get(ratingKey);
  if (!tp) {
    const md = (container(await plexGet(`/library/metadata/${ratingKey}`)).Metadata || [])[0];
    tp = md && md.thumb ? md.thumb : null;
    if (tp) _thumbPath.set(ratingKey, tp);
  }
  if (!tp) return null;
  const tok = encodeURIComponent(PLEX_TOKEN);
  const transcode =
    `${PLEX_URL}/photo/:/transcode?width=480&height=720&minSize=1&upscale=0` +
    `&url=${encodeURIComponent(tp)}&X-Plex-Token=${tok}`;
  let res = await fetch(transcode);
  if (!res.ok) {
    const sep = tp.includes('?') ? '&' : '?';
    res = await fetch(`${PLEX_URL}${tp}${sep}X-Plex-Token=${tok}`); // fall back to raw art
    if (!res.ok) return null;
  }
  return {
    contentType: res.headers.get('content-type') || 'image/jpeg',
    buffer: Buffer.from(await res.arrayBuffer()),
  };
}
