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
import { setSections } from './routing.js';
import {
  int0, multiSeason, showEpisodes, findCollection, collectionChildren,
} from './select.js';
import { isUnweighted, toWeight, weightedShuffle } from './weight.js';
import { initialQueueSize, playbackLength } from './playbackLength.js';
import {
  isExplicitPlacement, isRandomOrder, normalizeAddAs, normalizeLead, normalizePlacement,
} from '../kind.js';
import { DEFAULT_PROMOTE_WINDOW_MS, parsePromoteWindow } from '../leadWindow.js';
import { episodesAtOrAfterStart, orderedPlayableEpisodes } from '../episodeOrder.js';
import {
  BATCH_STOPS_AT, QUEUE_SERIES_DEFAULT, QUEUE_SERIES_LENGTH,
} from '../env.js';
import { store } from '../store/index.js';
import { duplicateEntryMessage, entryIdOf, legacyEntryMessage } from '../entryFormat.js';
import { normalizeEntryItemOrder } from '../entryItemOrder.js';
import { isNodeError } from '../errors.js';
import { normalizeWatchHistory } from '../watchHistory.js';
import type { Rng } from './weight.js';
import type { End, PlexClient, PlexMetadata, Start } from '../types.js';

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

/** The cfg slice the curated resolver reads. Structural so a fixture cfg fits it too.
 *
 * EXPORTED because `entryIdentity.ts` asks this resolver the same question the engine does —
 * "which item does this entry name?" — and must be able to name the parameter it passes. */
export type ResolveCfg = {
  queue_sections?: readonly number[] | null;
  queue_section?: number | undefined;
  episodic_sections?: readonly number[] | null;
  item_sections?: readonly number[] | null;
  include_specials?: unknown;
  included_specials?: readonly unknown[] | null;
  batch_stops_at?: unknown;
  /**
   * The SET's default batch — how many items one entry contributes per visit when the entry
   * says nothing. Precedence is entry > set > env `QUEUE_SERIES_DEFAULT`, the same shape
   * `batchStop()` already uses for WHERE a batch may end.
   */
  episodes?: unknown;
  /**
   * The items this queue SKIPS — a flat list of ratingKeys the resolver drops on the way past,
   * whatever else says they should play. The curated twin of a filtered pool's `blocklist`,
   * and deliberately the same shape: it lives on the SET, and it is permanent until the owner
   * clears it (decision `2026-08-22-a-curated-queue-skips-items-the-way-a-filtered-pool-blocks-them`).
   *
   * It addresses the LEAF — the thing that plays. On a show entry that is one episode; on a
   * `{collection: X}` entry it is one child (a movie, or a whole child show). It is NOT how a
   * member is retired — an entry you no longer want is REMOVED — but a skipped item DOES
   * count towards the entry being finished, the same way a watched one does: skip the last
   * episode a show has left and the show is over.
   */
  skipped?: readonly unknown[] | null;
  kind?: string | null;
  /** The set's DEFAULT lane for entries that name none — `priority` | `random`. See
   *  `kind.normalizeAddAs`, which tolerates the pre-migration `movies` / `anime` spellings. */
  add_as?: unknown;
  /** The set's default lead cooldown (`24h`, `7d`, …) for a promoted entry. */
  promote_window?: unknown;
  /** Playback length: how many ITEMS this set plays in one sitting. See engine/playbackLength. */
  length?: unknown;
  /** Legacy spelling of `length: infinite`; read, never written. */
  refill?: unknown;
  /** The queue's default history source. Absent means provider. */
  watch_history?: unknown;
  source?: unknown;
  behavior?: unknown;
  mode?: unknown;
};

/** A raw entry MAPPING off queues.yaml, before `describe()` coerces it. */
type RawEntryObject = {
  /** The optional opaque line id — `entryKey()`'s first branch. See `EntryExtras.id`. */
  id?: unknown;
  ratingKey?: unknown;
  collection?: unknown;
  title?: unknown;
  episodes?: unknown;
  item_order?: unknown;
  start?: unknown;
  /** Where the first played unit STOPS — see `EntryDescriptor.end`. */
  end?: unknown;
  watch_history?: unknown;
  weight?: unknown;
  done?: unknown;
  /** Epoch seconds, written by `markDone` beside `done: true`; absent on a hand-marked entry. */
  done_at?: unknown;
  /** This entry's override of the set's `batch_stops_at` — see `EntryDescriptor`. */
  batch_stops_at?: unknown;
  /** Which LANE of a Picks queue this entry is in — see `EntryDescriptor.placement`. */
  placement?: unknown;
  /** How often a Priority entry leads — see `EntryDescriptor.lead`. */
  lead?: unknown;
  /** This entry's override of the set's lead cooldown — see `EntryDescriptor.promoteWindow`. */
  promote_window?: unknown;
  collection_order?: unknown;
};

/** Anything the episode filters below probe. Both spellings of season/episode, because a raw
 * Plex leaf carries `parentIndex`/`index` and a resolved one carries `season`/`episode`. */
type EpisodeLike = {
  ratingKey?: unknown;
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
  /** Item order inside this show or Collection. `shuffle` includes watched items. */
  itemOrder: 'in-order' | 'shuffle';
  start: Start | null;
  /**
   * Where this entry's first played unit STOPS, the mirror of `start.position_ms`. Null on
   * every entry that plays to the end of its unit, which is all of them written before
   * 2026-09-01 (decision
   * `2026-09-01-a-start-point-carries-a-position-and-end-is-its-mirror`).
   *
   * Carried through the way `start` is — the stored mapping, not a re-derived number — so the
   * key it may grow later ("stop after season 2 episode 6") arrives here for free.
   */
  end: End | null;
  /** Per-entry override. `start.history` remains the compatibility read. */
  watchHistory: 'provider' | 'queue' | null;
  /** Custom collection member order. Empty means follow Plex. */
  collectionOrder: string[];
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
  /**
   * Which LANE of a Picks queue this entry is in — `priority`, `random`, or null for
   * "follow the set's `add_as`". Carried RAW for the same reason `batch_stops_at` is:
   * `kind.normalizePlacement()` is the one place that decides what a value means, so a
   * typo falls through to the set default instead of being flattened on the way in
   * (decision `2026-08-23-kind-is-picks-or-rules` §2).
   */
  placement: unknown;
  /** `once` | `always` | null — how often this entry may LEAD, when it is in the Priority
   *  lane. Null follows `kind.normalizeLead()`, whose default depends on whether the lane
   *  was inherited or promoted. */
  lead: unknown;
  /** This entry's override of the set's lead cooldown (`24h`, `7d`, …). Null follows the
   *  set, then `promote.DEFAULT_PROMOTE_WINDOW_MS`. */
  promoteWindow: unknown;
  /**
   * TRUE when this descriptor came from a bare SCALAR — the legacy entry form.
   *
   * `describe()` still parses one, because `entryKey()` still keys one and because a
   * sets.yaml `members:` list is a different list with a different rule. What changed is
   * `loadEntries()`: a legacy descriptor is REFUSED there by name and never reaches the
   * resolver, so a stale hand-typed line stops one entry rather than a whole file
   * (decision `2026-08-21-a-queue-entry-is-an-object-and-carries-its-rating-key`).
   */
  legacy: boolean;
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
  /** Internal attribution for queue-owned progress. Never sent to Plex. */
  queueEntryKey?: string;
  /** True when completion belongs to QueuePilot's private ledger, not provider history. */
  queueOwnHistory?: boolean;
  /** Queue-owned resume point in milliseconds. It outranks the shared provider offset. */
  queueResumeOffset?: number;
  /** Provider play count before this queue-owned replay starts. Completion increments it. */
  queueProviderViewCount?: number;
  /**
   * Where this item's playback BEGINS, from the entry's `start.position_ms`. Stamped on the
   * FIRST unit an entry contributes and on nothing else — see `sectionOf()`.
   */
  sectionStartMs?: number | null;
  /** Where it STOPS, from the entry's `end.position_ms`. Same first-unit rule. */
  sectionEndMs?: number | null;
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
  /** The entry this batch came from. The LANE split reads `placement` / `lead` off it, and
   *  the lead ledger is keyed by `key`. Absent on nothing — every batch has an entry. */
  desc: EntryDescriptor;
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
  /**
   * The `lead: once` entry keys that LED this lineup, so the caller can stamp their cooldown
   * once playback actually starts.
   *
   * Deliberately NOT stamped in here: this function is called to BUILD a lineup, and several
   * callers (the preview endpoint, a profile gate that then fails, a cancelled scan) build one
   * that never plays. Stamping at resolve time would burn a 24h window on a sitting nobody
   * watched (decision `2026-08-26-the-lead-window-is-stamped-when-playback-starts`).
   */
  led?: string[];
  /** Priority entries held back by an unexpired lead window, as `key` strings. */
  suppressed?: string[];
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

// Stable identity for one LINE of a queue — the READ side's copy.
//
// MUST agree with its twin in `server/src/queues.ts`, which is the write side. The two are
// separate on purpose (the engine does not import the YAML write-side; that would put a cycle
// through `sets.ts` and the provider registry), so `e2e/play-one-entry-test.ts` asserts they
// answer alike. Change one, change the other in the same commit.
//
//     id:<opaque>   when the mapping carries a non-empty id
//     rk:<n>        otherwise, when it carries a ratingKey
//     title:<text>  otherwise
//
// The `id:` branch arrived 2026-09-01 so one queue can hold the same file more than once. It is
// FIRST and it is additive: an entry that carries no id keys exactly as it did before, byte for
// byte ([decision] docs/decisions/2026-09-01-an-entry-can-carry-an-id-so-one-file-can-hold-two-lines.md).
export function entryKey(entry: unknown): string | null {
  if (isObj(entry)) {
    const id = entryIdOf(entry);
    if (id) return `id:${id}`;
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
      itemOrder: normalizeEntryItemOrder(entry.item_order),
      // Per-entry override of the set's `batch_stops_at` ("none"|"member"|"season"): where this
      // entry's batch may stop. Lets one OVA collection roll straight through on a channel that
      // otherwise stops at season boundaries. Raw — batchStop() does the normalizing.
      batch_stops_at: entry.batch_stops_at ?? null,
      // The lane knobs, raw. `placement` decides WHICH lane; `lead` + `promote_window`
      // only mean anything inside the Priority one.
      placement: entry.placement ?? null,
      lead: entry.lead ?? null,
      promoteWindow: entry.promote_window ?? null,
      start: (entry.start ?? null) as Start | null,
      end: (entry.end ?? null) as End | null,
      watchHistory: normalizeWatchHistory(entry.watch_history)
        ?? normalizeWatchHistory((entry.start as Start | null | undefined)?.history),
      collectionOrder: Array.isArray(entry.collection_order)
        ? [...new Set(entry.collection_order.map(String).filter(Boolean))]
        : [],
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
      legacy: false,
    };
  }
  if (isRatingKey(entry)) {
    return {
      key: entryKey(entry), ratingKey: String(entry).trim(), title: null, year: null,
      guid: null, collection: null, episodes: null, batch_stops_at: null, start: null,
      end: null,
      watchHistory: null,
      itemOrder: 'in-order',
      collectionOrder: [],
      placement: null, lead: null, promoteWindow: null,
      weight: 1, done: false, doneAt: null, raw: entry, legacy: true,
    };
  }
  const { title, year, guid } = parseTitleString(entry);
  const cm = COLLECTION_RE.exec(title);
  const coll = cm ? cm[1]!.trim() : null;
  return {
    key: entryKey(entry), ratingKey: null, title: title || null, year, guid,
    collection: coll, episodes: null, batch_stops_at: null, start: null, end: null,
    collectionOrder: [],
    watchHistory: null,
    itemOrder: 'in-order',
    placement: null, lead: null, promoteWindow: null, weight: 1, done: false,
    doneAt: null, raw: entry, legacy: true,
  };
}

/**
 * Refused-entry complaints already logged, as `<set>[<index>] <raw>`.
 *
 * `loadEntries()` runs on every scan and on several request paths, so an unguarded log line
 * would repeat a broken entry into the container log for ever. One line per distinct entry
 * per process is enough to find it; a restart says it again, which is correct — it is still
 * broken. Both refusals below share the Set — a legacy scalar and a duplicate key are the
 * same kind of fault and deserve the same one line.
 */
const complained = new Set<string>();

/** Say a refusal ONCE per distinct entry per process, then drop the entry. */
function complainOnce(setName: string, index: number, entry: unknown, message: string): void {
  const once = `${setName}[${index}] ${JSON.stringify(entry)}`;
  if (complained.has(once)) return;
  complained.add(once);
  console.log(`[queues] ${message}`);
}

// Ordered resolution descriptors for a set, [] if the set/file is empty. The READ side of the
// queue file; the lock and the comment-preserving round-trip are `queues.ts`'s.
//
// THE FORMAT GATE LIVES HERE (2026-08-21). A bare-string entry is refused BY NAME and does not
// become a descriptor, so nothing plays it. The refusal is per ENTRY and never per file: this
// app runs unattended on the household TV, and one stale hand-typed line must not take a whole
// queue — let alone every queue — off the air. The entry stays in the file, stays visible in
// the editor and stays addressable by its key, so it can be fixed or deleted.
//
// THE KEY GATE JOINED IT (2026-09-01), under exactly that doctrine. A key names ONE line, and
// an `id` is how a second line for the same item says which one it is. A hand edit can still
// write two lines that key alike — typing a second `start.position_ms` into `queues.yaml` over
// SMB is the case that motivates the feature — and there is no honest answer to "which line is
// `rk:1001`?" once it has. So the SECOND and later line is refused by name, the FIRST one plays,
// and the queue around them is untouched. Everything downstream then keeps the invariant it was
// written against: the first-match setters, the all-match removers, `queue_entry_history`,
// `lead_cooldown`, and every `?only=<key>` URL
// ([decision] docs/decisions/2026-09-01-an-entry-can-carry-an-id-so-one-file-can-hold-two-lines.md).
export function loadEntries(setName: string): EntryDescriptor[] {
  let data: Record<string, unknown>;
  try {
    // The store reads the file and THROWS; "an absent file means no entries" is this
    // module's policy, and stays here.
    data = (store.queues.readSync() as Record<string, unknown> | null) || {};
  } catch (e) {
    if (isNodeError(e) && e.code === 'ENOENT') return [];
    throw e;
  }
  const seq = ((data && data[setName]) || []) as unknown[];
  const out: EntryDescriptor[] = [];
  const seen = new Set<string>();
  seq.forEach((e, index) => {
    const desc = describe(e);
    if (desc.key == null) return;
    if (desc.legacy) {
      complainOnce(setName, index, e, legacyEntryMessage(setName, index, e));
      return;
    }
    if (seen.has(desc.key)) {
      // `entryIdOf` is not consulted: an entry that carries an id keys as `id:<opaque>`, so it
      // can only land here by repeating another line's id, which is the same fault.
      complainOnce(setName, index, e, duplicateEntryMessage(setName, index, e, desc.key));
      return;
    }
    seen.add(desc.key);
    out.push(desc);
  });
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

/**
 * The set's `skipped` list as a lookup, keyed the way every ratingKey in this module is —
 * `String()`, because a YAML `- 12345` parses as a number.
 *
 * Built per resolve rather than memoized: the list is a handful of keys and a resolve already
 * costs a Plex fan-out, so a cache here would only be a way for a cleared skip to keep
 * applying.
 */
export function skippedKeys(cfg: { skipped?: readonly unknown[] | null }): ReadonlySet<string> {
  return new Set((cfg.skipped || []).map(String));
}

// Drop extras, specials (unless opted in / specialsOk), and zero-duration items. Port of
// _keep_episode.
export function keepEpisode(
  ep: EpisodeLike,
  cfg: { include_specials?: unknown; included_specials?: readonly unknown[] | null },
  specialsOk = false,
): boolean {
  if (isExtraOrPromo(ep)) return false;
  const isIncluded = new Set((cfg.included_specials || []).map(String)).has(String(ep.ratingKey));
  if (!cfg.include_specials && !isIncluded && !specialsOk && String(ep.season) === '0') return false;
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
  if (item.queueOwnHistory) return Math.max(0, Number(item.queueResumeOffset) || 0);
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
//
// EXPORTED for `pending.ts`, whose cheap pre-filter must scope a title entry to exactly the
// sections THIS function would search. `routing.setSections()` is not the same list — it drops
// the `queue_sections` override — and a pre-filter over the wrong sections would silently skip
// a resolution the engine would have made.
export function resolveSections(cfg: ResolveCfg): readonly (number | undefined)[] {
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
  collectionOrder: readonly string[] = [],
  includeWatched = false,
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
  children = orderCollectionChildren(children, collectionOrder);
  const floorAt = startMemberIndex(children, start);
  const skipped = skippedKeys(cfg);
  const items: ResolvedItem[] = [];
  for (let i = 0; i < children.length; i += 1) {
    if (floorAt >= 0 && i < floorAt) continue;
    const ch = children[i]!;
    const rk = String(ch.ratingKey);
    // A skipped CHILD goes whole — the film, or the whole child show. The collection is the
    // member here; its children are the items inside it, which is exactly what `skipped`
    // addresses. A child show's individual episodes are skippable too, in the loop below.
    if (skipped.has(rk)) continue;
    if (ch.type === 'show') {
      const epStart = i === floorAt ? start : null;
      const childEps: ResolvedItem[] = await showEpisodes(client, rk, token);
      const ordered = episodesAtOrAfterStart(
        orderedPlayableEpisodes(childEps, cfg, resume),
        epStart,
      );
      for (const e of ordered) {
        if (skipped.has(e.ratingKey)) continue;
        if (includeWatched
          || !watched.has(e.ratingKey)
          || (resume && inProgress(e.viewOffset, e.viewCount))
        ) {
          // Which collection CHILD this leaf came from, so a `batch_stops_at` cut can see the
          // member boundary (segmentKey). showEpisodes builds fresh objects per call, so
          // tagging in place is local to this resolve.
          e.member_key = rk;
          items.push(e);
        }
      }
    } else {
      const [viewOffset, viewCount] = resume || includeWatched
        ? await itemViewState(client, rk, token)
        : [int0(ch.viewOffset), int0(ch.viewCount)];
      if (!includeWatched && watched.has(rk)
        && !(resume && inProgress(viewOffset, viewCount))) continue;
      items.push({
        ratingKey: rk, title: ch.title, show: ch.grandparentTitle || name,
        // Its OWN member_key: `show` is the collection name for a movie member, so keying a
        // boundary on that would fuse every movie in the collection into one segment.
        member_key: rk,
        season: ch.parentIndex, episode: ch.index, duration: ch.duration,
        ...(includeWatched ? { viewOffset, viewCount } : {}),
      });
    }
  }
  return items;
}

/** Put named members first in the stored order, then append new Plex members in Plex order. */
export function orderCollectionChildren<T extends { ratingKey?: unknown }>(
  children: readonly T[],
  order: readonly string[] = [],
): T[] {
  if (!order.length) return [...children];
  const rank = new Map(order.map((key, index) => [String(key), index]));
  return children
    .map((child, plexIndex) => ({ child, plexIndex, rank: rank.get(String(child.ratingKey)) }))
    .sort((a, b) => (a.rank ?? order.length + a.plexIndex) - (b.rank ?? order.length + b.plexIndex))
    .map(({ child }) => child);
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

type EntryProgress = ReadonlyMap<string, { isCompleted: boolean; positionMs: number }>;

/**
 * Shuffle one entry's leaves without replacement, while keeping its one active resume point
 * first. A queue-owned resume outranks the provider's viewOffset because that is the progress
 * source the entry explicitly selected.
 */
function shuffleEntryItems(
  items: ResolvedItem[],
  rng: Rng | null,
  progress: EntryProgress | null,
): ResolvedItem[] {
  const resumeIndex = items.findIndex((item) => {
    const own = progress?.get(String(item.ratingKey));
    if (own) return !own.isCompleted && own.positionMs > 0;
    return inProgress(item.viewOffset, item.viewCount);
  });
  const head = resumeIndex >= 0 ? items[resumeIndex]! : null;
  const rest = items.filter((_, index) => index !== resumeIndex);
  if (rng) rng.shuffle(rest);
  return head ? [head, ...rest] : rest;
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
  rng: Rng | null = null,
  progress: EntryProgress | null = null,
): Promise<ResolvedMember | null> {
  const skipped = skippedKeys(cfg);
  const isShuffled = desc.itemOrder === 'shuffle';
  if (desc.collection) {
    const name = desc.collection;
    let items = await collectionItems(
      client, cfg, name, watched, token, desc.start, resume, desc.collectionOrder, isShuffled,
    );
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
    if (isShuffled) items = shuffleEntryItems(items, rng, progress);
    items = applyBatch(
      items,
      desc.episodes || defaultBatch,
      isShuffled ? 'none' : batchStop(desc, cfg),
    );
    return { title: `Collection: ${name}`, type: 'collection', items, weight: toWeight(desc.weight) };
  }
  const [rk, typ, title] = await resolveQueueEntry(client, desc, cfg, token);
  if (typ == null) return null;
  if (typ === 'movie') {
    // NOT skippable. A movie entry IS its own member — there is nothing inside it to skip —
    // and the way to stop one is to remove it from the queue. Skipping it instead would put
    // an entry in the file that can never play and says nothing about why, which is the state
    // `skipped` exists to avoid. The tile agrees: a movie has no next-up leaf, so the grid
    // offers Remove there and Skip only where there is an item inside a member.
    let keepMovie = !watched.has(rk);
    if (!keepMovie && resume) {
      const own = progress?.get(String(rk));
      keepMovie = progress
        ? Boolean(own && !own.isCompleted && own.positionMs > 0)
        : inProgress(...await itemViewState(client, rk, token));
    }
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
  let eps = episodesAtOrAfterStart(orderedPlayableEpisodes(allEps, cfg, resume), start);
  if (!isShuffled) {
    eps = eps.filter((e) => !watched.has(e.ratingKey)
      || (resume && (progress
        ? Boolean(progress.get(String(e.ratingKey))?.positionMs)
        : inProgress(e.viewOffset, e.viewCount))));
  }
  // The SKIP list, applied to what is left after the watched/specials/start filters and BEFORE
  // the batch cap — so skipping E5 makes an `episodes: 2` entry queue E6 + E7, not E6 alone.
  eps = eps.filter((e) => !skipped.has(e.ratingKey));
  if (isShuffled) eps = shuffleEntryItems(eps, rng, progress);
  // A `season` stop also cuts at a season boundary, so `episodes: 2` on a show sitting at its
  // finale queues S1E12 alone instead of S1E12 + S2E01.
  eps = applyBatch(
    eps,
    desc.episodes || defaultBatch,
    isShuffled ? 'none' : batchStop(desc, cfg),
  );
  return {
    title: title as string, type: 'show', ratingKey: rk, items: eps, multi_season: multiSeason(allEps),
    weight: toWeight(desc.weight),
  };
}

// --------------------------------------------------------------------------- //
// Play-list builders — port of plex.py
// --------------------------------------------------------------------------- //

/**
 * This entry's section window, or null when it names none.
 *
 * ⚠️ THE WINDOW APPLIES TO THE FIRST PLAYED UNIT ONLY. An entry contributing three episodes
 * per visit takes the offsets on episode one; episodes two and three play in full. That is
 * not a simplification — it is the only reading that serves both asks the feature came from:
 * "start season 2 episode 4 at 12:30" means THAT episode, and a film section is one unit by
 * construction. An entry wanting three separately-windowed sections is three entries, which
 * is what the `id:` key from #300 exists to allow
 * (decision `2026-09-01-a-start-point-carries-a-position-and-end-is-its-mirror`).
 *
 * So the two callers below both stamp exactly one item — `items[0]` of what the entry
 * contributed — and this function returns the fields rather than applying them, so neither
 * caller can quietly stamp a second one.
 */
export function sectionOf(desc: EntryDescriptor): {
  sectionStartMs: number | null;
  sectionEndMs: number | null;
} | null {
  const sectionStartMs = desc.start?.position_ms ?? null;
  const sectionEndMs = desc.end?.position_ms ?? null;
  if (sectionStartMs == null && sectionEndMs == null) return null;
  return { sectionStartMs, sectionEndMs };
}

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
  // A reel ignores WATCHED state — it replays in full every scan — but `skipped` is not watched
  // state. It says "never play this", and a reel is exactly the set where that would otherwise
  // come back around every single time.
  const skipped = skippedKeys(cfg);
  for (const desc of entries) {
    if (play.length >= limit) break;
    if (desc.done) continue; // a hand-tagged skip is still honored
    // Where this entry's own contribution begins, so its window lands on the FIRST unit it
    // pushes and on nothing after it. A reel is the case the whole feature came from: every
    // line of the Theater Demo Reel is a pre-clipped file that exists only because a section
    // could not be written down.
    const mine = play.length;
    if (desc.collection) {
      const items = await collectionItems(
        client, cfg, desc.collection, new Set(), token, desc.start, false, desc.collectionOrder,
      );
      if (!items || !items.length) {
        unresolved.push(`Collection: ${desc.collection}`);
        continue;
      }
      play.push(...items.slice(0, Math.max(0, limit - play.length)));
      const collectionSection = sectionOf(desc);
      const collectionFirst = play[mine];
      if (collectionSection && collectionFirst) play[mine] = { ...collectionFirst, ...collectionSection };
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
      const eps = (await showEpisodes(client, rk, token)).filter((e) => !skipped.has(e.ratingKey));
      const batch = Math.max(1, Math.min(parseInt(String(desc.episodes || QUEUE_SERIES_DEFAULT), 10),
        QUEUE_SERIES_LENGTH));
      for (const e of eps.slice(0, batch)) play.push({ title: e.title || title, ratingKey: e.ratingKey });
    }
    const section = sectionOf(desc);
    const first = play[mine];
    if (section && first) play[mine] = { ...first, ...section };
  }
  const last = play.length
    ? { title: play[0]!.title as string, type: 'movie', ratingKey: play[0]!.ratingKey } : null;
  return { set: setName, play, last, done: [], unresolved, remaining: play.length, offset: 0 };
}

/**
 * "May this entry lead again?", injected rather than imported.
 *
 * The answer lives in SQLite (`promote.canLeadOnce`), and this file is the deterministic
 * engine the parity corpus replays — it holds no database handle and must stay runnable
 * without one. `providers/plex.ts` binds the real gate; a null gate means "nothing has ever
 * led", which is what a fresh store says anyway.
 */
export type LeadGate = (entryKey: string, windowMs: number) => Promise<boolean>;

/** The lead cooldown for one entry: entry > set > product default. `0` = no window. */
function leadWindowMs(desc: EntryDescriptor, cfg: ResolveCfg): number {
  const fromEntry = parsePromoteWindow(desc.promoteWindow);
  if (fromEntry != null) return fromEntry;
  const fromSet = parsePromoteWindow(cfg.promote_window);
  if (fromSet != null) return fromSet;
  return DEFAULT_PROMOTE_WINDOW_MS;
}

/**
 * What this scan decided, in four lines, on every curated scan.
 *
 * WHY IT IS UNCONDITIONAL: "it played a different movie each time" was unanswerable from the
 * container log, because the only thing a queue scan said out loud was which entries it had
 * finished. The lineup itself — the order, the lane each entry landed in, which title is
 * about to play — was never written down anywhere, so a wrong head could not be told from a
 * wrong ORDER, and neither could be told from Plex ignoring both
 * (decision `2026-08-26-a-scan-logs-the-lineup-it-built`).
 *
 * Bounded on purpose: the head gets a line of its own, the order is cut at ten titles with a
 * count of the rest, and a queue that resolved to nothing says so in one line. A scan happens
 * on a button press, not on a timer, so this is a handful of lines per sitting.
 */
function logLineup(setName: string, cfg: ResolveCfg, x: {
  addAs: string;
  ordered: Batch[];
  priority: Batch[];
  pool: Batch[];
  resuming: Batch[];
  playItems: ResolvedItem[];
  suppressed: string[];
  doneFlagged: string[];
  unresolved: string[];
}): void {
  const head = x.playItems.length ? x.playItems[0]! : null;
  const headBatch = x.ordered.length ? x.ordered[0]! : null;
  const lane = headBatch
    ? (x.resuming.includes(headBatch) ? 'resuming'
      : x.priority.includes(headBatch) ? 'priority' : 'pool')
    : '-';
  const order = String(cfg.source) === 'queue' && !isRandomOrder(cfg) ? 'in order' : 'shuffled';
  console.log(
    `[lineup] ${setName}: add_as=${x.addAs} (${order}), length=${playbackLength(cfg)} `
    + `-> ${x.playItems.length} item(s) from ${x.ordered.length} entry(s) `
    + `[priority ${x.priority.length}, pool ${x.pool.length}, resuming ${x.resuming.length}]`,
  );
  if (head) {
    console.log(
      `[lineup] ${setName} head: "${headBatch?.title ?? head.title ?? '?'}" `
      + `rk=${head.ratingKey} lane=${lane}`,
    );
  } else {
    console.log(`[lineup] ${setName} head: NOTHING — every entry is finished or unresolved`);
  }
  const titles = x.ordered.slice(0, 10).map((b, i) => `${i + 1} ${b.title}`);
  const more = x.ordered.length > titles.length ? ` (+${x.ordered.length - titles.length} more)` : '';
  if (titles.length) console.log(`[lineup] ${setName} order: ${titles.join(' | ')}${more}`);
  if (x.suppressed.length) {
    console.log(`[lineup] ${setName} held back by their lead window: ${x.suppressed.join(', ')}`);
  }
  if (x.doneFlagged.length || x.unresolved.length) {
    console.log(
      `[lineup] ${setName} not playable: ${x.doneFlagged.length} finished, `
      + `${x.unresolved.length} unresolved`,
    );
  }
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
  canLead: LeadGate | null = null,
  ownProgress: ((entryKey: string) => ReadonlyMap<string, {
    isCompleted: boolean; positionMs: number;
  }>) | null = null,
): Promise<QueueResult> {
  if (!entries.length) return emptyResult(setName);
  const newlyDone: string[] = [];
  const doneFlagged: string[] = [];
  const unresolved: string[] = [];
  const revived: string[] = [];
  let remaining = 0;
  const batches: Batch[] = [];
  for (const desc of entries) {
    const isOwnHistory = (desc.watchHistory ?? normalizeWatchHistory(cfg.watch_history)
      ?? 'provider') === 'queue';
    const progress = isOwnHistory && desc.key && ownProgress
      ? ownProgress(desc.key)
      : null;
    const entryWatched = progress
      ? new Set([...progress].filter(([, row]) => row.isCompleted).map(([key]) => key))
      : watched;
    const res = await resolveMember(
      client,
      desc,
      cfg,
      entryWatched,
      token,
      setBatch(cfg),
      true,
      rng,
      progress,
    );
    // The entry's window, on the FIRST unit it contributes and on nothing after it. Stamped
    // before the own-history pass below so both spreads survive, and outside it because a
    // section is not a history concern — an entry on provider history has one too.
    const section = res ? sectionOf(desc) : null;
    if (res && section && res.items.length) {
      res.items = res.items.map((item, i) => (i === 0 ? { ...item, ...section } : item));
    }
    if (res && isOwnHistory && desc.key) {
      res.items = res.items.map((item) => ({
        ...item,
        queueEntryKey: desc.key as string,
        queueOwnHistory: true,
        queueResumeOffset: progress?.get(String(item.ratingKey))?.positionMs ?? 0,
        queueProviderViewCount: Number(item.viewCount) || 0,
      }));
    }
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
        batches.push({ title: res!.title, type: res!.type, items: res!.items, weight: res!.weight, desc });
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
      // Empty is FINISHED, and a SKIPPED item counts towards it exactly as a watched one does.
      // Watch a show's first nine episodes and skip the tenth and the show is over; watch two
      // films of a three-film collection and skip the middle one and the collection is over.
      // "Skipped" is a decision about that item, not a gap waiting to be filled — treating it
      // as one left an entry that could never complete and never leave the queue
      // (decision `2026-08-23-a-skipped-item-counts-as-dealt-with-so-the-entry-can-complete`).
      //
      // Undoing it needs nothing special: Restore puts the item back, the entry resolves to
      // something playable again, and the stale-done recovery below REVIVES it and clears the
      // flag — the same path a returning show takes. The one thing that is genuinely one-way
      // is a queue with `remove_completed_after` set, where the line is deleted once the
      // window passes. That is what the TTL means on every other completion too.
      newlyDone.push(desc.key as string);
      doneFlagged.push(res.title);
      remaining -= 1;
      continue;
    }
    batches.push({ title: res.title, type: res.type, items: res.items, weight: res.weight, desc });
  }

  const leadsInProgress = (b: Batch): boolean => {
    const it = b.items.length ? b.items[0] : null;
    // An entry with a SECTION is never "in the middle of" anything: it begins at its own
    // start mark every single sitting, so a resume marker left behind by the last one says
    // nothing about it. Without this, an entry that stops at 40% by design reads as
    // half-watched and hoists itself to the front of the random pool every night, forever.
    if (sectionOf(b.desc)) return false;
    return Boolean(it && ((it.queueResumeOffset ?? 0) > 0
      || inProgress(it.viewOffset, it.viewCount)));
  };

  // ── THE TWO LANES ─────────────────────────────────────────────────────────────────────
  // A Picks queue is one membership list with a Priority queue and a Random pool
  // (decision `2026-08-23-kind-is-picks-or-rules` §2/§4). The set's `add_as` says which lane
  // an entry with no `placement:` of its own is in — so a queue nobody has promoted anything
  // in is ENTIRELY one lane, and comes out of here in exactly the order it came out before
  // this existed. That is the property to protect on every edit below: single-lane behaviour
  // is not a special case here, it is the old code path with a filter that matched everything.
  const addAs = normalizeAddAs(cfg.add_as, { kind: cfg.kind, source: cfg.source });
  const laneOf = (b: Batch) => normalizePlacement(b.desc.placement, addAs);

  // A Priority entry with an unexpired lead window YIELDS this sitting: it stays in the queue
  // and simply does not lead. It falls back to the pool rather than vanishing, so a promoted
  // film that already led today can still come up on a random-default queue — it has just
  // stopped being a promise.
  const suppressed: string[] = [];
  const led: string[] = [];
  const priority: Batch[] = [];
  const pool: Batch[] = [];
  for (const b of batches) {
    if (laneOf(b) !== 'priority') { pool.push(b); continue; }
    const isPromoted = isExplicitPlacement(b.desc.placement);
    const mode = normalizeLead(b.desc.lead, { isPromoted });
    if (mode === 'always') { priority.push(b); continue; }
    const windowMs = leadWindowMs(b.desc, cfg);
    // No gate injected (the parity corpus, a unit test) means "nothing has ever led" — the
    // deterministic answer, and the one that keeps the engine runnable without the store.
    const mayLead = canLead ? await canLead(b.desc.key as string, windowMs) : true;
    if (mayLead) {
      priority.push(b);
      led.push(b.desc.key as string);
    } else {
      suppressed.push(b.desc.key as string);
      pool.push(b);
    }
  }

  // In-progress OUTRANKS a promote, and only out of the pool. Two halves of one rule:
  //   * a half-watched member of a random pool has always led so it resumes, and a promote
  //     must not steal the screen from a show somebody is in the middle of (ADR §4.4);
  //   * an ORDERED queue has never hoisted anything — its head is its head — so the hoist
  //     stays scoped to the pool, where it already lived, and a priority-default queue with
  //     no pool never reaches it.
  const resuming = pool.filter(leadsInProgress);
  const rest = pool.filter((b) => !leadsInProgress(b));
  // A channel plays each member ONCE per scan and gets cut at ROTATION_LENGTH, so "comes up
  // more often" here means "lands near the front more often": a weighted shuffle, not the
  // slots-per-round interleave the rotation channels use (they replay a member across rounds;
  // this path does not). With nothing weighted, the plain Fisher-Yates shuffle runs unchanged
  // — same rng, same sequence — so an unweighted channel's seeded order is untouched.
  if (isUnweighted(rest)) {
    if (rng) rng.shuffle(rest);
  } else {
    weightedShuffle(rest, rng);
  }
  const ordered = resuming.concat(priority, rest);

  // The CAP still follows the set, not the lane. `playbackLength` is a set-level knob and
  // means two different things either side of `add_as` — ENTRIES on a priority-default queue
  // (where "length 1" means the entry at the top, whole, `episodes:` and all) and ITEMS on a
  // random-default one (where there are no entries to count). Keeping the unit tied to the
  // set is what makes a queue with nothing promoted bit-for-bit what it was.
  const cap = initialQueueSize(playbackLength(cfg));
  let playItems: ResolvedItem[];
  if (isRandomOrder(cfg)) {
    playItems = [];
    for (const b of ordered) {
      playItems.push(...b.items.slice(0, cap - playItems.length));
      if (playItems.length >= cap) break;
    }
  } else {
    playItems = [];
    for (const b of ordered.slice(0, cap)) playItems.push(...b.items);
  }
  const leadBatch: Batch | null = ordered.length ? ordered[0]! : null;

  logLineup(setName, cfg, {
    addAs, ordered, priority, pool, resuming, playItems, suppressed, doneFlagged, unresolved,
  });

  // A non-empty `playItems` implies a `leadBatch`, as it always did.
  const last = playItems.length
    ? { title: leadBatch!.title, type: leadBatch!.type, ratingKey: playItems[0]!.ratingKey } : null;
  const offset = playItems.length ? await headResumeOffset(client, playItems[0]!, token) : 0;
  return {
    set: setName, play: playItems, last, done: doneFlagged, unresolved, remaining, offset, revived,
    newlyDone, // D4: keys for queues.markDone (not in the Python JSON oracle shape)
    // Only the entries that actually LED — the caller stamps their cooldown once playback
    // starts, never here (see `QueueResult.led`).
    led: playItems.length ? led : [],
    suppressed,
  };
}
