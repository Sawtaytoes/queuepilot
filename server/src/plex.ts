// Read-only Plex client for the queue editor: title search, title→item resolution,
// and poster proxying. Deliberately mirrors queue_builder/plex.py's resolver so the UI
// shows exactly what the Python service will resolve at scan time.
//
// TLS: Plex presents a self-signed cert. The container sets NODE_TLS_REJECT_UNAUTHORIZED=0
// for this process (see entrypoint), the Node equivalent of the Python client's CERT_NONE.
import { Agent, request } from 'undici';
import * as cache from './cache.js';
import { PLEX_URL, PLEX_TOKEN, PLEX_CLIENT_IDENTIFIER } from './config.js';
import { PlexError, isPlexError } from './errors.js';
import type {
  NextEp,
  PlayingContext,
  PlexDirectory,
  PlexMediaContainer,
  PlexMetadata,
  Start,
} from './types.js';

// --- local shapes: what this file reads that the shared wire types don't name ----------- //
// Every one of these is REPORTED rather than pushed into types.ts (which this workstream may
// not edit). They are deliberately narrow: each field below is read by a line in this file.

/**
 * A `MediaContainer` as THIS file reads it. `types.ts`'s `PlexMediaContainer` names only
 * `Metadata`/`Directory`/`size`/`totalSize` and carries no index signature, but:
 *   * `machineIdentifier()` reads it off the server root (`GET /`),
 *   * `allLeaves()` and `collectionChildren()` read `updatedAt`/`leafCount`/
 *     `viewedLeafCount`/`childCount` off the CONTAINER as the fallback validator when the
 *     show-node aggregate call failed.
 */
interface PlexContainer extends PlexMediaContainer {
  Directory?: PlexDirectoryRow[];
  machineIdentifier?: string;
  updatedAt?: number;
  leafCount?: number;
  viewedLeafCount?: number;
  childCount?: number;
}

/**
 * A `Directory` row with the two extra fields this file reads: `agent` (the "Other Videos"
 * / Personal Media test in `sections()`) and `contentRating` (the facet listing, which
 * returns the value as a Directory row).
 */
interface PlexDirectoryRow extends PlexDirectory {
  agent?: string;
  contentRating?: string;
}

/**
 * Anything with the season/episode identity of a leaf. The three predicates below accept a
 * RAW Plex `Metadata` row (`parentIndex`/`index`) and, per their own comments, the
 * already-normalized engine item (`season`/`episode`) — so both spellings are optional here
 * and the index signature is what lets a `PlexMetadata` pass without a cast.
 *
 * NOTE `extraType` is `number` on `types.ts`'s `PlexMetadata`, but the code compares it to
 * `''` and the specials-count suite passes the string `'behindTheScenes'`; both are allowed
 * here. Reported, not fixed.
 */
export interface EpisodeLike {
  type?: string;
  extraType?: number | string | null;
  parentIndex?: number | null;
  index?: number | null;
  season?: number | null;
  episode?: number | null;
  duration?: number;
  viewCount?: number;
  viewOffset?: number;
  title?: string;
  [field: string]: unknown;
}

/** `countEpisodes()` / `episodeCounts()` — the filtered aggregate the UI's "X/Y watched" shows. */
export interface EpisodeCounts {
  leafCount: number;
  viewedLeafCount: number;
}

/**
 * The common item projection `posterFields()` builds, and what `search()`, `resolveTitle()`
 * and the ratingKey branch of `resolveValue()` all hand back.
 *
 * `type` is narrowed to `'movie' | 'show'` because every caller filters on exactly those two
 * before calling — and because that is what makes `ResolvedItem` a discriminated union
 * against `ResolvedCollection`, which is how `tiles.ts` narrows without casts. It stays
 * OPTIONAL because the wire field is.
 */
export interface PosterFields {
  ratingKey: string;
  type: 'movie' | 'show' | undefined;
  title: string | undefined;
  year: number | null;
  sectionId: number | null;
  hasThumb: boolean;
  viewCount: number;
  viewOffset: number;
  duration: number;
  leafCount: number;
  viewedLeafCount: number;
}

/** One row of `collections()` — a Plex Collection (type=18) inside a section. */
export interface CollectionHit {
  type: 'collection';
  ratingKey: string;
  title: string | undefined;
  sectionId: number;
  childCount: number | null;
  hasThumb: boolean;
}

/** `resolveCollection()` — the same row minus the section it was found in. */
export interface ResolvedCollection {
  type: 'collection';
  ratingKey: string;
  title: string | undefined;
  childCount: number | null;
  hasThumb: boolean;
  /**
   * ALWAYS ABSENT: a collection has no release year. Declared (as never-set) only so the one
   * shared expression in `tiles.ts` — `resolved ? resolved.year : null` — still reads the
   * union without a cast, and so the fact that a collection tile emits NO `year` key stays
   * visible instead of being quietly coerced to null.
   */
  year?: undefined;
}

/** What `resolveValue()` resolves a raw queue/member value to. Discriminated on `type`. */
export type ResolvedItem = PosterFields | ResolvedCollection;

/** One row of `sections()` — a library, video-flagged. */
export interface SectionInfo {
  id: number;
  title: string | undefined;
  type: string | undefined;
  video: boolean;
  other: boolean;
}

/** A section id, or a list of them — the `[].concat(sections)` idiom accepted both. */
export type SectionIds = number | number[];

/** `parseTitleString()` — a queue entry's "Title (Year) [guid]" decomposed. */
export interface ParsedTitle {
  title: string;
  year: number | null;
  guid: string | null;
}

/** One row of `homeUsers()` — a Plex Home profile, as the channel form's dropdown wants it. */
export interface HomeUser {
  name: string;
  username: string | null;
  id: number | null;
  uuid: string | null;
  admin: boolean;
  restricted: boolean;
}

/** The plex.tv `/api/v2/home/users` row `homeUsers()` maps. */
interface PlexTvHomeUser {
  title?: string;
  username?: string;
  friendlyName?: string;
  id?: number | string;
  uuid?: string;
  admin?: boolean;
  restricted?: boolean;
}

/** `token` + `account` scope a read to one Plex Home profile; empty = admin (Bob). */
export interface AccountScope {
  token?: string | null;
  account?: string;
}

/** The show-node validator `allLeaves()` reads before trusting a cached leaves row. */
interface ShowAggregate {
  updatedAt: number;
  leafCount: number;
  viewedLeafCount: number;
}

/** One member of a Collection, as `collectionChildren()` reports it. */
export interface CollectionChild {
  ratingKey: string;
  type: string | undefined;
  title: string;
  year: number | null;
  /** Movies/standalones only — a SHOW reports progress via leafCount instead. */
  watched: boolean;
  viewOffset: number;
  duration: number;
  viewedLeafCount: number | null;
  leafCount: number | null;
}

/**
 * `collectionNext()`'s result.
 *
 * DIVERGES from `types.ts`'s `NextEp` in exactly one field: `startMember` is `string | null`
 * here (it is `null` whenever no manual start names a member), where `NextEp` declares
 * `startMember?: string`. Reported, not fixed — flattening the null would change what the
 * tile's start chip serializes.
 */
export interface CollectionNextEp extends Omit<NextEp, 'startMember'> {
  startMember: string | null;
}

/** `showEpisodes()` — the "Start from…" editor's per-season episode list. */
export interface ShowEpisodeRow {
  episode: number | null;
  title: string;
  watched: boolean;
}

export interface ShowSeason {
  season: number;
  episodes: ShowEpisodeRow[];
}

export interface ShowEpisodes {
  multiSeason: boolean;
  seasons: ShowSeason[];
}

/**
 * `thumb()` — the proxied poster bytes. Structurally the same as `types.ts`'s
 * `ProviderCover`, but that one is declared as the PROVIDER seam's return (kavita.js
 * `cover()`); this is the Plex poster proxy, which is not part of that seam.
 */
export interface PosterImage {
  contentType: string;
  buffer: Buffer;
}

// --------------------------------------------------------------------------------------- //

// A keepalive connection pool for Plex (B5). The old code went through global `fetch` with no
// pooling, so ~60 calls on one `/api/queues` each paid a fresh TCP+TLS handshake, and a hung
// socket hung forever with nothing to reuse. This pins one pool of 16 reusable connections.
//
// `connect.rejectUnauthorized: false` is NOT optional: undici does NOT reliably honour the
// process-wide NODE_TLS_REJECT_UNAUTHORIZED the entrypoint sets, and Plex's cert is
// self-signed, so without it every request 500s on cert validation. Scoped to this pool,
// which only ever talks to the LAN Plex server.
const agent = new Agent({
  keepAliveTimeout: 60_000,
  connections: 16,
  connect: { rejectUnauthorized: false },
});

// Retry ONLY on network errors and 5xx, with jittered backoff. Never on 4xx — a dead
// ratingKey must stay dead (the resolver depends on a 404 meaning "not in library", not
// "try again"). Each attempt has its own 8 s timeout, so a hung Plex socket fails the
// attempt instead of the whole request hanging forever.
async function withRetry<T>(
  fn: () => Promise<T>,
  { attempts = 3, baseMs = 150 }: { attempts?: number; baseMs?: number } = {},
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      // A 4xx is surfaced by fn() as a non-retryable marker; rethrow immediately.
      if (isPlexError(e) && e.plexStatus >= 400 && e.plexStatus < 500) throw e;
      lastErr = e;
      if (i === attempts - 1) break;
      const jitter = Math.floor((i + 1) * baseMs * (0.5 + Math.sin(i + 1) * 0.25 + 0.5));
      await new Promise((r) => setTimeout(r, jitter));
    }
  }
  throw lastErr;
}

// Single-flight: N tiles asking for the same collection's children in one `/api/queues`
// fan-out collapse to ONE HTTP call. Keyed on (path|token); the entry is deleted on settle so
// a later request refetches.
const _inflight = new Map<string, Promise<unknown>>();

// `token` overrides the admin PLEX_TOKEN — used for per-account (managed-user) queries so
// the section listing/facets reflect THAT account's restricted library view (workstream D).
export async function plexGet(path: string, token: string | null = null): Promise<unknown> {
  const key = `${path} ${token || ''}`;
  const existing = _inflight.get(key);
  if (existing) return existing;

  const p = withRetry(async () => {
    const res = await request(PLEX_URL + path, {
      dispatcher: agent,
      method: 'GET',
      headers: { 'X-Plex-Token': token || PLEX_TOKEN, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (res.statusCode >= 400) {
      // Drain the body so the connection returns to the pool rather than leaking.
      await res.body.dump();
      // `PlexError` carries `plexStatus`, which withRetry uses to NOT retry 4xx, and builds
      // the same `plex <status> for <path>` message this line always threw.
      throw new PlexError(res.statusCode, path);
    }
    return res.body.json();
  }).finally(() => _inflight.delete(key));

  _inflight.set(key, p);
  return p;
}

function container(json: unknown): PlexContainer {
  return (json as { MediaContainer?: PlexContainer } | null | undefined)?.MediaContainer || {};
}

// --- the shared "is this a real episode?" predicate --------------------------------------- //
// (decision 2026-08-07-specials-count-excludes-op-ed-trailer-extras, REFINES 2026-07-17.)
// Mirrors queue_builder/plex.py is_extra_or_promo. The owner's library encodes an item's kind in
// the SEASON-0 episode INDEX (Plex `parentIndex == 0`, `index` = the number), and that
// deterministic range — NOT any duration/title heuristic — is the rule:
//   * index 1–99    → regular specials (e.g. an OAD)      → INCLUDE (count + eligible)
//   * index 100–199 → unspecified                          → INCLUDE (conservative; owner to confirm)
//   * index 200–299 → trailers                             → EXCLUDE
//   * index 300–399 → openings/endings (OP/ED theme songs) → EXCLUDE  (this inflated "25/29")
//   * index 400–499 → "other"                              → INCLUDE (meant to be played)
// So a Season-0 leaf is an extra exactly when 200 <= index <= 399. Real seasons (>=1) are never
// extras. Plex Extras/clips (a `clip` type or an `extraType`) are excluded too, if any appear.
const S0_EXTRA_INDEX_MIN = 200; // trailers (200–299) + OP/ED (300–399)
const S0_EXTRA_INDEX_MAX = 399;

export function isExtraOrPromo(ep: EpisodeLike | null | undefined): boolean {
  if (!ep) return false;
  if (ep.type === 'clip') return true;
  if (ep.extraType != null && ep.extraType !== '') return true;
  const season = ep.parentIndex != null ? ep.parentIndex : ep.season;
  if (String(season) === '0') {
    const idx = Number(ep.index != null ? ep.index : ep.episode);
    if (Number.isFinite(idx) && idx >= S0_EXTRA_INDEX_MIN && idx <= S0_EXTRA_INDEX_MAX) return true;
  }
  return false;
}

// A real episode for COUNTING purposes: has a duration (a castable file) and is not an
// extra/promo. Includes S1+ episodes AND regular Season-0 specials; excludes the junk.
export function isCountableEpisode(ep: EpisodeLike | null | undefined): boolean {
  if (!ep || !ep.duration) return false;
  return !isExtraOrPromo(ep);
}

// A real episode for PLAYBACK: same junk filter, plus the 2026-07-17 rule that Season 0 is
// excluded unless the set opts in with includeSpecials (a series never OPENS on a special).
// NOTE the specials-only-OAD exception (a show whose only leaves are Season 0) needs whole-show
// context, so nextEpisode/showEpisodes apply it themselves; this per-item predicate is the plain
// default rule and is used for counting + the start editor.
export function isPlayableEpisode(
  ep: EpisodeLike | null | undefined,
  { includeSpecials = false }: { includeSpecials?: boolean } = {},
): boolean {
  if (!ep) return false;
  if (isExtraOrPromo(ep)) return false;
  const season = ep.parentIndex != null ? ep.parentIndex : ep.season;
  if (!includeSpecials && String(season) === '0') return false;
  if (!ep.duration) return false;
  return true;
}

// Filtered episode counts from an allLeaves list: total real episodes and how many are watched
// (viewCount > 0; a MISSING viewCount is treated as UNWATCHED). Pure — the caller feeds it the
// raw Plex Metadata array — so it is unit-tested directly.
export function countEpisodes(eps: EpisodeLike[] | null | undefined): EpisodeCounts {
  let leafCount = 0;
  let viewedLeafCount = 0;
  for (const e of eps || []) {
    if (!isCountableEpisode(e)) continue;
    leafCount += 1;
    if (e.viewCount && e.viewCount > 0) viewedLeafCount += 1;
  }
  return { leafCount, viewedLeafCount };
}

// --- per-account (managed-user) tokens (mirrors queue_builder/plex.py account_token) --- //
// The raw plex.tv switch token 401s against the LOCAL server; the per-server accessToken
// from /api/v2/resources does not. Minting it lets a facet query see exactly that account's
// restricted library. Cached per uuid. Best-effort — any failure returns null (caller uses
// the admin token / static fallback), so the API degrades cleanly with plex.tv unreachable.
const _accountTokens = new Map<string, string | null>(); // user_uuid -> server-scoped access token (or null)

async function plextv<T = unknown>(path: string, token: string, method = 'GET'): Promise<T> {
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
  return (text ? JSON.parse(text) : {}) as T;
}

async function machineIdentifier(): Promise<string> {
  return container(await plexGet('/')).machineIdentifier || '';
}

export async function accountToken(userUuid: string | null | undefined): Promise<string | null> {
  if (!userUuid) return null; // no managed user => admin PLEX_TOKEN (Bob)
  // `has` + `get` in one read: the map caches `null` (a failed mint) as a real answer, so
  // only `undefined` — never a cached null — counts as a miss.
  const memo = _accountTokens.get(userUuid);
  if (memo !== undefined) return memo;
  let token: string | null = null;
  try {
    const sw = await plextv<{ authToken?: string } | null>(
      `/api/v2/home/users/${userUuid}/switch`,
      PLEX_TOKEN,
      'POST',
    );
    const auth = sw && sw.authToken;
    if (auth) {
      const resources = await plextv<
        { clientIdentifier?: string; accessToken?: string }[]
        | { resources?: { clientIdentifier?: string; accessToken?: string }[] }
      >('/api/v2/resources?includeHttps=1', auth);
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
export async function homeUsers(): Promise<HomeUser[]> {
  let data: PlexTvHomeUser[] | { users?: PlexTvHomeUser[] } | null;
  try {
    data = await plextv<PlexTvHomeUser[] | { users?: PlexTvHomeUser[] } | null>(
      '/api/v2/home/users',
      PLEX_TOKEN,
    );
  } catch {
    return [];
  }
  const rows = Array.isArray(data) ? data : (data && data.users) || [];
  return rows
    .map((u) => ({
      name: u.title || u.username || u.friendlyName || '',
      // The plex.tv username — the string the PMS log stamps for the OWNER (managed users
      // stamp their title instead). The requires_profile gate matches that stamp, so the
      // queue-profile picker uses `username` for the admin option and `name` for the rest.
      username: u.username || null,
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
export async function contentRatings(
  sections: SectionIds,
  token: string | null = null,
): Promise<string[]> {
  const out = new Set<string>();
  for (const section of ([] as number[]).concat(sections)) {
    let dirs: (PlexDirectoryRow | PlexMetadata)[] = [];
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
export function parseTitleString(text: unknown): ParsedTitle {
  let s = String(text).trim();
  let guid: string | null = null;
  let m = s.match(/\s*\[([^\]]+)\]\s*$/);
  if (m) {
    guid = (m[1] ?? '').trim();
    s = s.slice(0, m.index).trimEnd();
  }
  let year: number | null = null;
  m = s.match(/\s*\((\d{4})\)\s*$/);
  if (m) {
    year = parseInt(m[1] ?? '', 10);
    s = s.slice(0, m.index).trimEnd();
  }
  return { title: s.trim(), year, guid };
}

// `source-id` folder hint (anidb-16172) → Plex Guid id (anidb://16172). Best-effort.
function matchGuidHint(hint: string | null | undefined, guids: (string | undefined)[]): boolean {
  if (!hint) return false;
  const i = hint.indexOf('-');
  if (i <= 0) return false;
  const want = `${hint.slice(0, i)}://${hint.slice(i + 1)}`.toLowerCase();
  return guids.some((g) => (g || '').toLowerCase() === want);
}

function posterFields(md: PlexMetadata): PosterFields {
  return {
    ratingKey: String(md.ratingKey),
    // Every caller filters to `type` 'movie'/'show' before reaching here (search(),
    // resolveTitle() and resolveValue() all `continue`/bail otherwise), which is what makes
    // this projection the non-collection half of `ResolvedItem`.
    type: md.type as PosterFields['type'],
    title: md.title,
    year: md.year ?? null,
    sectionId: md.librarySectionID != null ? Number(md.librarySectionID) : null,
    hasThumb: Boolean(md.thumb),
    // A MOVIE's own resume state (a show reports per-episode instead — see nextEpisode).
    // viewCount is omitted at 0, so a missing count is unwatched. Lets a mid-movie tile
    // show "In Progress" without an extra fetch.
    viewCount: Number(md.viewCount) || 0,
    viewOffset: Number(md.viewOffset) || 0,
    // Runtime in ms — pairs with viewOffset so a mid-movie tile can say how far in / how long.
    duration: Number(md.duration) || 0,
    // A SHOW's aggregate progress, which is how the add box answers "unwatched only" /
    // "in progress" for a series without a second request: Plex already puts both on the
    // section listing this came from, and omits viewedLeafCount at 0.
    leafCount: Number(md.leafCount) || 0,
    viewedLeafCount: Number(md.viewedLeafCount) || 0,
  };
}

// All library sections, video-flagged (movie/show only are ever queueable). Feeds the
// per-queue library picker + the global-exclude editor.
export async function sections(): Promise<SectionInfo[]> {
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
export async function search(sections: SectionIds, query: string): Promise<PosterFields[]> {
  const q = encodeURIComponent(query);
  const out: PosterFields[] = [];
  const seen = new Set<string>();
  for (const section of ([] as number[]).concat(sections)) {
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
export async function collections(sections: SectionIds, query: string): Promise<CollectionHit[]> {
  const ql = String(query || '').trim().toLowerCase();
  const out: CollectionHit[] = [];
  const seen = new Set<string>();
  for (const section of ([] as number[]).concat(sections)) {
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
export async function resolveCollection(
  sections: SectionIds,
  name: string,
): Promise<ResolvedCollection | null> {
  const list = await collections(sections, name);
  if (!list.length) return null;
  const nl = String(name).trim().toLowerCase();
  const c = list.find((x) => String(x.title).trim().toLowerCase() === nl) || list[0];
  if (!c) return null; // unreachable — `list.length` was checked above; index reads are unchecked
  return {
    type: 'collection',
    ratingKey: c.ratingKey,
    title: c.title,
    childCount: c.childCount,
    hasThumb: c.hasThumb,
  };
}

// --- resolve one parsed title to a section item (mirrors plex._resolve_title) - //
// L1 is the in-process Map (a single request's repeats); L2 is the SQLite `resolved` table,
// which survives restarts — a title→ratingKey is stable, so this is the highest-hit-rate,
// lowest-risk piece of the derived cache (7-day TTL, no validator needed).
// `${section}|${title}|${year}|${guid}` -> item (a null is never cached here)
const _titleCache = new Map<string, PosterFields>();

export async function resolveTitle(
  section: number,
  title: string,
  year: number | null = null,
  guid: string | null = null,
): Promise<PosterFields | null> {
  const ck = `${section}|${title.toLowerCase()}|${year}|${(guid || '').toLowerCase()}`;
  const memo = _titleCache.get(ck);
  if (memo !== undefined) return memo;
  const cached = await cache.getResolved<PosterFields>(section, title, year, guid);
  if (cached !== undefined) {
    // A cached hit is the resolved item; a cached `null` means "provably not in library",
    // which is worth remembering too (it saved the miss). Only positive hits go in L1, to
    // match the pre-cache behaviour that never memoized a null.
    if (cached) _titleCache.set(ck, cached);
    return cached;
  }
  let mc;
  try {
    mc = container(
      await plexGet(
        `/library/sections/${section}/all?title=${encodeURIComponent(title)}&includeGuids=1&X-Plex-Container-Size=50`,
      ),
    );
  } catch {
    return null; // transient — don't cache (plexGet already retried network/5xx)
  }
  const tl = title.toLowerCase();
  let best: PosterFields | null = null;
  let bestScore = 0;
  for (const e of mc.Metadata || []) {
    if (e.type !== 'movie' && e.type !== 'show') continue;
    const candTitle = (e.title || '').toLowerCase();
    // `Guid` is not on the shared `PlexMetadata`; it arrives only with `includeGuids=1`.
    const guids = ((e.Guid as { id?: string }[] | undefined) || []).map((g) => g.id);
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
  if (best === null || bestScore <= 0) {
    await cache.putResolved(section, title, year, guid, null); // remember the miss (7d)
    return null;
  }
  _titleCache.set(ck, best);
  await cache.putResolved(section, title, year, guid, best);
  return best;
}

// --- resolve a raw queue value (ratingKey | title | {ratingKey,title}) -------- //
// `sections` is the set's section list; a title is tried in each (first hit wins), a
// ratingKey resolves globally via metadata.
export async function resolveValue(
  sections: SectionIds,
  value: unknown,
): Promise<ResolvedItem | null> {
  // ratingKey (scalar number/numeric-string, or a mapping carrying one)
  let ratingKey: string | null = null;
  let titleText: string | null = null;
  if (value && typeof value === 'object') {
    const mapping = value as { ratingKey?: unknown; title?: unknown };
    if (mapping.ratingKey != null) ratingKey = String(mapping.ratingKey);
    if (mapping.title) titleText = String(mapping.title);
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
  const collName = /^\s*collection:\s*(.+)$/i.exec(titleText)?.[1];
  if (collName !== undefined) return resolveCollection(sections, collName);
  const { title, year, guid } = parseTitleString(titleText);
  if (!title) return null;
  for (const section of ([] as number[]).concat(sections)) {
    const hit = await resolveTitle(section, title, year, guid);
    if (hit) return hit;
  }
  return null;
}

// A manual START floor {season, episode}: `e` is at-or-after it (so it's eligible to play).
// Earlier episodes are skipped from the pick but never marked watched. No start => always.
// Season defaults to 1 (single-season anime stores the sole season).
function atOrAfterStart(e: PlexMetadata, start: Start | null): boolean {
  if (!start) return true;
  const es = Number(e.parentIndex) || 0;
  const ee = Number(e.index) || 0;
  const ss = Number(start.season) || 1;
  const se = Number(start.episode) || 1;
  return es > ss || (es === ss && ee >= se);
}

// The show's episodes (allLeaves), SQLite-backed. This is the single biggest source of the
// 2.7 s: one call per show, and every restart lost the in-process cache. It is cached with a
// 24 h TTL AND busted precisely and for free by the MQTT now-playing watch (cache.dropLeaves
// from mqttc.onNowPlaying) — so a watch on the Shield refreshes exactly the one show that
// changed, and nothing else refetches. Returns the raw Metadata array (the shape both callers
// already parse), or [] on a hard failure. The section-listing validator
// (cache.getLeaves(rk, {updatedAt, viewedLeafCount})) is wired for the engine path (D3/C2);
// the display path here uses the TTL + invalidation, which gives the same warm-hit behaviour.
// The show's CURRENT watch aggregate — one light metadata call (the show node only, NOT its
// episodes). The `allLeaves` CONTAINER omits leafCount/viewedLeafCount/updatedAt, but the show
// node reports them and they are stable across calls, so this is the validator source that lets
// allLeaves self-heal (below). null on any read failure → callers fall back to the TTL path.
async function showAggregate(
  showRatingKey: string,
  token: string | null = null,
): Promise<ShowAggregate | null> {
  try {
    // `token` scopes viewedLeafCount to a specific profile (per-account validator); null = admin.
    const mc = container(await plexGet(`/library/metadata/${showRatingKey}`, token));
    const show = (mc.Metadata || [])[0];
    if (!show) return null;
    return {
      updatedAt: Number(show.updatedAt ?? 0),
      leafCount: Number(show.leafCount ?? 0),
      viewedLeafCount: Number(show.viewedLeafCount ?? 0),
    };
  } catch {
    return null;
  }
}

async function allLeaves(
  showRatingKey: string | number,
  { token = null, account = '' }: AccountScope = {},
): Promise<PlexMetadata[] | null> {
  const rk = String(showRatingKey);
  // Per-account rows ('' = admin/Bob): the episode STRUCTURE is universal, but each leaf's
  // viewCount is the querying account's own — so a per-profile channel's editor keys its own
  // account and never inherits the admin's watched marks. The validator below is read under the
  // SAME token, since viewedLeafCount is per-account too.
  // (decision 2026-08-07-editor-episode-marks-per-account)
  // VALIDATE the cached episodes against the show's live (updatedAt, viewedLeafCount) so an
  // episode finished OUTSIDE the app's own flow — a manual Plex play, another client — self-
  // heals immediately instead of serving a stale next-up for up to the 24 h TTL. The MQTT
  // now-playing drop (cache.dropLeaves) only fires for watches the app started, which is why an
  // out-of-band completion used to stick. The validator is one light show-node call (no leaves);
  // when Plex is unreachable it is null and getLeaves falls back to the TTL — offline unchanged.
  // (decision 2026-08-07-leaves-cache-revalidates-on-read)
  const agg = await showAggregate(rk, token);
  const hit = await cache.getLeaves<PlexMetadata[]>(rk, agg, account);
  if (hit) return hit;
  let mc;
  try {
    mc = container(await plexGet(`/library/metadata/${rk}/allLeaves`, token));
  } catch {
    return null; // transient — caller treats null as "couldn't read", distinct from []
  }
  const eps = mc.Metadata || [];
  // Store the validator fields from the SHOW-NODE aggregate (the allLeaves container omits them,
  // so reading them off `mc` stored 0s and the row could never validate). Fall back to the
  // container / leaf length only when the aggregate call failed.
  await cache.putLeaves(rk, {
    updatedAt: agg?.updatedAt ?? Number(mc.updatedAt ?? 0),
    leafCount: agg?.leafCount ?? Number(mc.leafCount ?? eps.length),
    viewedLeafCount: agg?.viewedLeafCount ?? Number(mc.viewedLeafCount ?? 0),
    payload: eps,
  }, account);
  return eps;
}

// --- next unwatched episode for a series. Queues/admin read Bob's view; a per-profile channel
// passes `opts` ({token, account}) so allLeaves' viewCount IS that profile's watched state — no
// history API needed. Skips Season 0 specials and zero-duration items, matching the Python
// _keep_episode rule. null = fully watched.
// `start` (optional {season, episode}) floors the pick — the tile shows where a manual
// start override will actually begin, mirroring the engine's resolve_member floor.
export async function nextEpisode(
  showRatingKey: string | number,
  start: Start | null = null,
  opts: AccountScope = {},
): Promise<NextEp | null> {
  const eps = await allLeaves(showRatingKey, opts);
  if (!eps) return null;
  // A single-season show (every anime — Japan doesn't do American-style seasons) hides its
  // "S1", so the tile shows just "E5". Count DISTINCT real seasons (S0 specials don't count).
  const seasons = new Set<string>();
  for (const e of eps) {
    if (isExtraOrPromo(e) || String(e.parentIndex) === '0' || !e.duration) continue;
    if (e.parentIndex != null) seasons.add(String(e.parentIndex));
  }
  const multiSeason = seasons.size > 1;
  // A show whose ONLY leaves are Season 0 is a pure OAD / film-as-series (e.g. the Prison
  // School "Mad Wax" OAD) — its special IS the whole show, so don't skip it as a
  // front-loading special (that made such a show read "All watched"/Completed). A show WITH
  // real seasons still never opens on a special. Mirrors the engine's _has_real_seasons.
  const hasRealSeasons = seasons.size > 0;
  for (const e of eps) {
    // JUNK GATE FIRST: a clip/extraType or a Season-0 trailer/OP-ED (index 200-399) is never a
    // real episode — dropped even for a specials-only OAD, so the OAD (s0e1) survives below but
    // the ED theme songs (s0e301+) never do (decision 2026-08-07).
    if (isExtraOrPromo(e)) continue;
    if (String(e.parentIndex) === '0' && hasRealSeasons) continue;
    if (!e.duration) continue;
    // viewCount is OMITTED by Plex at 0, so a missing count is unwatched here — never watched.
    if (e.viewCount && e.viewCount > 0) continue; // already watched by Bob
    if (!atOrAfterStart(e, start)) continue; // manual start floor
    // This next-up leaf is unwatched; a viewOffset means it was STARTED (mid-episode resume
    // point), which the tile surfaces as its "In Progress" badge (same predicate as the
    // engine's resume_offset: viewOffset > 0 AND unwatched).
    const viewOffset = Number(e.viewOffset) || 0;
    return {
      season: e.parentIndex ?? null, episode: e.index ?? null, title: e.title || '',
      multiSeason, viewOffset, duration: Number(e.duration) || 0, partiallyWatched: viewOffset > 0,
    };
  }
  return null;
}

// Filtered episode counts for a show: {leafCount, viewedLeafCount} over its allLeaves, with the
// same real-episode definition the UI's "X/Y watched" reflects (regular specials in, OP/ED /
// trailers / clips out). null when the leaves can't be read. Replaces Plex's raw aggregate
// leafCount/viewedLeafCount, which include the intro/outro specials the owner does not want.
export async function episodeCounts(
  showRatingKey: string | number,
  opts: AccountScope = {},
): Promise<EpisodeCounts | null> {
  const eps = await allLeaves(showRatingKey, opts);
  return eps ? countEpisodes(eps) : null;
}

// --- ordered children of a Collection (shared by collectionNext + the start editor) --- //
// `/library/collections/<rk>/children` returns them in the collection's own order
// (collectionSort), so no client-side re-sort is needed.
export async function collectionChildren(
  collectionRatingKey: string | number,
): Promise<CollectionChild[] | null> {
  const rk = String(collectionRatingKey);
  const hit = await cache.getCollectionChildren<CollectionChild[]>(rk);
  if (hit) return hit;
  let mc;
  try {
    mc = container(await plexGet(`/library/collections/${rk}/children`));
  } catch {
    return null;
  }
  // NOTE a SHOW's `viewCount` is its number of watched episodes, not a boolean — only a
  // movie/standalone child is "watched" by viewCount. A show reports progress instead
  // (viewedLeafCount/leafCount), which the start editor shows as "12/14 watched".
  //
  // A show child's counts come from its allLeaves filtered through countEpisodes — NOT Plex's
  // raw aggregate leafCount/viewedLeafCount, which include the intro/outro specials, trailers
  // and clips the owner does not want counted (decision 2026-08-07). The per-show allLeaves is
  // cached (24 h TTL + MQTT now-playing bust) and single-flighted, and collectionNext already
  // walks the same leaves, so this adds no cold Plex I/O beyond the first read.
  const children = await Promise.all(
    (mc.Metadata || []).map(async (ch): Promise<CollectionChild> => {
      let viewedLeafCount: number | null = null;
      let leafCount: number | null = null;
      if (ch.type === 'show') {
        const counts = await episodeCounts(String(ch.ratingKey));
        if (counts) {
          viewedLeafCount = counts.viewedLeafCount;
          leafCount = counts.leafCount;
        }
      }
      return {
        ratingKey: String(ch.ratingKey),
        type: ch.type,
        title: ch.title || '',
        year: ch.year ?? null,
        watched: ch.type !== 'show' && Boolean(ch.viewCount && ch.viewCount > 0),
        // A movie/standalone member's own resume state, so a mid-movie collection tile can
        // say how far in / how long (a show member reports per-episode via nextEpisode).
        viewOffset: Number(ch.viewOffset) || 0,
        duration: Number(ch.duration) || 0,
        viewedLeafCount,
        leafCount,
      };
    }),
  );
  await cache.putCollectionChildren(rk, {
    updatedAt: Number(mc.updatedAt ?? 0),
    childCount: Number(mc.childCount ?? children.length),
    payload: children,
  });
  return children;
}

// A start floor for a COLLECTION entry: {series, season, episode} — `series` names the member
// to begin at (its ratingKey, or its title for a hand-written YAML entry). Members BEFORE it
// in collection order are skipped entirely. Returns the index of that member, or -1.
function startMemberIndex(children: CollectionChild[], start: Start | null): number {
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
// the admin (Bob) view state by default, or a specific profile's when a managed-user `token`
// is passed — so a per-profile channel's editor marks what THAT profile has already seen.
export async function showEpisodes(
  showRatingKey: string | number,
  opts: AccountScope = {},
): Promise<ShowEpisodes | null> {
  // `opts` ({token, account}) scopes the `watched` marks to a specific profile — a per-profile
  // channel's start editor shows THAT profile's history, not the admin's. Empty for
  // queues/admin, preserving Bob's-view behaviour.
  const eps = await allLeaves(showRatingKey, opts);
  if (!eps) return null;
  // A specials-only show (an OAD with no real season >= 1, e.g. "Prison School: Mad Wax")
  // must still list its Season-0 episode(s) — otherwise the start editor reads "no episodes"
  // and the tile can never resolve. Mirror nextEpisode: keep Season 0 ONLY when there are no
  // real seasons. Extras / OP-ED / trailers are always dropped (isPlayableEpisode → isExtraOrPromo).
  const hasRealSeasons = eps.some((e) => isPlayableEpisode(e));
  const seasons = new Map<number, ShowEpisodeRow[]>(); // season number -> [{episode, title, watched}]
  for (const e of eps) {
    if (!isPlayableEpisode(e, { includeSpecials: !hasRealSeasons })) continue;
    const s = Number(e.parentIndex ?? 1);
    let rows = seasons.get(s);
    if (!rows) {
      rows = [];
      seasons.set(s, rows);
    }
    rows.push({
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
export async function collectionNext(
  collectionRatingKey: string | number,
  start: Start | null = null,
  opts: AccountScope = {},
): Promise<CollectionNextEp | null> {
  // The children STRUCTURE/order is account-independent (admin-cached), but each show child's
  // next-up is resolved per-account via nextEpisode(opts) below — so a per-profile channel's
  // collection member shows that profile's next episode. (A rare movie child's `watched`
  // short-circuit still reads the admin view; shows are the common member.)
  const children = await collectionChildren(collectionRatingKey);
  if (!children) return null;
  const floorAt = startMemberIndex(children, start);
  // Which member the manual start names — the tile's start chip says so in its tooltip (the
  // member that plays NEXT can be a later one, once the start member is fully watched).
  const startMember = floorAt >= 0 ? children[floorAt]?.title ?? null : null;
  for (let i = 0; i < children.length; i++) {
    if (floorAt >= 0 && i < floorAt) continue; // member is before the manual start
    const ch = children[i];
    if (!ch) continue; // unreachable — `i < children.length`; index reads are unchecked
    const where = { member: ch.title, memberRatingKey: ch.ratingKey, memberYear: ch.year, position: i + 1, startMember };
    if (ch.type === 'show') {
      let ep = null;
      try {
        // The episode floor applies only to the member the start names, not to later ones.
        ep = await nextEpisode(ch.ratingKey, floorAt === i ? start : null, opts);
      } catch {
        /* skip a show we can't read; try the next member */
      }
      if (ep) return { ...where, kind: 'show', ...ep };
    } else {
      // movie / episode / standalone member: unwatched unless it carries a viewCount.
      if (ch.watched) continue;
      const viewOffset = Number(ch.viewOffset) || 0;
      return {
        ...where, kind: 'movie', title: ch.title,
        viewOffset, duration: Number(ch.duration) || 0, partiallyWatched: viewOffset > 0,
      };
    }
  }
  return null;
}

// --- live now-playing -> which TILE is it? ----------------------------------- //
// HA hands us only the ratingKey of the exact item on screen, but a queue tile can be a
// SERIES (the key is one of its episodes) or a COLLECTION (the key is one of its members).
// One metadata read per newly-seen key resolves both parents; cached because the answer is
// immutable for that key, so re-plays and pause/resume storms cost nothing.
const _playCtx = new Map<string, PlayingContext>(); // ratingKey -> context
export async function playingContext(ratingKey: string | number): Promise<PlayingContext | null> {
  const key = String(ratingKey);
  const memo = _playCtx.get(key);
  if (memo !== undefined) return memo;
  let md;
  try {
    md = (container(await plexGet(`/library/metadata/${key}`)).Metadata || [])[0];
  } catch {
    return null; // transient — don't cache a failure
  }
  if (!md) return null;
  const ctx: PlayingContext = {
    ratingKey: key,
    type: md.type || null,
    // An episode's grandparent IS its series, which is what a series tile stores.
    showRatingKey: md.grandparentRatingKey != null ? String(md.grandparentRatingKey) : null,
    // Collection membership comes back as name tags, and a collection tile is stored by
    // name ("Collection: <name>") — so names are the only join available here.
    collections: (md.Collection || []).map((c) => c.tag).filter((t): t is string => Boolean(t)),
  };
  _playCtx.set(key, ctx);
  return ctx;
}

// --- poster proxy: fetch a transcoded poster server-side (token never hits the
// browser). 480x720 (not the full-res art): tiles render ~158 CSS px, so this stays
// sharp through 150% zoom / 2-3x DPR screens — 300px visibly pixelated there — while
// still ~10x smaller than the originals. Falls back to the raw thumb.
const _thumbPath = new Map<string, string>(); // ratingKey -> thumb path
export async function thumb(ratingKey: string): Promise<PosterImage | null> {
  // NOTE this is the ONE place that does not go through undici: it needs the raw body
  // bytes, and `fetch`'s Response is a different (incompatible) type from undici's — kept
  // as-is rather than unified, which would be a refactor.
  let tp: string | null | undefined = _thumbPath.get(ratingKey);
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
