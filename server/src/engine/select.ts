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
import { toWeight } from './weight.js';
import type { Rng } from './weight.js';
import { WATCH_COUNT_ACCOUNTS } from '../env.js';
import type { Bucket, EngineBinding, PlexClient, PlexMetadata, PoolItem, Start } from '../types.js';

/**
 * A Plex auth token as this layer passes it around: null = the admin/default `X-Plex-Token`,
 * a string = a managed account's. `undefined` is admitted because `providers/plex.js` reads it
 * off an optional `BucketsContext` field — `PlexClient.container` treats undefined and null
 * identically (both select the admin corpus/token), so nothing here branches on the difference.
 */
type Token = string | null | undefined;

/**
 * The cfg slice the selection core reads. Structural and all-optional on purpose: this is handed
 * a `RoutingRotationCfg` in production, a `RoutingQueueCfg` through `watchedForSet`, and the
 * fixture cfgs the parity gates build — every field is already read defensively below.
 */
type SelectCfg = {
  episodic_sections?: readonly number[] | null;
  item_sections?: readonly number[] | null;
  blocklist?: readonly unknown[] | null;
  starts?: Record<string, Start | undefined> | null;
  weights?: Record<string, unknown> | null;
  /** `restart` = a FINISHED show goes back to its start floor instead of leaving the pool.
   *  Anything else (including absent) = drop, which is what this has always done. */
  on_complete?: string;
};

/** One library row `episodicShows` / `sectionItems` hand to `unwatchedBuckets`. */
interface LibraryRow {
  ratingKey: string;
  title: string | undefined;
  section: number | string;
}

// Plex omits viewCount at 0, so a missing/non-numeric value reads as 0 = unwatched (never as
// watched — the resume-in-queue bug). Port of plex.py _int0.
export function int0(v: unknown): number {
  // `String(v)` only spells out the ToString `parseInt` already does to its argument.
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : 0;
}

// allowed=null => no content-rating cap. Port of plex.py _rating_ok.
function ratingOk(item: PlexMetadata, allowed: ReadonlySet<string> | null | undefined): boolean {
  if (allowed == null) return true;
  return allowed.has(String(item.contentRating));
}

// False if `ep` sorts BEFORE the manual start floor {season, episode}. Port of _at_or_after_start.
export function atOrAfterStart(
  ep: { season?: unknown; episode?: unknown },
  start: Start | null | undefined,
): boolean {
  if (!start || start.episode == null) return true;
  const i = (v: unknown, d = 0): number => {
    const n = parseInt(String(v), 10);
    return Number.isFinite(n) ? n : d;
  };
  const es = i(ep.season);
  const ee = i(ep.episode);
  const ss = i(start.season, 1);
  const se = i(start.episode, 1);
  return es > ss || (es === ss && ee >= se); // tuple >= (ss, se)
}

// True if a show spans more than one real season (S0 specials don't count). Port of _multi_season.
export function multiSeason(allEps: readonly { season?: unknown }[]): boolean {
  const seasons = new Set();
  for (const e of allEps) {
    const s = String(e.season);
    if (s !== 'None' && s !== '0') seasons.add(s);
  }
  return seasons.size > 1;
}

// Shows (type=2) across `sections`, kept only if contentRating is allowed. Port of episodic_shows.
async function episodicShows(
  client: PlexClient,
  sections: readonly (number | string)[],
  allowed: ReadonlySet<string> | null | undefined,
  blocked: ReadonlySet<string>,
  token: Token,
): Promise<LibraryRow[]> {
  const shows: LibraryRow[] = [];
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
async function sectionItems(
  client: PlexClient,
  sections: readonly (number | string)[],
  allowed: ReadonlySet<string> | null | undefined,
  blocked: ReadonlySet<string>,
  token: Token,
): Promise<LibraryRow[]> {
  const items: LibraryRow[] = [];
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
export async function showEpisodes(
  client: PlexClient,
  showRatingKey: string | number,
  token: Token,
): Promise<PoolItem[]> {
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
export async function* iterHistory(
  client: PlexClient,
  accountId: number | string,
  sectionId?: number | string | null,
  page = 500,
): AsyncGenerator<PlexMetadata, void, void> {
  let start = 0;
  for (;;) {
    const pairs: [string, number | string][] = [
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
function encQ(s: unknown): string {
  return encodeURIComponent(String(s)).replace(/%20/g, '+').replace(/[!'()*~]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// Watched ratingKeys for a set, using the binding's own accounts. Port of _watched_for_set.
export async function watchedForSet(
  client: PlexClient,
  cfg: SelectCfg,
  binding: EngineBinding | null | undefined,
): Promise<Set<string>> {
  const accts = (binding && binding.watch_count_accounts) || WATCH_COUNT_ACCOUNTS;
  const watched = new Set<string>();
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
async function sectionKind(client: PlexClient, section: number | string): Promise<string | undefined> {
  const mc = await client.container('/library/sections', null);
  for (const d of mc.Directory || []) if (String(d.key) === String(section)) return d.type;
  return undefined;
}

// {ratingKey: title} for a MOVIE library's rating-allowed films. Port of _movie_films.
async function movieFilms(
  client: PlexClient,
  section: number | string,
  allowed: ReadonlySet<string> | null | undefined,
  token: Token,
): Promise<Map<string, string | undefined>> {
  const mc = await client.container(`/library/sections/${section}/all?type=1&X-Plex-Container-Size=10000`, token);
  const out = new Map<string, string | undefined>();
  for (const m of mc.Metadata || []) if (ratingOk(m, allowed)) out.set(String(m.ratingKey), m.title);
  return out;
}

// {showRatingKey: title} for a SHOW library's ONE-EPISODE entries (anime films). Port of _show_films.
async function showFilms(
  client: PlexClient,
  section: number | string,
  allowed: ReadonlySet<string> | null | undefined,
  token: Token,
): Promise<Map<string, string | undefined>> {
  const mc = await client.container(`/library/sections/${section}/all?type=2&X-Plex-Container-Size=5000`, token);
  const out = new Map<string, string | undefined>();
  for (const s of mc.Metadata || []) if (s.leafCount === 1 && ratingOk(s, allowed)) out.set(String(s.ratingKey), s.title);
  return out;
}

// (counts, titles) for every rewatchable item these accounts have SEEN. Port of rewatch_counts:
// the pool IS the history, so the "seen at least once" floor is structural. counts[rk] is the
// view count (the weighting input); the weighted PICK is rng and stays a per-language test.
export async function rewatchCounts(
  client: PlexClient,
  sections: readonly (number | string)[],
  allowed: ReadonlySet<string> | null | undefined,
  accts: readonly number[] | null | undefined,
  token: Token,
): Promise<{ counts: Map<string, number>; titles: Map<string, string | undefined> }> {
  const counts = new Map<string, number>();
  const titles = new Map<string, string | undefined>();
  for (const sec of sections) {
    const isShow = (await sectionKind(client, sec)) === 'show';
    const films = isShow ? await showFilms(client, sec, allowed, token) : await movieFilms(client, sec, allowed, token);
    if (!films.size) continue;
    for (const acct of accts || WATCH_COUNT_ACCOUNTS) {
      for await (const row of iterHistory(client, acct, sec)) {
        const rk = String(row.ratingKey);
        if (isShow) {
          // `split` always yields at least one element, so `pop()` is never undefined here.
          const showRk = String(row.grandparentKey || '').split('/').pop() as string;
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
export async function findCollection(
  client: PlexClient,
  section: number | string,
  name: string,
  token: Token,
): Promise<string | null> {
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
export async function collectionChildren(
  client: PlexClient,
  ratingKey: string | number,
  token: Token,
): Promise<PlexMetadata[]> {
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
async function expandedBlocklist(
  client: PlexClient,
  cfg: SelectCfg,
  token: Token,
): Promise<Set<string>> {
  const out = new Set<string>();
  let sections: number[] | null = null;
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
export async function unwatchedBuckets(
  client: PlexClient,
  cfg: SelectCfg,
  binding: EngineBinding,
  // ACCEPTED AND IGNORED. `rotation.channelBuckets` forwards its `rng` here (the Python port
  // took one); nothing in this function is random. Declared so that call stays byte-identical.
  _rng?: Rng | null,
): Promise<Bucket[]> {
  const allowed = binding.allowed_ratings;
  const tok = await client.accountToken(binding.user_uuid);
  const watched = await watchedForSet(client, cfg, binding);
  const blocked = await expandedBlocklist(client, cfg, tok);
  const starts = cfg.starts || {};
  // Per-show weights for the rule pool, keyed the same way `starts` is (`section-<id>` for a
  // whole item bucket). Absent = 1 = one slot per round, i.e. today's behaviour.
  const weights = cfg.weights || {};
  // `restart` is the only value that DOES anything; absent/anything else means drop, which is
  // the behaviour every existing channel already has. Compared once rather than per show.
  const isRestarting = String(cfg.on_complete || '').toLowerCase() === 'restart';

  const buckets: Bucket[] = [];
  // Cast rather than `|| []`: a cfg with no `episodic_sections` has always thrown here, and a
  // silent empty pool would look like "nothing to watch" instead of a broken set.
  for (const show of await episodicShows(client, cfg.episodic_sections as readonly number[], allowed, blocked, tok)) {
    const allEps = await showEpisodes(client, show.ratingKey, tok);
    const start = starts[String(show.ratingKey)];
    const unwatched = allEps.filter((e) => !watched.has(e.ratingKey) && atOrAfterStart(e, start));
    // A show with nothing unwatched left is FINISHED. Historically it just vanished from the
    // pool (drop), which is still the default. `on_complete: restart` puts it back at its
    // start floor — the whole show, watched or not — so a refilling channel keeps a rotation
    // that would otherwise wither to nothing as the kids finish shows.
    //
    // Gated on `unwatched.length === 0`, i.e. the show is genuinely finished — NOT on this
    // window failing to draw from it. Those are different questions, and conflating them
    // would restart a show every top-up and starve everything else.
    const eps = unwatched.length || !isRestarting
      ? unwatched
      : allEps.filter((e) => atOrAfterStart(e, start));
    if (eps.length) {
      buckets.push({
        // `Bucket.show` is `string`; a library row without a title is a Plex fault, and the
        // original put the undefined straight into the bucket rather than inventing a name.
        show: show.title as string,
        ratingKey: show.ratingKey,
        episodes: eps,
        multi_season: multiSeason(allEps),
        weight: toWeight(weights[String(show.ratingKey)]),
      });
    }
  }
  for (const sec of cfg.item_sections || []) {
    const all = await sectionItems(client, [sec], allowed, blocked, tok);
    const unwatched = all.filter((it) => !watched.has(it.ratingKey));
    // Same finished-rule as a show, and this is the bucket that matters most for it: a
    // Shorts-only channel is ONE item bucket, so when its last unread short is watched the
    // channel has nothing at all rather than merely one fewer show. Under `restart` the whole
    // section comes back; under the default it drops and the channel is genuinely done.
    const items = (unwatched.length || !isRestarting ? unwatched : all)
      .map((it) => ({ ratingKey: it.ratingKey, title: it.title, show: 'Shorts', season: null, episode: null }));
    if (items.length) {
      buckets.push({
        show: 'Shorts',
        ratingKey: `section-${sec}`,
        episodes: items,
        weight: toWeight(weights[`section-${sec}`]),
      });
    }
  }
  return buckets;
}
