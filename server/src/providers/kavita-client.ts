// Kavita HTTP client. Thin, and deliberately shaped like the endpoints rather than like the
// engine — the media-neutral shape is kavita.js's job, not this file's.
//
// Every endpoint here was called read-only against the live instance on 2026-08-13 and its
// response shape recorded in docs/kavita-feasibility.md §2. Two things that field-check
// caught, which the table alone does not tell you:
//
//   - `POST /api/ReadingList/lists` is a POST, not a GET. Easy to get wrong.
//   - `GET /api/Reader/continue-point` returns a ChapterDto whose `seriesId` is NULL. The
//     caller already knows the series it asked about, so we thread it back in rather than
//     trusting the response (see continuePoint()).
//
// Auth is the API-key -> JWT exchange (§1). The JWT is cached in-process; the API KEY itself
// never leaves providers/config.js's resolution path and is never logged.
import type { ProviderCover } from '../types.js';

import { KAVITA_JWT_TTL_SECONDS } from '../env.js';

// --- the DTOs, as loosely as Kavita actually returns them --------------------- //
//
// None of these are declared in types.ts on purpose: they are a REMOTE API's response
// shapes, not this app's domain shapes, and types.ts models the seam ABOVE this file. Every
// field is optional and each carries an index signature, because the JS this replaces read
// them through `??` fallbacks throughout and a required field here would be an invention —
// a claim about someone else's server that nothing in this repo can hold it to.

/** A Kavita ChapterDto, as `continue-point` / `series-detail` return it. */
export interface KavitaChapterDto {
  id?: number | null;
  number?: string | number;
  minNumber?: number;
  title?: string | null;
  titleName?: string | null;
  range?: string | null;
  pages?: number;
  pagesRead?: number;
  /** NULL on the `continue-point` DTO — threaded back in by continuePoint(). */
  seriesId?: number | string | null;
  [field: string]: unknown;
}

/** A row of `Series/all-v2` / `Series/{id}`. */
export interface KavitaSeriesDto {
  id?: number | string;
  name?: string;
  libraryId?: number | string | null;
  format?: number | null;
  pages?: number | null;
  pagesRead?: number | null;
  [field: string]: unknown;
}

/** `Series/series-detail`. `volumes` is often EMPTY for webtoons — see seriesDetail(). */
export interface KavitaSeriesDetailDto {
  chapters?: KavitaChapterDto[];
  specials?: KavitaChapterDto[];
  volumes?: unknown[];
  unreadCount?: number;
  [field: string]: unknown;
}

export interface KavitaLibraryDto {
  id?: number | string;
  name?: string;
  type?: number;
  [field: string]: unknown;
}

/** One `series` hit off `Search/search` — note `seriesId`, not `id`. */
export interface KavitaSearchSeriesDto {
  seriesId?: number | string;
  name?: string;
  libraryId?: number | string;
  libraryName?: string | null;
  format?: number | null;
  [field: string]: unknown;
}

/** `Search/search` returns more than series (bookmarks, files, people); only this is read. */
export interface KavitaSearchResultDto {
  series?: KavitaSearchSeriesDto[];
  [field: string]: unknown;
}

export interface KavitaReadingListDto {
  id?: number | string;
  title?: string;
  ownerUserName?: string;
  [field: string]: unknown;
}

export interface KavitaReadingListItemDto {
  chapterId?: number | string;
  seriesId?: number | string;
  order?: number;
  pagesRead?: number;
  pagesTotal?: number;
  lastReadingProgressUtc?: string | null;
  [field: string]: unknown;
}

/**
 * What `kavitaClient()` returns, named so `kavita.js` and the tests can refer to the seam.
 *
 * Deliberately an interface rather than `ReturnType<typeof kavitaClient>`: the offline gates
 * inject a hand-written stub with exactly these members, and a named type is what tells the
 * next person which ones a stub has to grow.
 */
export interface KavitaHttpClient {
  /** The base URL, read by kavita.js to build the reader deep link. */
  _base: string;
  whoami(): Promise<string | null>;
  libraries(): Promise<KavitaLibraryDto[] | null>;
  continuePoint(seriesId: number | string): Promise<KavitaChapterDto | null>;
  seriesDetail(seriesId: number | string): Promise<KavitaSeriesDetailDto | null>;
  search(q: string): Promise<KavitaSearchResultDto | null>;
  series(seriesId: number | string): Promise<KavitaSeriesDto | null>;
  cover(seriesId: number | string): Promise<ProviderCover>;
  seriesForLibrary(
    libraryId: number | string,
    opts?: { pageSize?: number },
  ): Promise<KavitaSeriesDto[] | null>;
  readingListItems(readingListId: number | string): Promise<KavitaReadingListItemDto[] | null>;
  readingLists(opts?: { pageNumber?: number; pageSize?: number }): Promise<KavitaReadingListDto[] | null>;
  nextChapter(
    readingListId: number | string,
    currentChapterId: number | string,
    seriesId: number | string,
  ): Promise<number | string | null>;
  chapterProgress(chapterId: number | string): Promise<unknown>;
  createList(title: string): Promise<KavitaReadingListDto | number | string | null>;
  addChapter(
    readingListId: number | string,
    seriesId: number | string,
    chapterId: number | string,
  ): Promise<unknown>;
  removeRead(readingListId: number | string): Promise<unknown>;
  deleteList(readingListId: number | string): Promise<unknown>;
}

/** The `fetch` seam. Widened from `typeof fetch` only in that the tests pass a plain URL. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface KavitaClientOptions {
  baseUrl?: string;
  apiKey?: string;
  pluginName?: string;
  fetchImpl?: FetchLike | null;
}

// MangaFormat, as Kavita's enum orders it. Load-bearing for the reader deep link: the
// feasibility record §3 read getNavigationArray() out of the live Angular bundle, and it
// picks the reader variant off exactly this value.
export const FORMAT = {
  IMAGE: 0, ARCHIVE: 1, UNKNOWN: 2, EPUB: 3, PDF: 4,
};

/** The reader path segment for a series format — `book` for EPUB, `pdf` for PDF, else `manga`. */
export function readerSegment(seriesFormat: number | null | undefined): string {
  if (seriesFormat === FORMAT.EPUB) return 'book';
  if (seriesFormat === FORMAT.PDF) return 'pdf';
  return 'manga';
}

/**
 * Build a client bound to one base URL + API key.
 * `fetchImpl` exists so the offline tests can stub HTTP and run with no token and no network.
 */
export function kavitaClient({
  baseUrl, apiKey, pluginName = 'queuepilot', fetchImpl = null,
}: KavitaClientOptions = {}): KavitaHttpClient {
  if (!baseUrl) throw new Error('kavitaClient needs a baseUrl');
  if (!apiKey) throw new Error('kavitaClient needs an apiKey');
  // Narrowed ONCE, here: the two closures below capture `apiKey`, and a captured parameter
  // does not keep the narrowing the guard above just proved.
  const key: string = apiKey;
  const base = String(baseUrl).replace(/\/+$/, '');
  const doFetch: FetchLike = fetchImpl || globalThis.fetch;

  let jwt: string | null = null;
  let jwtAt = 0;
  let inflight: Promise<string | null> | null = null;

  async function authenticate(): Promise<{ token: string; username: string | null }> {
    // The API key goes in the query string because that is the endpoint's contract. It must
    // therefore never reach a log line — hence the scrubbed message below.
    const url = `${base}/api/Plugin/authenticate`
      + `?apiKey=${encodeURIComponent(key)}&pluginName=${encodeURIComponent(pluginName)}`;
    const res = await doFetch(url, { method: 'POST' });
    if (!res.ok) {
      throw new Error(`kavita auth failed: HTTP ${res.status} from ${base}/api/Plugin/authenticate`);
    }
    const data = await res.json() as { token?: string; username?: string | null } | null;
    if (!data?.token) throw new Error('kavita auth returned no token');
    return { token: data.token, username: data.username ?? null };
  }

  async function token(): Promise<string | null> {
    const fresh = jwt && (Date.now() - jwtAt) / 1000 < KAVITA_JWT_TTL_SECONDS;
    if (fresh) return jwt;
    // Collapse concurrent misses onto one exchange — a rotation start fans out per series.
    if (!inflight) {
      inflight = authenticate()
        .then((r) => { jwt = r.token; jwtAt = Date.now(); return jwt; })
        .finally(() => { inflight = null; });
    }
    return inflight;
  }

  /**
   * One authenticated call. `T` is the caller's claim about the response body and is a CAST,
   * not a validation — see the DTO block above for why nothing here is validated.
   */
  async function req<T>(
    method: string,
    path: string,
    { body = null, retryOn401 = true }: { body?: unknown; retryOn401?: boolean } = {},
  ): Promise<T | null> {
    const t = await token();
    const headers: Record<string, string> = { Authorization: `Bearer ${t}` };
    if (body != null) headers['Content-Type'] = 'application/json';
    const res = await doFetch(`${base}${path}`, {
      method,
      headers,
      ...(body != null ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 401 && retryOn401) {
      // The cached JWT expired mid-flight. Re-mint once, then give up rather than looping.
      jwt = null;
      jwtAt = 0;
      return req<T>(method, path, { body, retryOn401: false });
    }
    if (!res.ok) throw new Error(`kavita ${method} ${path} -> HTTP ${res.status}`);
    if (res.status === 204) return null;
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      // next-chapter/prev-chapter answer with a bare number, not JSON.
      return text as T;
    }
  }

  return {
    _base: base,

    /** Who this API key belongs to. §6: lists must be built as the reading user, not admin. */
    async whoami() {
      const r = await authenticate();
      jwt = r.token;
      jwtAt = Date.now();
      return r.username;
    },

    libraries: () => req<KavitaLibraryDto[]>('GET', '/api/Library/libraries'),

    /**
     * Next unread chapter of a series, or null when the series is finished.
     * Kavita leaves `seriesId` null on this DTO, so it is threaded back in from the argument.
     */
    async continuePoint(seriesId) {
      const ch = await req<KavitaChapterDto>('GET', `/api/Reader/continue-point?seriesId=${encodeURIComponent(seriesId)}`);
      if (!ch || ch.id == null) return null;
      return { ...ch, seriesId: ch.seriesId ?? Number(seriesId) };
    },

    /**
     * Every chapter of a series, with per-chapter read state — the run a multi-chapter batch
     * needs. `continue-point` answers "what is next" in one call and is cheaper, so this is
     * only used when a batch of more than one is actually asked for.
     *
     * Note `volumes` is often EMPTY for webtoons (verified live: a 269-chapter webtoon
     * reports 0 volumes), so chapter order — not volume grouping — is the only reliable
     * spine here.
     */
    seriesDetail: (seriesId) => req<KavitaSeriesDetailDto>('GET', `/api/Series/series-detail?seriesId=${encodeURIComponent(seriesId)}`),

    /**
     * Free-text search across series. Returns more than series (bookmarks, files, people);
     * only `series` is of interest here, and `includeChapterAndFiles=false` keeps the
     * response from carrying file paths we have no use for.
     */
    search: (q) => req<KavitaSearchResultDto>(
      'GET',
      `/api/Search/search?queryString=${encodeURIComponent(q)}&includeChapterAndFiles=false`,
    ),

    /** One series' metadata, for resolving a stored member id back to a name. */
    series: (seriesId) => req<KavitaSeriesDto>('GET', `/api/Series/${encodeURIComponent(seriesId)}`),

    /**
     * The cover image bytes for a series.
     *
     * The endpoint requires the API key as a QUERY PARAMETER, which is exactly the hazard
     * docs/kavita-feasibility.md flags about `/api/opds/<apiKey>`: a live credential in a
     * URL. So this returns BYTES for the app to re-serve, and the browser is never handed a
     * Kavita image URL — the key stays server-side, out of the page source, out of the
     * network tab, and out of any screenshot. Mirrors what /api/thumb already does for Plex.
     */
    async cover(seriesId) {
      const url = `${base}/api/Image/series-cover`
        + `?seriesId=${encodeURIComponent(seriesId)}&apiKey=${encodeURIComponent(key)}`;
      const res = await doFetch(url);
      if (!res.ok) throw new Error(`kavita cover ${seriesId} -> HTTP ${res.status}`);
      return {
        buffer: Buffer.from(await res.arrayBuffer()),
        contentType: res.headers.get('content-type') || 'image/png',
      };
    },

    /** Series in a library, newest-progress-first is NOT guaranteed — caller orders. */
    seriesForLibrary: (libraryId, { pageSize = 500 } = {}) => req<KavitaSeriesDto[]>(
      'POST',
      `/api/Series/all-v2?PageNumber=1&PageSize=${pageSize}`,
      // field 19 = libraryId, comparison 0 = equal, combination 1 = AND. This filter shape is
      // Kavita's SmartFilter encoding and was verified live.
      { body: { statements: [{ comparison: 0, field: 19, value: String(libraryId) }], combination: 1, limitTo: 0 } },
    ),

    /** The whole queue's completion state in ONE call (§6, "poll, don't subscribe"). */
    readingListItems: (readingListId) => req<KavitaReadingListItemDto[]>('GET', `/api/ReadingList/items?readingListId=${encodeURIComponent(readingListId)}`),

    /** Enumerate reading lists. POST, not GET. */
    readingLists: ({ pageNumber = 1, pageSize = 100 } = {}) => req<KavitaReadingListDto[]>(
      'POST',
      `/api/ReadingList/lists?pageNumber=${pageNumber}&pageSize=${pageSize}`,
      { body: {} },
    ),

    /** -1 at the end of the list, per §2. */
    nextChapter: (readingListId, currentChapterId, seriesId) => req<number | string>(
      'GET',
      `/api/ReadingList/next-chapter?readingListId=${readingListId}`
      + `&currentChapterId=${currentChapterId}&seriesId=${seriesId}`,
    ),

    chapterProgress: (chapterId) => req<unknown>('GET', `/api/Reader/get-progress?chapterId=${encodeURIComponent(chapterId)}`),

    // --- writes ---------------------------------------------------------------- //
    // Never exercised against the live instance during feasibility (it was a read-only
    // session); the spec is the reference. They are covered offline with a stubbed fetch.

    createList: (title) => req<KavitaReadingListDto | number | string>('POST', '/api/ReadingList/create', { body: { title } }),

    /** Append one chapter. N calls in order is the documented way to build an ordered list —
     *  update-position moves a single item at a time, so building in order is cheaper. */
    addChapter: (readingListId, seriesId, chapterId) => req<unknown>(
      'POST',
      '/api/ReadingList/update-by-chapter',
      { body: { readingListId, seriesId, chapterId } },
    ),

    removeRead: (readingListId) => req<unknown>('POST', `/api/ReadingList/remove-read?readingListId=${readingListId}`),

    deleteList: (readingListId) => req<unknown>('DELETE', `/api/ReadingList?readingListId=${readingListId}`),
  };
}
