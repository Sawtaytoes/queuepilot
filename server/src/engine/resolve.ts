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
import { isUnweighted, toWeight, weightedShuffle } from './weight.js';
import { initialQueueSize, playbackLength } from './playbackLength.js';
import {
  BATCH_STOPS_AT, QUEUE_SERIES_DEFAULT, QUEUE_SERIES_LENGTH,
} from '../env.js';
import { QUEUES_PATH } from '../config.js';
import { isNodeError } from '../errors.js';
import type { Rng } from './weight.js';
import type { PlexClient, PlexMetadata, Start } from '../types.js';

// --------------------------------------------------------------------------- //
// The shapes this resolver produces. Local to the engine's curated read-side: none of them
// crosses the wire, and types.ts describes the API/session shapes instead.
// --------------------------------------------------------------------------- //

/**
 * A Plex auth token as this layer passes it around: null = the admin/default `X-Plex-Token`,
 * a string = a managed account's. `undefined` is admitted because `providers/plex.js` reads it
 * off an optional `BucketsContext` field — `PlexClient.container` treats undefined and null
 * identically (both select the admin corpus/token), so nothing here branches on the difference.
 */
type Token = string | null | undefined;

/** The cfg slice the curated resolver reads. Structural so a fixture cfg fits it too. */
type ResolveCfg = {
  queue_sections?: readonly number[] | null;
  queue_section?: number | undefined;
  episodic_sections?: readonly number[] | null;
  item_sections?: readonly number[] | null;
  include_specials?: unknown;
  batch_stops_at?: unknown;
  /**
   * The SET's default batch — how many items one entry contributes per visit when the entry
   * says nothing. Precedence is entry > set > env `QUEUE_SERIES_DEFAULT`, the same shape
   * `batchStop()` already uses for WHERE a batch may end.
   */
  episodes?: unknown;
  kind?: string | null;
  /** Playback length: how many ITEMS this set plays in one sitting. See engine/playbackLength. */
  length?: unknown;
  /** Legacy spelling of `length: infinite`; read, never written. */
  refill?: unknown;
  source?: unknown;
  behavior?: unknown;
  mode?: unknown;
};

/** A raw entry MAPPING off queues.yaml, before `describe()` coerces it. */
type RawEntryObject = {
  ratingKey?: unknown;
  collection?: unknown;
  title?: unknown;
  episodes?: unknown;
  start?: unknown;
  weight?: unknown;
  done?: unknown;
  /** Epoch seconds, written by `markDone` beside `done: true`; absent on a hand-marked entry. */
  done_at?: unknown;
  /** This entry's override of the set's `batch_stops_at` — see `EntryDescriptor`. */
  batch_stops_at?: unknown;
};

/** Anything the episode filters below probe. Both spellings of season/episode, because a raw
 * Plex leaf carries `parentIndex`/`index` and a resolved one carries `season`/`episode`. */
type EpisodeLike = {
  type?: unknown;
  extraType?: unknown;
  season?: unknown;
  parentIndex?: unknown;
  episode?: unknown;
  index?: unknown;
  duration?: unknown;
};

/** One entry normalized for resolution — the return of `describe()`. */
export interface EntryDescriptor {
  key: string | null;
  ratingKey: string | null;
  title: string | null;
  year: number | null;
  guid: string | null;
  collection: string | null;
  episodes: number | null;
  start: Start | null;
  weight: number;
  done: boolean;
  /**
   * The epoch-seconds stamp `markDone` writes beside `done: true`. Its ABSENCE (null) marks
   * an entry the owner tagged done BY HAND — a deliberate skip, which `nextQueue`'s
   * new-content revival leaves alone. Same coercion as `queues.entryDoneAt`.
   */
  doneAt: number | null;
  raw: unknown;
  /**
   * This entry's override of the set's `batch_stops_at` — WHERE its batch may stop. Carried
   * through RAW, exactly as the Python `_describe` did: `batchStop()` is the single place that
   * trims/lowercases and decides what is recognised, so a typo here still falls through to the
   * set's intent instead of being flattened to "off" on the way in.
   */
  batch_stops_at: unknown;
}

/**
 * A play item as the curated resolver builds it: `PoolItem` plus `member_key` — which collection
 * CHILD a leaf came from, for the batch-boundary cut.
 *
 * `show` is declared `string | undefined` to match `PlexPlayItem` (types.ts), which is what
 * `providers/plex.js buckets()` hands back to session.js. The movie branch of `resolveMember`
 * nevertheless writes a literal `show: null` on the wire; see the cast there.
 */
export interface ResolvedItem {
  ratingKey: string;
  title?: string;
  show?: string;
  season?: number | null;
  episode?: number | null;
  duration?: number;
  type?: string;
  extraType?: number;
  viewCount?: number;
  viewOffset?: number;
  member_key?: string;
}

/** One resolved member — `resolveMember()`'s return. Empty `items` = FINISHED, null = UNRESOLVED. */
export interface ResolvedMember {
  title: string;
  type: 'collection' | 'movie' | 'show';
  ratingKey?: string;
  items: ResolvedItem[];
  multi_season?: boolean;
  weight: number;
}

/** One batch in flight inside `nextQueue`. */
interface Batch {
  title: string;
  type: string;
  items: ResolvedItem[];
  weight: number;
}

/** What `buildReel()` / `nextQueue()` return — the same dict the Python `next_queue` returns. */
export interface QueueResult {
  set: string;
  play: ResolvedItem[];
  last: { title: string; type: string; ratingKey: string } | null;
  /**
   * The four key lists are `string[]`, matching `BucketsResult` (types.ts). Every descriptor
   * that reaches them came through `loadEntries()` / `memberDescs()`, which DROP a descriptor
   * whose `key` is null — so the `as string` casts at those pushes assert a filter that has
   * already run, rather than papering over a nullable value.
   */
  done: string[];
  unresolved: string[];
  remaining: number;
  offset: number;
  revived?: string[];
  newlyDone?: string[];
}

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
export function parseTitleString(text: unknown): { title: string; year: number | null; guid: string | null } {
  let s = String(text).trim();
  let guid: string | null = null;
  let m = GUID_RE.exec(s);
  if (m) {
    guid = m[1]!.trim();
    s = s.slice(0, m.index).replace(/\s+$/, '');
  }
  let year: number | null = null;
  m = YEAR_RE.exec(s);
  if (m) {
    year = parseInt(m[1]!, 10);
    s = s.slice(0, m.index).replace(/\s+$/, '');
  }
  return { title: s.trim(), year, guid };
}

// True if `value` is (or stringifies to) a bare numeric ratingKey. Port of _is_rating_key.
function isRatingKey(value: unknown): boolean {
  if (typeof value === 'boolean') return false;
  if (typeof value === 'number') return Number.isInteger(value);
  return typeof value === 'string' && /^\d+$/.test(value.trim());
}

const isObj = (e: unknown): e is RawEntryObject => e != null && typeof e === 'object' && !Array.isArray(e);

// Stable identity for a queue entry — MUST match queues.py entry_key (and server/src/queues.js
// entryKey). Port of entry_key.
export function entryKey(entry: unknown): string | null {
  if (isObj(entry)) {
    const rk = entry.ratingKey;
    if (rk != null) return `rk:${String(rk)}`;
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
export function describe(entry: unknown): EntryDescriptor {
  if (isObj(entry)) {
    const rk = entry.ratingKey;
    let coll: unknown = entry.collection;
    let title: string | null = null;
    let year: number | null = null;
    let guid: string | null = null;
    if (entry.title) ({ title, year, guid } = parseTitleString(entry.title));
    if (coll == null && title) {
      const cm = COLLECTION_RE.exec(title);
      if (cm) coll = cm[1]!.trim();
    }
    return {
      key: entryKey(entry),
      ratingKey: rk == null ? null : String(rk),
      title: title || null,
      year,
      guid,
      collection: coll ? String(coll).trim() : null,
      episodes: (entry.episodes ?? null) as number | null,
      // Per-entry override of the set's `batch_stops_at` ("none"|"member"|"season"): where this
      // entry's batch may stop. Lets one OVA collection roll straight through on a channel that
      // otherwise stops at season boundaries. Raw — batchStop() does the normalizing.
      batch_stops_at: entry.batch_stops_at ?? null,
      start: (entry.start ?? null) as Start | null,
      // How OFTEN this entry comes up when the set is randomized — slots per round, not a
      // probability. Absent = 1 (see select.js toWeight); only the shuffled paths read it.
      weight: toWeight(entry.weight),
      done: Boolean(entry.done),
      // The epoch-seconds stamp markDone writes beside `done: true`. Its ABSENCE is what
      // marks an entry the owner tagged done BY HAND (a deliberate skip) — nextQueue's
      // new-content revival leaves those alone. Same coercion as queues.entryDoneAt.
      doneAt: entry.done_at != null && Number.isFinite(Number(entry.done_at))
        ? Number(entry.done_at) : null,
      raw: entry,
    };
  }
  if (isRatingKey(entry)) {
    return {
      key: entryKey(entry), ratingKey: String(entry).trim(), title: null, year: null,
      guid: null, collection: null, episodes: null, batch_stops_at: null, start: null,
      weight: 1, done: false, doneAt: null, raw: entry,
    };
  }
  const { title, year, guid } = parseTitleString(entry);
  const cm = COLLECTION_RE.exec(title);
  const coll = cm ? cm[1]!.trim() : null;
  return {
    key: entryKey(entry), ratingKey: null, title: title || null, year, guid,
    collection: coll, episodes: null, batch_stops_at: null, start: null, weight: 1, done: false,
    doneAt: null, raw: entry,
  };
}

// Ordered resolution descriptors for a set, [] if the set/file is empty. Port of queues.entries
// (the read side only — the write-side lock/ruamel round-trip is D4's queues.py port).
export function loadEntries(setName: string): EntryDescriptor[] {
  let data: Record<string, unknown>;
  try {
    data = (parse(readFileSync(QUEUES_PATH, 'utf8')) as Record<string, unknown> | null) || {};
  } catch (e) {
    if (isNodeError(e) && e.code === 'ENOENT') return [];
    throw e;
  }
  const seq = ((data && data[setName]) || []) as unknown[];
  const out: EntryDescriptor[] = [];
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
export function isExtraOrPromo(ep: EpisodeLike | null | undefined): boolean {
  if (!ep) return false;
  if (ep.type === 'clip') return true;
  if (ep.extraType != null && ep.extraType !== '') return true;
  const season = ep.season != null ? ep.season : ep.parentIndex;
  if (String(season) === '0') {
    const raw = ep.episode != null ? ep.episode : ep.index;
    const idx = parseInt(String(raw), 10);
    if (Number.isFinite(idx) && idx >= S0_EXTRA_INDEX_MIN && idx <= S0_EXTRA_INDEX_MAX) return true;
  }
  return false;
}

// True if a show has any NON-special season (>= 1). Port of _has_real_seasons.
export function hasRealSeasons(allEps: readonly { season?: unknown }[]): boolean {
  return allEps.some((e) => !['0', 'None', ''].includes(String(e.season)));
}

// True if a leaf/item is RESUMABLE: started (viewOffset > 0) and NOT finished (viewCount < 1;
// a missing count is 0 via int0). Port of _in_progress.
export function inProgress(viewOffset: unknown, viewCount: unknown): boolean {
  return int0(viewOffset) > 0 && int0(viewCount) < 1;
}

// Drop extras, specials (unless opted in / specialsOk), and zero-duration items. Port of
// _keep_episode.
export function keepEpisode(
  ep: EpisodeLike,
  cfg: { include_specials?: unknown },
  specialsOk = false,
): boolean {
  if (isExtraOrPromo(ep)) return false;
  if (!cfg.include_specials && !specialsOk && String(ep.season) === '0') return false;
  if (!ep.duration) return false;
  return true;
}

// True if a `source-id` folder hint (`anidb-16172`) is in `guids` (`anidb://16172`). Split on
// the FIRST dash, case-insensitive. Port of _match_guid_hint.
function matchGuidHint(hint: string | null | undefined, guids: readonly unknown[]): boolean {
  if (!hint) return false;
  const i = hint.indexOf('-');
  if (i <= 0 || i >= hint.length - 1) return false;
  const want = `${hint.slice(0, i)}://${hint.slice(i + 1)}`.toLowerCase();
  return guids.some((g) => String(g || '').toLowerCase() === want);
}

// urllib.parse.quote(title) with the default safe="/" — space→%20, `/` kept, but `!*'()` escaped
// (encodeURIComponent leaves them). The sha1 corpus key is over the literal path, so this must
// match _resolve_title's Python quoting byte-for-byte.
function quote(s: unknown): string {
  return encodeURIComponent(String(s))
    .replace(/%2F/gi, '/')
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// --------------------------------------------------------------------------- //
// Title → ratingKey resolution — port of plex.py
// --------------------------------------------------------------------------- //
// (type, title) for a ratingKey — "movie"|"show" — or [null, null]. Port of item_type. (No
// cache — one container read per call; behaviourally identical, no stale state across clients.)
export async function itemType(
  client: PlexClient,
  ratingKey: string | number,
  token: Token,
): Promise<['movie' | 'show', string | undefined] | [null, null]> {
  let mc;
  try {
    mc = await client.container(`/library/metadata/${ratingKey}`, token);
  } catch {
    return [null, null];
  }
  const md = mc.Metadata || [];
  if (!md.length) return [null, null];
  const t = md[0]!.type;
  if (t !== 'movie' && t !== 'show') return [null, null];
  return [t, md[0]!.title];
}

// [viewOffset_ms, viewCount] for one item under `token`'s account, [0, 0] on any miss. Port of
// item_view_state.
async function itemViewState(
  client: PlexClient,
  ratingKey: string | number,
  token: Token,
): Promise<[number, number]> {
  let mc;
  try {
    mc = await client.container(`/library/metadata/${ratingKey}`, token);
  } catch {
    return [0, 0];
  }
  const md = mc.Metadata || [];
  if (!md.length) return [0, 0];
  return [int0(md[0]!.viewOffset), int0(md[0]!.viewCount)];
}

// Milliseconds to resume `ratingKey` at — its viewOffset when IN-PROGRESS, else 0. Port of
// resume_offset (the `watched` arg is deliberately not consulted; kept off the signature here).
async function resumeOffset(
  client: PlexClient,
  ratingKey: string | number,
  token: Token,
): Promise<number> {
  const [offset, count] = await itemViewState(client, ratingKey, token);
  return inProgress(offset, count) ? offset : 0;
}

// Resume offset (ms) for a resolved play ITEM, reusing its live state when present. Port of
// _head_resume_offset.
async function headResumeOffset(
  client: PlexClient,
  item: ResolvedItem,
  token: Token,
): Promise<number> {
  if (item.viewOffset != null) {
    return inProgress(item.viewOffset, item.viewCount) ? item.viewOffset : 0;
  }
  return await resumeOffset(client, item.ratingKey, token);
}

// Resolve a title string to [ratingKey, type, title] within a section, or [null, null, null].
// Port of _resolve_title (same scoring + lowest-ratingKey tie-break).
export async function resolveTitle(
  client: PlexClient,
  section: number | string,
  title: string,
  year: number | null,
  guid: string | null,
  token: Token,
): Promise<[string, 'movie' | 'show', string] | [null, null, null]> {
  const q = quote(title);
  let mc;
  try {
    mc = await client.container(
      `/library/sections/${section}/all?title=${q}&includeGuids=1&X-Plex-Container-Size=50`, token);
  } catch {
    return [null, null, null];
  }
  let best: [string, 'movie' | 'show', string] | null = null;
  let bestScore = 0;
  const tl = title.toLowerCase();
  for (const e of mc.Metadata || []) {
    const et = e.type;
    if (et !== 'movie' && et !== 'show') continue;
    const candTitle = e.title || '';
    const candYear = e.year;
    // `Guid` is not on `PlexMetadata`'s named fields (it arrives only with includeGuids=1).
    const guids = ((e.Guid as { id?: unknown }[] | undefined) || []).map((g) => g.id);
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
function resolveSections(cfg: ResolveCfg): readonly (number | undefined)[] {
  if (cfg.queue_sections && cfg.queue_sections.length) return cfg.queue_sections;
  const ss = setSections(cfg);
  if (ss.length) return ss;
  // `queue_section` is `secs[0]` in routing.ts, so it MAY be undefined — the last-resort list
  // therefore may hold one undefined, exactly as it did untyped. Consumers guard it.
  return [cfg.queue_section];
}

// Resolve one queue descriptor to [ratingKey, type, title]. Port of resolve_queue_entry.
export async function resolveQueueEntry(
  client: PlexClient,
  desc: EntryDescriptor,
  cfg: ResolveCfg,
  token: Token,
): Promise<[string, 'movie' | 'show', string | undefined] | [null, null, null]> {
  const rk = desc.ratingKey;
  if (rk) {
    const [typ, title] = await itemType(client, rk, token);
    if (typ == null) return [null, null, null];
    return [rk, typ, title];
  }
  const title = desc.title;
  if (!title) return [null, null, null];
  for (const sec of resolveSections(cfg)) {
    // `sec` may be undefined here (see resolveSections); the request was always built with
    // whatever it held, and Plex answering 404 is what the try/catch inside resolveTitle is for.
    const [rrk, typ, resolved] = await resolveTitle(client, sec as number, title, desc.year, desc.guid, token);
    if (typ != null) return [rrk, typ, resolved];
  }
  return [null, null, null];
}

// --------------------------------------------------------------------------- //
// Collections as ordered entries — port of plex.py
// --------------------------------------------------------------------------- //
// Index of the collection child a manual start names, or -1. Port of _start_member_index.
function startMemberIndex(children: readonly PlexMetadata[], start: Start | null | undefined): number {
  if (!start || start.series == null || start.series === '') return -1;
  const want = String(start.series).trim().toLowerCase();
  for (let i = 0; i < children.length; i += 1) {
    const ch = children[i]!;
    if (String(ch.ratingKey).trim().toLowerCase() === want) return i;
    if (String(ch.title || '').trim().toLowerCase() === want) return i;
  }
  return -1;
}

// Ordered playable items for a `Collection: <name>` entry, across the set's sections. Port of
// collection_items — None (null) = not found, [] = found but every child watched, [...] = items.
export async function collectionItems(
  client: PlexClient,
  cfg: ResolveCfg,
  name: string,
  watched: ReadonlySet<string>,
  token: Token,
  start: Start | null = null,
  resume = false,
): Promise<ResolvedItem[] | null> {
  let collRk: string | null = null;
  let children: PlexMetadata[] = [];
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
  const items: ResolvedItem[] = [];
  for (let i = 0; i < children.length; i += 1) {
    if (floorAt >= 0 && i < floorAt) continue;
    const ch = children[i]!;
    const rk = String(ch.ratingKey);
    if (ch.type === 'show') {
      const epStart = i === floorAt ? start : null;
      const childEps: ResolvedItem[] = await showEpisodes(client, rk, token);
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
function batchStop(
  desc: EntryDescriptor | null | undefined,
  cfg: ResolveCfg | null | undefined,
): string {
  // `desc?.` / `cfg?.` is the typed spelling of the original `(desc || {}).` — same three-level
  // precedence, same "an unrecognised value falls through to the next level".
  for (const raw of [desc?.batch_stops_at, cfg?.batch_stops_at, BATCH_STOPS_AT]) {
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
function segmentKey(item: ResolvedItem, stop: string): string {
  // The separator is a NUL (U+0000), not a space: a show title may contain spaces, and this
  // keeps two segments from colliding. Written as the ESCAPE `\0` rather than a raw NUL
  // byte in the source — the string is byte-identical, but a literal NUL made grep and rg
  // classify this whole file as BINARY and silently return nothing for every search of it.
  const member = item.member_key || item.show;
  return stop === 'season' ? `${member}\0${item.season}` : String(member);
}

/**
 * The SET's default batch — how many items one entry contributes when the entry itself says
 * nothing. Precedence: entry `episodes:` > set `episodes:` > env `QUEUE_SERIES_DEFAULT`.
 *
 * The same three-level shape `batchStop()` uses, and for the same reason: "one episode is no
 * big deal, but for Webtoons and Manga I'd prefer to default to 3 chapters — by choice for
 * this queue, and change it per-item if I have to" (owner, 2026-08-15). A global env knob
 * could not express that, because it is one number for a TV queue and a reading queue alike.
 *
 * An unusable value (0, negative, a typo) falls through to the env default rather than being
 * read as "no batch" — `applyBatch` treats a falsy batch as UNCAPPED, so a typo would have
 * dumped a whole series into one scan.
 */
function setBatch(cfg: ResolveCfg | null | undefined): number {
  const n = parseInt(String(cfg?.episodes ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, QUEUE_SERIES_LENGTH) : QUEUE_SERIES_DEFAULT;
}

// Cap `items` to `batch`, then cut at the first segment boundary if `stop` asks. Only ever
// SHORTENS, and never below one item — an empty list is the FINISHED signal nextQueue marks the
// entry done on, so a boundary cut that emptied a live batch would silently retire a show
// mid-run. The boundary applies only when a count cap is in force, so the rotation /
// member-bucket callers (no batch) keep the full ordered list their round-robin walks.
function applyBatch(items: ResolvedItem[], batch: unknown, stop: string): ResolvedItem[] {
  if (!batch) return items;
  const n = Math.max(1, Math.min(parseInt(String(batch), 10), QUEUE_SERIES_LENGTH));
  let out = items.slice(0, n);
  if (BATCH_STOPS.includes(stop) && out.length > 1) {
    const head = segmentKey(out[0]!, stop);
    let cut = 1;
    while (cut < out.length && segmentKey(out[cut]!, stop) === head) cut += 1;
    out = out.slice(0, cut);
  }
  return out;
}

// Resolve ONE member descriptor into a play batch. Port of resolve_member. Returns null when
// UNRESOLVED; otherwise {title, type, ratingKey?, items, multi_season?} (empty items = FINISHED).
// The count cap says how many; batchStop says where the batch may end (see batchStop above).
export async function resolveMember(
  client: PlexClient,
  desc: EntryDescriptor,
  cfg: ResolveCfg,
  watched: ReadonlySet<string>,
  token: Token,
  defaultBatch: number | null = null,
  resume = false,
): Promise<ResolvedMember | null> {
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
    return { title: `Collection: ${name}`, type: 'collection', items, weight: toWeight(desc.weight) };
  }
  const [rk, typ, title] = await resolveQueueEntry(client, desc, cfg, token);
  if (typ == null) return null;
  if (typ === 'movie') {
    let keepMovie = !watched.has(rk);
    if (!keepMovie && resume) keepMovie = inProgress(...await itemViewState(client, rk, token));
    const items: ResolvedItem[] = keepMovie
      // `show: null` is kept LITERALLY — the curated-parity oracle compares this JSON, and
      // `undefined` would drop the key entirely. The cast is only how `PlexPlayItem`'s
      // `show?: string` (types.ts) is satisfied without changing what is emitted.
      ? [{ title, ratingKey: rk, show: null as unknown as undefined, season: null, episode: null }] : [];
    // `title` comes back from Plex and is `string | undefined`; the original stored it as-is.
    return { title: title as string, type: 'movie', ratingKey: rk, items, weight: toWeight(desc.weight) };
  }
  const allEps: ResolvedItem[] = await showEpisodes(client, rk, token);
  const start = desc.start;
  const specialsOk = resume && !hasRealSeasons(allEps);
  let eps = allEps.filter((e) => (!watched.has(e.ratingKey)
    || (resume && inProgress(e.viewOffset, e.viewCount)))
    && keepEpisode(e, cfg, specialsOk) && atOrAfterStart(e, start));
  // A `season` stop also cuts at a season boundary, so `episodes: 2` on a show sitting at its
  // finale queues S1E12 alone instead of S1E12 + S2E01.
  eps = applyBatch(eps, desc.episodes || defaultBatch, batchStop(desc, cfg));
  return {
    title: title as string, type: 'show', ratingKey: rk, items: eps, multi_season: multiSeason(allEps),
    weight: toWeight(desc.weight),
  };
}

// --------------------------------------------------------------------------- //
// Play-list builders — port of plex.py
// --------------------------------------------------------------------------- //
const emptyResult = (setName: string): QueueResult => ({
  set: setName, play: [], last: null, done: [], unresolved: [], remaining: 0, offset: 0,
});

// Resolve a REEL set to an ORDERED play list, ignoring watched-state entirely (file order IS the
// play order; nothing is ever finished). Port of build_reel.
export async function buildReel(
  client: PlexClient,
  setName: string,
  cfg: ResolveCfg,
  entries: readonly EntryDescriptor[],
  token: Token,
  limit = 60,
): Promise<QueueResult> {
  if (!entries.length) return emptyResult(setName);
  const play: ResolvedItem[] = [];
  const unresolved: string[] = [];
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
      unresolved.push((desc.ratingKey || desc.title || desc.key) as string);
      continue;
    }
    if (typ === 'movie') {
      play.push({ title, ratingKey: rk });
    } else {
      const eps = await showEpisodes(client, rk, token);
      const batch = Math.max(1, Math.min(parseInt(String(desc.episodes || QUEUE_SERIES_DEFAULT), 10),
        QUEUE_SERIES_LENGTH));
      for (const e of eps.slice(0, batch)) play.push({ title: e.title || title, ratingKey: e.ratingKey });
    }
  }
  const last = play.length
    ? { title: play[0]!.title as string, type: 'movie', ratingKey: play[0]!.ratingKey } : null;
  return { set: setName, play, last, done: [], unresolved, remaining: play.length, offset: 0 };
}

// The DETERMINISTIC classify+order core of next_queue: resolve each entry, split finished /
// unresolved / active, then pick the play items (a QUEUE plays the first active batch; an anime
// CHANNEL hoists in-progress members then shuffles the rest via the injected `rng`). Port of
// next_queue MINUS its YAML side effects (mark_done / clear_done / sweep_completed → D4). The
// returned dict matches next_queue's; parity covers the non-anime queue path (the shuffle is rng).
export async function nextQueue(
  client: PlexClient,
  setName: string,
  cfg: ResolveCfg,
  entries: readonly EntryDescriptor[],
  watched: ReadonlySet<string>,
  token: Token,
  rng: Rng | null = null,
): Promise<QueueResult> {
  if (!entries.length) return emptyResult(setName);
  const newlyDone: string[] = [];
  const doneFlagged: string[] = [];
  const unresolved: string[] = [];
  const revived: string[] = [];
  let remaining = 0;
  const batches: Batch[] = [];
  for (const desc of entries) {
    const res = await resolveMember(client, desc, cfg, watched, token, setBatch(cfg), true);
    if (desc.done) {
      // Stale-done recovery. An entry is marked done when its live resolution comes back
      // EMPTY, so anything still playable in it means the flag no longer describes reality —
      // revive it and clear the flag (session.js). Two ways that happens:
      //
      //   * the head is mid-playback (the Prison School OAD — decision
      //     2026-08-07-in-progress-queue-items-are-never-finished), or
      //   * new content landed after the entry finished: the next season/episode of a show,
      //     a new member in a collection. Without this the entry stays done and skipped
      //     FOREVER — nothing else ever clears the flag, and the TTL sweep defaults to
      //     `never` — so a returning show silently never plays again.
      //
      // A HAND-marked `done: true` (no `done_at`, so the owner wrote it, not markDone) is a
      // deliberate skip and is only ever revived by the in-progress case: actually watching
      // something outranks the skip, merely having an unwatched episode does not.
      const head = res && res.items && res.items.length ? res.items[0] : null;
      // `head != null` rather than upstream's `Boolean(head)`: identical at runtime (a
      // resolved item is always an object), and it is what NARROWS `head` for the
      // `headResumeOffset` call in the same `&&` chain, which `Boolean()` does not.
      const isRevived = head != null
        && (desc.doneAt != null || await headResumeOffset(client, head, token) > 0);
      if (isRevived) {
        revived.push(desc.key as string);
        remaining += 1;
        // `head` is non-null only when `res` was, so the assertions add no branch.
        batches.push({ title: res!.title, type: res!.type, items: res!.items, weight: res!.weight });
      } else {
        doneFlagged.push((desc.title || desc.ratingKey || desc.key) as string);
      }
      continue;
    }
    remaining += 1;
    if (res == null) {
      unresolved.push((desc.collection ? `Collection: ${desc.collection}`
        : desc.ratingKey || desc.title || desc.key) as string);
      continue;
    }
    if (!res.items.length) {
      newlyDone.push(desc.key as string);
      doneFlagged.push(res.title);
      remaining -= 1;
      continue;
    }
    batches.push({ title: res.title, type: res.type, items: res.items, weight: res.weight });
  }

  const leadsInProgress = (b: Batch): boolean => {
    const it = b.items.length ? b.items[0] : null;
    return Boolean(it && inProgress(it.viewOffset, it.viewCount));
  };

  let playItems: ResolvedItem[];
  let leadBatch: Batch | null;
  if (cfg.kind === 'anime') {
    // Channel: member order is irrelevant AND shuffled — but an in-progress member LEADS so it
    // resumes. Hoist in-progress batches (file order among them), shuffle the rest via `rng`.
    const lead = batches.filter(leadsInProgress);
    const rest = batches.filter((b) => !leadsInProgress(b));
    // A channel plays each member ONCE per scan and gets cut at ROTATION_LENGTH, so "comes up
    // more often" here means "lands near the front more often": a weighted shuffle, not the
    // slots-per-round interleave the rotation channels use (they replay a member across rounds;
    // this path does not). With nothing weighted, the plain Fisher–Yates shuffle runs unchanged
    // — same rng, same sequence — so an unweighted channel's seeded order is untouched.
    if (isUnweighted(rest)) {
      if (rng) rng.shuffle(rest);
    } else {
      weightedShuffle(rest, rng);
    }
    const ordered = lead.concat(rest);
    // The SET's own playback length, not a hardcoded env window. A curated pool read
    // ROTATION_LENGTH directly and so was the one kind of set whose length could never be
    // configured — invisible, because 12 is also what a filtered pool defaults to.
    const cap = initialQueueSize(playbackLength(cfg));
    playItems = [];
    for (const b of ordered) {
      playItems.push(...b.items.slice(0, cap - playItems.length));
      if (playItems.length >= cap) break;
    }
    leadBatch = ordered.length ? ordered[0]! : null;
  } else {
    // An ordered queue played `batches[0]` and stopped — its head ENTRY, whole.
    //
    // So this is the one path that counts ENTRIES rather than items, and it has to be: a show
    // entry's batch is already its own knob (`episodes:`), and capping items here at 1 would
    // silently truncate a 2-episode entry to one episode — which is what the first cut of this
    // did, and what `resume-in-queue-test` caught. "Playback Length 1" on an ordered queue
    // means the entry at the top, whole; on a rule-based pool, where there are no entries to
    // count, it means one item.
    const cap = initialQueueSize(playbackLength(cfg));
    playItems = [];
    for (const b of batches.slice(0, cap)) playItems.push(...b.items);
    leadBatch = batches.length ? batches[0]! : null;
  }
  // A non-empty `playItems` implies a `leadBatch`, as it always did.
  const last = playItems.length
    ? { title: leadBatch!.title, type: leadBatch!.type, ratingKey: playItems[0]!.ratingKey } : null;
  const offset = playItems.length ? await headResumeOffset(client, playItems[0]!, token) : 0;
  return {
    set: setName, play: playItems, last, done: doneFlagged, unresolved, remaining, offset, revived,
    newlyDone, // D4: keys for queues.markDone (not in the Python JSON oracle shape)
  };
}
