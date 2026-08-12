// D3 of the Python → Node port (follow-on #2): the DETERMINISTIC curated resolver, ported from
// queue_builder/plex.py + queue_builder/queues.py. This is the shared read-side that turns a
// set's queues.yaml entries into ordered play items — the input the service publishes/plays.
//
// Ported here:
//   * descriptor parsing (queues.py): parseTitleString, entryKey, describe, loadEntries.
//   * the title→ratingKey resolver (plex.py): resolveTitle, resolveQueueEntry, itemType,
//     itemViewState, resumeOffset, headResumeOffset, matchGuidHint.
//   * member resolution (plex.py): collectionItems, resolveMember + the episode filters
//     keepEpisode / isExtraOrPromo / hasRealSeasons / inProgress.
//   * the play-list builders: buildReel (pure, replays in file order) and nextQueue (the
//     deterministic classify+order core of next_queue).
//
// Async client surface (await container/accountToken) so the live undici adapter works too.
// NOT ported here (deferred to D4, the queues.py write-side): the YAML mutation next_queue does
// as a SIDE EFFECT (queues.mark_done / clear_done / sweep_completed). nextQueue returns the same
// dict next_queue returns — the persistence lands with D4. The anime-channel branch shuffles with
// an injected rng (like build_rotation), so parity covers the deterministic non-anime queue only.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { setSections } from './routing.js';
import {
  int0, atOrAfterStart, multiSeason, showEpisodes, findCollection, collectionChildren,
} from './select.js';
import {
  BATCH_STOPS_AT, QUEUE_SERIES_DEFAULT, QUEUE_SERIES_LENGTH, ROTATION_LENGTH,
} from '../env.js';
import { QUEUES_PATH } from '../config.js';

// --------------------------------------------------------------------------- //
// Descriptor parsing — port of queue_builder/queues.py
// --------------------------------------------------------------------------- //
const YEAR_RE = /\s*\((\d{4})\)\s*$/;
const GUID_RE = /\s*\[([^\]]+)\]\s*$/;
const COLLECTION_RE = /^\s*collection:\s*(.+)$/i;
const S0_EXTRA_INDEX_MIN = 200; // trailers (200-299) + OP/ED (300-399)
const S0_EXTRA_INDEX_MAX = 399;

// Split a title string into {title, year|null, guid|null}. Peels a trailing `[source-id]` guid
// hint, then a trailing `(YEAR)`, leaving the bare title. Port of parse_title_string.
export function parseTitleString(text) {
  let s = String(text).trim();
  let guid = null;
  let m = GUID_RE.exec(s);
  if (m) {
    guid = m[1].trim();
    s = s.slice(0, m.index).replace(/\s+$/, '');
  }
  let year = null;
  m = YEAR_RE.exec(s);
  if (m) {
    year = parseInt(m[1], 10);
    s = s.slice(0, m.index).replace(/\s+$/, '');
  }
  return { title: s.trim(), year, guid };
}

// True if `value` is (or stringifies to) a bare numeric ratingKey. Port of _is_rating_key.
function isRatingKey(value) {
  if (typeof value === 'boolean') return false;
  if (typeof value === 'number') return Number.isInteger(value);
  return typeof value === 'string' && /^\d+$/.test(value.trim());
}

const isObj = (e) => e != null && typeof e === 'object' && !Array.isArray(e);

// Stable identity for a queue entry — MUST match queues.py entry_key (and server/src/queues.js
// entryKey). Port of entry_key.
export function entryKey(entry) {
  if (isObj(entry)) {
    const rk = entry.ratingKey;
    if (rk != null) return `rk:${rk}`;
    const coll = entry.collection;
    if (coll) return `title:Collection: ${String(coll).trim()}`;
    const title = entry.title;
    return title ? `title:${String(title).trim()}` : null;
  }
  if (isRatingKey(entry)) return `rk:${String(entry).trim()}`;
  const text = String(entry).trim();
  return text ? `title:${text}` : null;
}

// Normalize a raw queue entry into a resolution descriptor. Port of _describe.
export function describe(entry) {
  if (isObj(entry)) {
    const rk = entry.ratingKey;
    let coll = entry.collection;
    let title = null;
    let year = null;
    let guid = null;
    if (entry.title) ({ title, year, guid } = parseTitleString(entry.title));
    if (coll == null && title) {
      const cm = COLLECTION_RE.exec(title);
      if (cm) coll = cm[1].trim();
    }
    return {
      key: entryKey(entry),
      ratingKey: rk == null ? null : String(rk),
      title: title || null,
      year,
      guid,
      collection: coll ? String(coll).trim() : null,
      episodes: entry.episodes ?? null,
      start: entry.start ?? null,
      done: Boolean(entry.done),
      raw: entry,
    };
  }
  if (isRatingKey(entry)) {
    return {
      key: entryKey(entry), ratingKey: String(entry).trim(), title: null, year: null,
      guid: null, collection: null, episodes: null, start: null, done: false, raw: entry,
    };
  }
  const { title, year, guid } = parseTitleString(entry);
  const cm = COLLECTION_RE.exec(title);
  const coll = cm ? cm[1].trim() : null;
  return {
    key: entryKey(entry), ratingKey: null, title: title || null, year, guid,
    collection: coll, episodes: null, start: null, done: false, raw: entry,
  };
}

// Ordered resolution descriptors for a set, [] if the set/file is empty. Port of queues.entries
// (the read side only — the write-side lock/ruamel round-trip is D4's queues.py port).
export function loadEntries(setName) {
  let data;
  try {
    data = parse(readFileSync(QUEUES_PATH, 'utf8')) || {};
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }
  const seq = (data && data[setName]) || [];
  const out = [];
  for (const e of seq) {
    const desc = describe(e);
    if (desc.key != null) out.push(desc);
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Episode filters — port of plex.py
// --------------------------------------------------------------------------- //
// True if `ep` is a Plex Extra/clip or a Season-0 trailer/OP-ED (index 200-399). Port of
// is_extra_or_promo (mirrors server/src/plex.js isExtraOrPromo).
export function isExtraOrPromo(ep) {
  if (!ep) return false;
  if (ep.type === 'clip') return true;
  if (ep.extraType != null && ep.extraType !== '') return true;
  const season = ep.season != null ? ep.season : ep.parentIndex;
  if (String(season) === '0') {
    const raw = ep.episode != null ? ep.episode : ep.index;
    const idx = parseInt(raw, 10);
    if (Number.isFinite(idx) && idx >= S0_EXTRA_INDEX_MIN && idx <= S0_EXTRA_INDEX_MAX) return true;
  }
  return false;
}

// True if a show has any NON-special season (>= 1). Port of _has_real_seasons.
export function hasRealSeasons(allEps) {
  return allEps.some((e) => !['0', 'None', ''].includes(String(e.season)));
}

// True if a leaf/item is RESUMABLE: started (viewOffset > 0) and NOT finished (viewCount < 1;
// a missing count is 0 via int0). Port of _in_progress.
export function inProgress(viewOffset, viewCount) {
  return int0(viewOffset) > 0 && int0(viewCount) < 1;
}

// Drop extras, specials (unless opted in / specialsOk), and zero-duration items. Port of
// _keep_episode.
export function keepEpisode(ep, cfg, specialsOk = false) {
  if (isExtraOrPromo(ep)) return false;
  if (!cfg.include_specials && !specialsOk && String(ep.season) === '0') return false;
  if (!ep.duration) return false;
  return true;
}

// True if a `source-id` folder hint (`anidb-16172`) is in `guids` (`anidb://16172`). Split on
// the FIRST dash, case-insensitive. Port of _match_guid_hint.
function matchGuidHint(hint, guids) {
  if (!hint) return false;
  const i = hint.indexOf('-');
  if (i <= 0 || i >= hint.length - 1) return false;
  const want = `${hint.slice(0, i)}://${hint.slice(i + 1)}`.toLowerCase();
  return guids.some((g) => String(g || '').toLowerCase() === want);
}

// urllib.parse.quote(title) with the default safe="/" — space→%20, `/` kept, but `!*'()` escaped
// (encodeURIComponent leaves them). The sha1 corpus key is over the literal path, so this must
// match _resolve_title's Python quoting byte-for-byte.
function quote(s) {
  return encodeURIComponent(String(s))
    .replace(/%2F/gi, '/')
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// --------------------------------------------------------------------------- //
// Title → ratingKey resolution — port of plex.py
// --------------------------------------------------------------------------- //
// (type, title) for a ratingKey — "movie"|"show" — or [null, null]. Port of item_type. (No
// cache — one container read per call; behaviourally identical, no stale state across clients.)
export async function itemType(client, ratingKey, token) {
  let mc;
  try {
    mc = await client.container(`/library/metadata/${ratingKey}`, token);
  } catch {
    return [null, null];
  }
  const md = mc.Metadata || [];
  if (!md.length) return [null, null];
  const t = md[0].type;
  if (t !== 'movie' && t !== 'show') return [null, null];
  return [t, md[0].title];
}

// [viewOffset_ms, viewCount] for one item under `token`'s account, [0, 0] on any miss. Port of
// item_view_state.
async function itemViewState(client, ratingKey, token) {
  let mc;
  try {
    mc = await client.container(`/library/metadata/${ratingKey}`, token);
  } catch {
    return [0, 0];
  }
  const md = mc.Metadata || [];
  if (!md.length) return [0, 0];
  return [int0(md[0].viewOffset), int0(md[0].viewCount)];
}

// Milliseconds to resume `ratingKey` at — its viewOffset when IN-PROGRESS, else 0. Port of
// resume_offset (the `watched` arg is deliberately not consulted; kept off the signature here).
async function resumeOffset(client, ratingKey, token) {
  const [offset, count] = await itemViewState(client, ratingKey, token);
  return inProgress(offset, count) ? offset : 0;
}

// Resume offset (ms) for a resolved play ITEM, reusing its live state when present. Port of
// _head_resume_offset.
async function headResumeOffset(client, item, token) {
  if (item.viewOffset != null) {
    return inProgress(item.viewOffset, item.viewCount) ? item.viewOffset : 0;
  }
  return await resumeOffset(client, item.ratingKey, token);
}

// Resolve a title string to [ratingKey, type, title] within a section, or [null, null, null].
// Port of _resolve_title (same scoring + lowest-ratingKey tie-break).
export async function resolveTitle(client, section, title, year, guid, token) {
  const q = quote(title);
  let mc;
  try {
    mc = await client.container(
      `/library/sections/${section}/all?title=${q}&includeGuids=1&X-Plex-Container-Size=50`, token);
  } catch {
    return [null, null, null];
  }
  let best = null;
  let bestScore = 0;
  const tl = title.toLowerCase();
  for (const e of mc.Metadata || []) {
    const et = e.type;
    if (et !== 'movie' && et !== 'show') continue;
    const candTitle = e.title || '';
    const candYear = e.year;
    const guids = (e.Guid || []).map((g) => g.id);
    let score = 0;
    if (guid && matchGuidHint(guid, guids)) score += 100;
    if (year != null && candYear === year) score += 10;
    else if (year != null && candYear != null && candYear !== year) score -= 5;
    const cl = candTitle.toLowerCase();
    if (cl === tl) score += 5;
    else if (cl.startsWith(tl)) score += 1;
    const rk = String(e.ratingKey);
    const better = best === null || score > bestScore
      || (score === bestScore && /^\d+$/.test(rk) && parseInt(rk, 10) < parseInt(best[0], 10));
    if (better) {
      best = [rk, et, candTitle];
      bestScore = score;
    }
  }
  if (best === null || bestScore <= 0) return [null, null, null];
  return best;
}

// The sections a curated set resolves entries against. Port of the shared
// `queue_sections or set_sections or [queue_section]` expression.
function resolveSections(cfg) {
  if (cfg.queue_sections && cfg.queue_sections.length) return cfg.queue_sections;
  const ss = setSections(cfg);
  if (ss.length) return ss;
  return [cfg.queue_section];
}

// Resolve one queue descriptor to [ratingKey, type, title]. Port of resolve_queue_entry.
export async function resolveQueueEntry(client, desc, cfg, token) {
  const rk = desc.ratingKey;
  if (rk) {
    const [typ, title] = await itemType(client, rk, token);
    if (typ == null) return [null, null, null];
    return [rk, typ, title];
  }
  const title = desc.title;
  if (!title) return [null, null, null];
  for (const sec of resolveSections(cfg)) {
    const [rrk, typ, resolved] = await resolveTitle(client, sec, title, desc.year, desc.guid, token);
    if (typ != null) return [rrk, typ, resolved];
  }
  return [null, null, null];
}

// --------------------------------------------------------------------------- //
// Collections as ordered entries — port of plex.py
// --------------------------------------------------------------------------- //
// Index of the collection child a manual start names, or -1. Port of _start_member_index.
function startMemberIndex(children, start) {
  if (!start || start.series == null || start.series === '') return -1;
  const want = String(start.series).trim().toLowerCase();
  for (let i = 0; i < children.length; i += 1) {
    const ch = children[i];
    if (String(ch.ratingKey).trim().toLowerCase() === want) return i;
    if (String(ch.title || '').trim().toLowerCase() === want) return i;
  }
  return -1;
}

// Ordered playable items for a `Collection: <name>` entry, across the set's sections. Port of
// collection_items — None (null) = not found, [] = found but every child watched, [...] = items.
export async function collectionItems(client, cfg, name, watched, token, start = null, resume = false) {
  let collRk = null;
  let children = [];
  for (const sec of resolveSections(cfg)) {
    if (sec == null) continue;
    collRk = await findCollection(client, sec, name, token);
    if (collRk) {
      children = await collectionChildren(client, collRk, token);
      break;
    }
  }
  if (!collRk) return null;
  const floorAt = startMemberIndex(children, start);
  const items = [];
  for (let i = 0; i < children.length; i += 1) {
    if (floorAt >= 0 && i < floorAt) continue;
    const ch = children[i];
    const rk = String(ch.ratingKey);
    if (ch.type === 'show') {
      const epStart = i === floorAt ? start : null;
      const childEps = await showEpisodes(client, rk, token);
      const specialsOk = resume && !hasRealSeasons(childEps);
      for (const e of childEps) {
        if ((!watched.has(e.ratingKey) || (resume && inProgress(e.viewOffset, e.viewCount)))
          && keepEpisode(e, cfg, specialsOk) && atOrAfterStart(e, epStart)) {
          // Which collection CHILD this leaf came from, so a `batch_stops_at` cut can see the
          // member boundary (segmentKey). showEpisodes builds fresh objects per call, so
          // tagging in place is local to this resolve.
          e.member_key = rk;
          items.push(e);
        }
      }
    } else {
      if (watched.has(rk)
        && !(resume && inProgress(...await itemViewState(client, rk, token)))) continue;
      items.push({
        ratingKey: rk, title: ch.title, show: ch.grandparentTitle || name,
        // Its OWN member_key: `show` is the collection name for a movie member, so keying a
        // boundary on that would fuse every movie in the collection into one segment.
        member_key: rk,
        season: ch.parentIndex, episode: ch.index, duration: ch.duration,
      });
    }
  }
  return items;
}

// --------------------------------------------------------------------------- //
// Batch boundaries (`batch_stops_at`) — port of plex.py's _batch_stop/_apply_batch
// --------------------------------------------------------------------------- //
const BATCH_STOPS = ['member', 'season'];
const BATCH_STOPS_OFF = ['none', '', 'off', 'no', 'false', '0'];

// Where this entry's batch may stop: 'none' | 'member' | 'season'. Precedence: the ENTRY's
// `batch_stops_at` (queues.yaml) > the SET's (sets.yaml) > env BATCH_STOPS_AT (default 'none' =
// today's fill-across-anything). An UNRECOGNISED value at one level is ignored rather than read
// as 'none', so a typo in a hand-edited entry falls back to the set's intent, not off.
function batchStop(desc, cfg) {
  for (const raw of [(desc || {}).batch_stops_at, (cfg || {}).batch_stops_at, BATCH_STOPS_AT]) {
    if (raw == null) continue;
    const val = String(raw).trim().toLowerCase();
    if (BATCH_STOPS.includes(val)) return val;
    if (BATCH_STOPS_OFF.includes(val)) return 'none';
  }
  return 'none';
}

// The segment an item belongs to under `stop` — a batch may not span two segments. `member_key`
// is the collection CHILD an item came from (tagged by collectionItems); it is absent on a plain
// show entry's leaves, where every item is the same member anyway, so the fallback to `show`
// keeps a 'member' stop a correct no-op there. Movies in a collection each carry their OWN
// member_key, because their `show` is the collection name and would fuse them into one segment.
function segmentKey(item, stop) {
  const member = item.member_key || item.show;
  return stop === 'season' ? `${member} ${item.season}` : String(member);
}

// Cap `items` to `batch`, then cut at the first segment boundary if `stop` asks. Only ever
// SHORTENS, and never below one item — an empty list is the FINISHED signal nextQueue marks the
// entry done on, so a boundary cut that emptied a live batch would silently retire a show
// mid-run. The boundary applies only when a count cap is in force, so the rotation /
// member-bucket callers (no batch) keep the full ordered list their round-robin walks.
function applyBatch(items, batch, stop) {
  if (!batch) return items;
  const n = Math.max(1, Math.min(parseInt(batch, 10), QUEUE_SERIES_LENGTH));
  let out = items.slice(0, n);
  if (BATCH_STOPS.includes(stop) && out.length > 1) {
    const head = segmentKey(out[0], stop);
    let cut = 1;
    while (cut < out.length && segmentKey(out[cut], stop) === head) cut += 1;
    out = out.slice(0, cut);
  }
  return out;
}

// Resolve ONE member descriptor into a play batch. Port of resolve_member. Returns null when
// UNRESOLVED; otherwise {title, type, ratingKey?, items, multi_season?} (empty items = FINISHED).
// The count cap says how many; batchStop says where the batch may end (see batchStop above).
export async function resolveMember(client, desc, cfg, watched, token, defaultBatch = null, resume = false) {
  if (desc.collection) {
    const name = desc.collection;
    let items = await collectionItems(client, cfg, name, watched, token, desc.start, resume);
    if (items == null) return null;
    // A collection is ONE member, so it contributes ONE batch — the same cap the show branch
    // applies below, honoring a per-entry `episodes:` override the same way. Without this a
    // collection dumped its children's ENTIRE unwatched run into a single scan: the anime
    // channel built 9 consecutive Chaika episodes + 2 Nadesico + 1 Gleipnir and called that a
    // 12-item rotation (2026-08-11). Decision
    // 2026-07-21-plex-collections-as-ordered-queue-entries is explicit that a collection gets
    // "the same footing as show entries"; uncapped expansion was never that.
    // defaultBatch stays null for the rotation/member-bucket callers, so their round-robin
    // still receives the full ordered list and advances a member across rounds as before.
    // `batch_stops_at` additionally forbids the batch from spanning a member (or season)
    // boundary, so a season finale isn't followed by ep 1 of the next member show.
    items = applyBatch(items, desc.episodes || defaultBatch, batchStop(desc, cfg));
    return { title: `Collection: ${name}`, type: 'collection', items };
  }
  const [rk, typ, title] = await resolveQueueEntry(client, desc, cfg, token);
  if (typ == null) return null;
  if (typ === 'movie') {
    let keepMovie = !watched.has(rk);
    if (!keepMovie && resume) keepMovie = inProgress(...await itemViewState(client, rk, token));
    const items = keepMovie
      ? [{ title, ratingKey: rk, show: null, season: null, episode: null }] : [];
    return { title, type: 'movie', ratingKey: rk, items };
  }
  const allEps = await showEpisodes(client, rk, token);
  const start = desc.start;
  const specialsOk = resume && !hasRealSeasons(allEps);
  let eps = allEps.filter((e) => (!watched.has(e.ratingKey)
    || (resume && inProgress(e.viewOffset, e.viewCount)))
    && keepEpisode(e, cfg, specialsOk) && atOrAfterStart(e, start));
  // A `season` stop also cuts at a season boundary, so `episodes: 2` on a show sitting at its
  // finale queues S1E12 alone instead of S1E12 + S2E01.
  eps = applyBatch(eps, desc.episodes || defaultBatch, batchStop(desc, cfg));
  return { title, type: 'show', ratingKey: rk, items: eps, multi_season: multiSeason(allEps) };
}

// --------------------------------------------------------------------------- //
// Play-list builders — port of plex.py
// --------------------------------------------------------------------------- //
const emptyResult = (setName) => ({
  set: setName, play: [], last: null, done: [], unresolved: [], remaining: 0, offset: 0,
});

// Resolve a REEL set to an ORDERED play list, ignoring watched-state entirely (file order IS the
// play order; nothing is ever finished). Port of build_reel.
export async function buildReel(client, setName, cfg, entries, token, limit = 60) {
  if (!entries.length) return emptyResult(setName);
  const play = [];
  const unresolved = [];
  for (const desc of entries) {
    if (play.length >= limit) break;
    if (desc.done) continue; // a hand-tagged skip is still honored
    if (desc.collection) {
      const items = await collectionItems(client, cfg, desc.collection, new Set(), token, desc.start);
      if (!items || !items.length) {
        unresolved.push(`Collection: ${desc.collection}`);
        continue;
      }
      play.push(...items.slice(0, Math.max(0, limit - play.length)));
      continue;
    }
    const [rk, typ, title] = await resolveQueueEntry(client, desc, cfg, token);
    if (typ == null) {
      unresolved.push(desc.ratingKey || desc.title || desc.key);
      continue;
    }
    if (typ === 'movie') {
      play.push({ title, ratingKey: rk });
    } else {
      const eps = await showEpisodes(client, rk, token);
      const batch = Math.max(1, Math.min(parseInt(desc.episodes || QUEUE_SERIES_DEFAULT, 10),
        QUEUE_SERIES_LENGTH));
      for (const e of eps.slice(0, batch)) play.push({ title: e.title || title, ratingKey: e.ratingKey });
    }
  }
  const last = play.length
    ? { title: play[0].title, type: 'movie', ratingKey: play[0].ratingKey } : null;
  return { set: setName, play, last, done: [], unresolved, remaining: play.length, offset: 0 };
}

// The DETERMINISTIC classify+order core of next_queue: resolve each entry, split finished /
// unresolved / active, then pick the play items (a QUEUE plays the first active batch; an anime
// CHANNEL hoists in-progress members then shuffles the rest via the injected `rng`). Port of
// next_queue MINUS its YAML side effects (mark_done / clear_done / sweep_completed → D4). The
// returned dict matches next_queue's; parity covers the non-anime queue path (the shuffle is rng).
export async function nextQueue(client, setName, cfg, entries, watched, token, rng = null) {
  if (!entries.length) return emptyResult(setName);
  const newlyDone = [];
  const doneFlagged = [];
  const unresolved = [];
  const revived = [];
  let remaining = 0;
  const batches = [];
  for (const desc of entries) {
    const res = await resolveMember(client, desc, cfg, watched, token, QUEUE_SERIES_DEFAULT, true);
    if (desc.done) {
      const head = res && res.items && res.items.length ? res.items[0] : null;
      if (head && await headResumeOffset(client, head, token) > 0) {
        revived.push(desc.key);
        remaining += 1;
        batches.push({ title: res.title, type: res.type, items: res.items });
      } else {
        doneFlagged.push(desc.title || desc.ratingKey || desc.key);
      }
      continue;
    }
    remaining += 1;
    if (res == null) {
      unresolved.push(desc.collection ? `Collection: ${desc.collection}`
        : desc.ratingKey || desc.title || desc.key);
      continue;
    }
    if (!res.items.length) {
      newlyDone.push(desc.key);
      doneFlagged.push(res.title);
      remaining -= 1;
      continue;
    }
    batches.push({ title: res.title, type: res.type, items: res.items });
  }

  const leadsInProgress = (b) => {
    const it = b.items.length ? b.items[0] : null;
    return Boolean(it && inProgress(it.viewOffset, it.viewCount));
  };

  let playItems;
  let leadBatch;
  if (cfg.kind === 'anime') {
    // Channel: member order is irrelevant AND shuffled — but an in-progress member LEADS so it
    // resumes. Hoist in-progress batches (file order among them), shuffle the rest via `rng`.
    const lead = batches.filter(leadsInProgress);
    const rest = batches.filter((b) => !leadsInProgress(b));
    if (rng) rng.shuffle(rest);
    const ordered = lead.concat(rest);
    playItems = [];
    for (const b of ordered) {
      playItems.push(...b.items.slice(0, ROTATION_LENGTH - playItems.length));
      if (playItems.length >= ROTATION_LENGTH) break;
    }
    leadBatch = ordered.length ? ordered[0] : null;
  } else {
    playItems = batches.length ? batches[0].items : [];
    leadBatch = batches.length ? batches[0] : null;
  }
  const last = playItems.length
    ? { title: leadBatch.title, type: leadBatch.type, ratingKey: playItems[0].ratingKey } : null;
  const offset = playItems.length ? await headResumeOffset(client, playItems[0], token) : 0;
  return {
    set: setName, play: playItems, last, done: doneFlagged, unresolved, remaining, offset, revived,
    newlyDone, // D4: keys for queues.markDone (not in the Python JSON oracle shape)
  };
}
