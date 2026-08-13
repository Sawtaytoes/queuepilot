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
import { KAVITA_JWT_TTL_SECONDS } from '../env.js';

// MangaFormat, as Kavita's enum orders it. Load-bearing for the reader deep link: the
// feasibility record §3 read getNavigationArray() out of the live Angular bundle, and it
// picks the reader variant off exactly this value.
export const FORMAT = { IMAGE: 0, ARCHIVE: 1, UNKNOWN: 2, EPUB: 3, PDF: 4 };

/** The reader path segment for a series format — `book` for EPUB, `pdf` for PDF, else `manga`. */
export function readerSegment(seriesFormat) {
  if (seriesFormat === FORMAT.EPUB) return 'book';
  if (seriesFormat === FORMAT.PDF) return 'pdf';
  return 'manga';
}

/**
 * Build a client bound to one base URL + API key.
 * @param {{baseUrl: string, apiKey: string, pluginName?: string, fetchImpl?: Function}} opts
 * `fetchImpl` exists so the offline tests can stub HTTP and run with no token and no network.
 */
export function kavitaClient({ baseUrl, apiKey, pluginName = 'queuepilot', fetchImpl = null } = {}) {
  if (!baseUrl) throw new Error('kavitaClient needs a baseUrl');
  if (!apiKey) throw new Error('kavitaClient needs an apiKey');
  const base = String(baseUrl).replace(/\/+$/, '');
  const doFetch = fetchImpl || globalThis.fetch;

  let jwt = null;
  let jwtAt = 0;
  let inflight = null;

  async function authenticate() {
    // The API key goes in the query string because that is the endpoint's contract. It must
    // therefore never reach a log line — hence the scrubbed message below.
    const url = `${base}/api/Plugin/authenticate`
      + `?apiKey=${encodeURIComponent(apiKey)}&pluginName=${encodeURIComponent(pluginName)}`;
    const res = await doFetch(url, { method: 'POST' });
    if (!res.ok) {
      throw new Error(`kavita auth failed: HTTP ${res.status} from ${base}/api/Plugin/authenticate`);
    }
    const data = await res.json();
    if (!data?.token) throw new Error('kavita auth returned no token');
    return { token: data.token, username: data.username ?? null };
  }

  async function token() {
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

  async function req(method, path, { body = null, retryOn401 = true } = {}) {
    const t = await token();
    const headers = { Authorization: `Bearer ${t}` };
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
      return req(method, path, { body, retryOn401: false });
    }
    if (!res.ok) throw new Error(`kavita ${method} ${path} -> HTTP ${res.status}`);
    if (res.status === 204) return null;
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      // next-chapter/prev-chapter answer with a bare number, not JSON.
      return text;
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

    libraries: () => req('GET', '/api/Library/libraries'),

    /**
     * Next unread chapter of a series, or null when the series is finished.
     * Kavita leaves `seriesId` null on this DTO, so it is threaded back in from the argument.
     */
    async continuePoint(seriesId) {
      const ch = await req('GET', `/api/Reader/continue-point?seriesId=${encodeURIComponent(seriesId)}`);
      if (!ch || ch.id == null) return null;
      return { ...ch, seriesId: ch.seriesId ?? Number(seriesId) };
    },

    /** Series in a library, newest-progress-first is NOT guaranteed — caller orders. */
    seriesForLibrary: (libraryId, { pageSize = 500 } = {}) => req(
      'POST',
      `/api/Series/all-v2?PageNumber=1&PageSize=${pageSize}`,
      // field 19 = libraryId, comparison 0 = equal, combination 1 = AND. This filter shape is
      // Kavita's SmartFilter encoding and was verified live.
      { body: { statements: [{ comparison: 0, field: 19, value: String(libraryId) }], combination: 1, limitTo: 0 } },
    ),

    /** The whole queue's completion state in ONE call (§6, "poll, don't subscribe"). */
    readingListItems: (readingListId) => req('GET', `/api/ReadingList/items?readingListId=${encodeURIComponent(readingListId)}`),

    /** Enumerate reading lists. POST, not GET. */
    readingLists: ({ pageNumber = 1, pageSize = 100 } = {}) => req(
      'POST',
      `/api/ReadingList/lists?pageNumber=${pageNumber}&pageSize=${pageSize}`,
      { body: {} },
    ),

    /** -1 at the end of the list, per §2. */
    nextChapter: (readingListId, currentChapterId, seriesId) => req(
      'GET',
      `/api/ReadingList/next-chapter?readingListId=${readingListId}`
      + `&currentChapterId=${currentChapterId}&seriesId=${seriesId}`,
    ),

    chapterProgress: (chapterId) => req('GET', `/api/Reader/get-progress?chapterId=${encodeURIComponent(chapterId)}`),

    // --- writes ---------------------------------------------------------------- //
    // Never exercised against the live instance during feasibility (it was a read-only
    // session); the spec is the reference. They are covered offline with a stubbed fetch.

    createList: (title) => req('POST', '/api/ReadingList/create', { body: { title } }),

    /** Append one chapter. N calls in order is the documented way to build an ordered list —
     *  update-position moves a single item at a time, so building in order is cheaper. */
    addChapter: (readingListId, seriesId, chapterId) => req(
      'POST',
      '/api/ReadingList/update-by-chapter',
      { body: { readingListId, seriesId, chapterId } },
    ),

    removeRead: (readingListId) => req('POST', `/api/ReadingList/remove-read?readingListId=${readingListId}`),

    deleteList: (readingListId) => req('DELETE', `/api/ReadingList?readingListId=${readingListId}`),
  };
}
