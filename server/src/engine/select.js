// D3 of the Python → Node port: the DETERMINISTIC selection core, ported from
// queue_builder/plex.py. This first slice is the unwatched-buckets pool that the kid rotation
// is built from — the deterministic input the RNG shuffle later orders (see
// docs/d3-engine-parity-corpus.md for why parity compares this, not the shuffled result).
//
// Ported here: _watched_for_set, episodic_shows, section_items, show_episodes, _rating_ok,
// _int0, _at_or_after_start, _multi_season, unwatched_buckets, plus the collection-expansion
// blocklist (find_collection / collection_children / _expanded_blocklist). The client (live undici or corpus replay) supplies `container(path, token)` +
// `accountToken(uuid)` — either may return a Promise; every engine call site awaits them so both
// work. Pure helpers stay sync.
//
import { setSections } from './routing.js';
import { WATCH_COUNT_ACCOUNTS } from '../env.js';

// Plex omits viewCount at 0, so a missing/non-numeric value reads as 0 = unwatched (never as
// watched — the resume-in-queue bug). Port of plex.py _int0.
export function int0(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

// allowed=null => no content-rating cap. Port of plex.py _rating_ok.
function ratingOk(item, allowed) {
  if (allowed == null) return true;
  return allowed.has(String(item.contentRating));
}

// False if `ep` sorts BEFORE the manual start floor {season, episode}. Port of _at_or_after_start.
export function atOrAfterStart(ep, start) {
  if (!start || start.episode == null) return true;
  const i = (v, d = 0) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : d;
  };
  const es = i(ep.season);
  const ee = i(ep.episode);
  const ss = i(start.season, 1);
  const se = i(start.episode, 1);
  return es > ss || (es === ss && ee >= se); // tuple >= (ss, se)
}

// True if a show spans more than one real season (S0 specials don't count). Port of _multi_season.
export function multiSeason(allEps) {
  const seasons = new Set();
  for (const e of allEps) {
    const s = String(e.season);
    if (s !== 'None' && s !== '0') seasons.add(s);
  }
  return seasons.size > 1;
}

// Shows (type=2) across `sections`, kept only if contentRating is allowed. Port of episodic_shows.
async function episodicShows(client, sections, allowed, blocked, token) {
  const shows = [];
  for (const sec of sections) {
    const mc = await client.container(`/library/sections/${sec}/all?type=2&X-Plex-Container-Size=5000`, token);
    for (const s of mc.Metadata || []) {
      const rk = String(s.ratingKey);
      if (blocked.has(rk) || !ratingOk(s, allowed)) continue;
      shows.push({ ratingKey: rk, title: s.title, section: sec });
    }
  }
  return shows;
}

// Standalone items (type=1, e.g. Shorts) across `sections`, rating-filtered. Port of section_items.
async function sectionItems(client, sections, allowed, blocked, token) {
  const items = [];
  for (const sec of sections) {
    const mc = await client.container(`/library/sections/${sec}/all?type=1&X-Plex-Container-Size=10000`, token);
    for (const m of mc.Metadata || []) {
      const rk = String(m.ratingKey);
      if (blocked.has(rk) || !ratingOk(m, allowed)) continue;
      items.push({ ratingKey: rk, title: m.title, section: sec });
    }
  }
  return items;
}

// Ordered flat episode list for a show (allLeaves), season/episode preserved. Port of show_episodes.
export async function showEpisodes(client, showRatingKey, token) {
  const mc = await client.container(`/library/metadata/${showRatingKey}/allLeaves`, token);
  return (mc.Metadata || []).map((e) => ({
    ratingKey: String(e.ratingKey),
    title: e.title,
    show: e.grandparentTitle,
    season: e.parentIndex,
    episode: e.index,
    duration: e.duration,
    type: e.type,
    extraType: e.extraType,
    viewCount: int0(e.viewCount),
    viewOffset: int0(e.viewOffset),
  }));
}

// Every history row for one account (optionally one section). Port of _iter_history.
export async function* iterHistory(client, accountId, sectionId, page = 500) {
  let start = 0;
  for (;;) {
    const pairs = [
      ['accountID', accountId],
      ['X-Plex-Container-Start', start],
      ['X-Plex-Container-Size', page],
      ['sort', 'viewedAt:desc'],
    ];
    if (sectionId != null) pairs.push(['librarySectionID', sectionId]);
    // urlencode mirrors Python's exactly (the sha1 corpus key is over this literal string).
    const q = pairs.map(([k, v]) => `${encQ(k)}=${encQ(v)}`).join('&');
    const mc = await client.container('/status/sessions/history/all?' + q, null);
    const rows = mc.Metadata || [];
    for (const row of rows) yield row;
    start += rows.length;
    const total = mc.totalSize != null ? mc.totalSize : mc.size != null ? mc.size : 0;
    if (!rows.length || start >= total) break;
  }
}
// quote_plus: ':' -> '%3A', space -> '+'. Keys here have no chars that encode differently.
function encQ(s) {
  return encodeURIComponent(String(s)).replace(/%20/g, '+').replace(/[!'()*~]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// Watched ratingKeys for a set, using the binding's own accounts. Port of _watched_for_set.
export async function watchedForSet(client, cfg, binding) {
  const accts = (binding && binding.watch_count_accounts) || WATCH_COUNT_ACCOUNTS;
  const watched = new Set();
  for (const acct of accts) {
    for (const sec of setSections(cfg)) {
      for await (const row of iterHistory(client, acct, sec)) {
        if (row.ratingKey != null) watched.add(String(row.ratingKey));
      }
    }
  }
  return watched;
}

// Plex library type of a section ("movie"|"show"|…). Port of section_kind (no module cache —
// one container read; behaviourally identical, avoids stale-cache footguns across clients).
async function sectionKind(client, section) {
  const mc = await client.container('/library/sections', null);
  for (const d of mc.Directory || []) if (String(d.key) === String(section)) return d.type;
  return undefined;
}

// {ratingKey: title} for a MOVIE library's rating-allowed films. Port of _movie_films.
async function movieFilms(client, section, allowed, token) {
  const mc = await client.container(`/library/sections/${section}/all?type=1&X-Plex-Container-Size=10000`, token);
  const out = new Map();
  for (const m of mc.Metadata || []) if (ratingOk(m, allowed)) out.set(String(m.ratingKey), m.title);
  return out;
}

// {showRatingKey: title} for a SHOW library's ONE-EPISODE entries (anime films). Port of _show_films.
async function showFilms(client, section, allowed, token) {
  const mc = await client.container(`/library/sections/${section}/all?type=2&X-Plex-Container-Size=5000`, token);
  const out = new Map();
  for (const s of mc.Metadata || []) if (s.leafCount === 1 && ratingOk(s, allowed)) out.set(String(s.ratingKey), s.title);
  return out;
}

// (counts, titles) for every rewatchable item these accounts have SEEN. Port of rewatch_counts:
// the pool IS the history, so the "seen at least once" floor is structural. counts[rk] is the
// view count (the weighting input); the weighted PICK is rng and stays a per-language test.
export async function rewatchCounts(client, sections, allowed, accts, token) {
  const counts = new Map();
  const titles = new Map();
  for (const sec of sections) {
    const isShow = (await sectionKind(client, sec)) === 'show';
    const films = isShow ? await showFilms(client, sec, allowed, token) : await movieFilms(client, sec, allowed, token);
    if (!films.size) continue;
    for (const acct of accts || WATCH_COUNT_ACCOUNTS) {
      for await (const row of iterHistory(client, acct, sec)) {
        const rk = String(row.ratingKey);
        if (isShow) {
          const showRk = String(row.grandparentKey || '').split('/').pop();
          if (!films.has(showRk)) continue;
          titles.set(rk, films.get(showRk));
        } else if (films.has(rk)) {
          titles.set(rk, films.get(rk));
        } else {
          continue;
        }
        counts.set(rk, (counts.get(rk) || 0) + 1);
      }
    }
  }
  return { counts, titles };
}

// ratingKey of the Collection titled `name` in `section` (type=18), or null. Case-insensitive
// exact title match. Port of find_collection. (No per-scan cache — one container read per lookup;
// behaviourally identical, and the port has no module-level state to go stale across clients.)
export async function findCollection(client, section, name, token) {
  let mc;
  try {
    mc = await client.container(`/library/sections/${section}/collections?X-Plex-Container-Size=1000`, token);
  } catch {
    return null; // network/query hiccup (or corpus miss): unresolved this scan, never crash
  }
  const want = name.trim().toLowerCase();
  for (const c of mc.Metadata || []) {
    if (String(c.title || '').trim().toLowerCase() === want) return String(c.ratingKey);
  }
  return null;
}

// Ordered child items of a collection (the collection's own `collectionSort` order — no
// client-side re-sort). Port of collection_children.
export async function collectionChildren(client, ratingKey, token) {
  try {
    const mc = await client.container(`/library/collections/${ratingKey}/children`, token);
    return mc.Metadata || [];
  } catch {
    return [];
  }
}

// The set's blocklist as concrete ratingKeys to drop from the pool. Each entry is either a bare
// ratingKey or a "Collection: <name>" string — the latter is expanded to every member's ratingKey
// (searched across the set's sections; a shows collection contributes show ratingKeys that
// episodic_shows drops, a shorts collection contributes item ratingKeys that section_items drops).
// Unresolvable collection names are skipped. Port of _expanded_blocklist.
async function expandedBlocklist(client, cfg, token) {
  const out = new Set();
  let sections = null;
  for (const entry of cfg.blocklist || []) {
    const s = String(entry).trim();
    if (!/^collection:/i.test(s)) {
      out.add(s);
      continue;
    }
    const name = s.split(':').slice(1).join(':').trim();
    if (!name) continue;
    if (sections === null) sections = setSections(cfg) || [];
    for (const sec of sections) {
      const crk = await findCollection(client, sec, name, token);
      if (crk) {
        for (const ch of await collectionChildren(client, crk, token)) out.add(String(ch.ratingKey));
        break;
      }
    }
  }
  return out;
}

// Per-bucket ordered lists of NOT-yet-watched items for a set. Port of unwatched_buckets.
// Episodic show -> its ordered unwatched episodes; an item section (Shorts) -> ONE bucket
// (returned in listing order — the caller shuffles; parity compares the set).
export async function unwatchedBuckets(client, cfg, binding) {
  const allowed = binding.allowed_ratings;
  const tok = await client.accountToken(binding.user_uuid);
  const watched = await watchedForSet(client, cfg, binding);
  const blocked = await expandedBlocklist(client, cfg, tok);
  const starts = cfg.starts || {};

  const buckets = [];
  for (const show of await episodicShows(client, cfg.episodic_sections, allowed, blocked, tok)) {
    const allEps = await showEpisodes(client, show.ratingKey, tok);
    const start = starts[String(show.ratingKey)];
    const eps = allEps.filter((e) => !watched.has(e.ratingKey) && atOrAfterStart(e, start));
    if (eps.length) {
      buckets.push({ show: show.title, ratingKey: show.ratingKey, episodes: eps, multi_season: multiSeason(allEps) });
    }
  }
  for (const sec of cfg.item_sections || []) {
    const items = (await sectionItems(client, [sec], allowed, blocked, tok))
      .filter((it) => !watched.has(it.ratingKey))
      .map((it) => ({ ratingKey: it.ratingKey, title: it.title, show: 'Shorts', season: null, episode: null }));
    if (items.length) buckets.push({ show: 'Shorts', ratingKey: `section-${sec}`, episodes: items });
  }
  return buckets;
}
