// The Kavita provider — the reading half of the media-neutral seam.
//
// The asymmetry that shapes this whole file: KAVITA HAS NO CAST AND NO WEBHOOKS
// (docs/kavita-feasibility.md §4 — `Device/send-to` is Send-to-Kindle *email*). So:
//
//   - handoff() returns a URL instead of pushing. Reading is PULL: you pick up the tablet
//     when you are ready, where TV is PUSH: the card starts the show on a screen already on.
//   - progress is POLLED, not subscribed. SignalR's UserProgressUpdate reaches ADMIN
//     connections only (`onlyAdmins` defaults true in EventHub.cs and ReaderService never
//     overrides it). It would happen to work here because this account IS the admin, which
//     makes it load-bearing on an incidental privilege that breaks silently for anyone else.
//
// Do not try to make reading behave like the Shield push path. The materialize/handoff split
// exists precisely so it does not have to.
import type {
  BucketsContext,
  BucketsResult,
  KavitaArtifact,
  KavitaPlayItem,
  KavitaProgressState,
  Provider,
  ProviderDefinition,
  ProviderLibrary,
  ProviderPoolBucket,
  ProviderSearchHit,
  PullResult,
  Start,
  UnitList,
} from '../types.js';
import type {
  KavitaChapterDto,
  KavitaHttpClient,
  KavitaSeriesDetailDto,
  KavitaSeriesDto,
  KavitaVolumeDto,
} from './kavita-client.js';

import { kavitaClient, readerSegment } from './kavita-client.js';
import { errMessage } from '../errors.js';
import { KAVITA_BATCH_DEFAULT, ROTATION_LENGTH } from '../env.js';
import { initialQueueSize, playbackLength } from '../engine/playbackLength.js';

/**
 * One interleave bucket: a series and the unread chapters this scan may draw from it.
 *
 * Local, not in types.ts, because it never crosses the seam — `buckets()` returns it on
 * `BucketsResult.buckets`, which is declared `unknown[]` there precisely because it is the
 * provider's own bookkeeping.
 */
interface KavitaSeriesBucket {
  key: string;
  title: string | undefined;
  seriesId: number | string | undefined;
  libraryId: number | string | null;
  format: number | null;
  /** How many of this series' items one round of the interleave takes — its own batch. */
  batch?: number;
  items: KavitaPlayItem[];
}

/** A pool row before it is mapped into the Plex-shaped `ProviderPoolBucket` the grid renders. */
interface KavitaPoolRow {
  seriesId: number | string | undefined;
  title: string | undefined;
  libraryId: number | string | null;
  format: number | null;
  unreadCount: number;
  items: KavitaPlayItem[];
}

/** One row of `resolveMembers()`. Nothing calls it today (see the note on the method). */
interface KavitaMemberRow {
  id: string;
  title: string | undefined;
  libraryId: string;
  format: number | null;
  pagesRead: number | null;
  pages: number | null;
  type: string;
}

export interface KavitaProviderOptions {
  def?: ProviderDefinition | null;
  apiKey?: string;
  client?: KavitaHttpClient | null;
}

// How many continue-point probes run at once. One call per series, and a real library here
// has ~100 series with something unread: serially that measured 4.7s against the live
// instance, which is dead time on a 302 the owner is waiting through after tapping a
// bookmark. Bounded rather than unbounded because this is someone's self-hosted Kavita, not
// a CDN — a 100-wide burst is a denial-of-service impression.
const PROBE_CONCURRENCY = 8;

// The pool view pays one call per series and is an explicit "show me everything" action, so
// it runs wider than a launch does. Still bounded — this is a self-hosted Kavita, not a CDN.
const POOL_CONCURRENCY = 16;

/**
 * Is this chapter actually unread?
 *
 * ⚠️ `Reader/continue-point` is "where would you resume", NOT "the next unread chapter".
 * On a FULLY READ series it WRAPS and hands back chapter 1, already read — verified live on
 * six Webtoons series (e.g. "Ultimate Shut-in", continue-point chapter 1 at 183/183 pages
 * with `unreadCount: 0`). Taking it at face value re-queues finished series forever, which
 * is the opposite of the read-state-is-the-done-store property the design relies on.
 *
 * So every continue-point answer is checked against its own page counters before it is
 * allowed into a lineup.
 */
function isUnread(ch: KavitaChapterDto | null): ch is KavitaChapterDto {
  if (!ch || ch.id == null) return false;
  const pages = ch.pages ?? 0;
  if (pages <= 0) return true; // unknown length — do not silently drop it
  return (ch.pagesRead ?? 0) < pages;
}

/**
 * Kavita's "this file is not subdivided into chapters" sentinel (`Parser.DefaultChapterNumber`).
 * Every chapter of a VOLUME-based manga carries it, so a volume of Alice in Borderland arrives
 * as `number: '-100000'`. Rendering that verbatim gives a tile reading "Ch -100000".
 */
const NO_CHAPTER_NUMBER = -100000;

const isWholeVolume = (ch: KavitaChapterDto): boolean => (
  Number(ch.minNumber ?? ch.number) === NO_CHAPTER_NUMBER
);

/**
 * One unread chapter plus the volume it came from (null for a loose chapter).
 *
 * The volume is carried rather than discarded because it is the only place the reader's
 * actual unit of progress is named: for a volume-based series the chapter number is the
 * sentinel above, and "Volume 3" lives on the volume alone.
 */
interface UnreadEntry {
  chapter: KavitaChapterDto;
  volume: KavitaVolumeDto | null;
}

/** One lineup item from a Kavita ChapterDto. `seriesId` is threaded in — Kavita leaves it null. */
function chapterItem(
  entry: UnreadEntry | KavitaChapterDto,
  seriesId: number | string | undefined,
): KavitaPlayItem {
  // Accepts a bare chapter too: the `continue-point` path (perSeries <= 1) has no volume to
  // offer, and inventing one there would be a lie about what Kavita answered.
  const { chapter: ch, volume } = 'chapter' in entry
    ? entry as UnreadEntry
    : { chapter: entry as KavitaChapterDto, volume: null };
  // A whole-volume chapter is presented AS the volume: that is what the reader opens, what
  // Kavita's own UI calls it, and the only number that means anything to a person.
  const asVolume = isWholeVolume(ch) && volume != null;
  return {
    // `id` is optional on the DTO and every caller has already proved it non-null (isUnread /
    // orderedUnread both reject a chapter without one), so this asserts rather than defaults —
    // a `?? 0` here would mint a chapter id that does not exist.
    chapterId: ch.id as number,
    seriesId: seriesId as number | string,
    title: asVolume
      ? (volume.name || `Volume ${volume.number ?? volume.minNumber ?? '?'}`)
      : (ch.titleName || ch.title || ch.range || String(ch.number)),
    number: asVolume ? (volume.number ?? volume.minNumber) : ch.number,
    // What this item IS, for the tile's wording. Per ITEM and not per provider: one Kavita
    // library holds volume-based manga beside chapter-based webtoons, so `provider.unit` is
    // the default and this is the correction.
    unit: asVolume ? 'volume' : 'chapter',
    pages: ch.pages,
    pagesRead: ch.pagesRead,
  };
}

/**
 * A series' unread chapters, in reading order.
 *
 * ## Volumes are not optional to read
 *
 * The obvious implementation — `[...detail.chapters, ...detail.specials]` — silently reports
 * every VOLUME-BASED series as fully read, because Kavita puts nothing in either array for
 * one. Verified live: "Alice in Borderland" answers `chapters: 0, specials: 0, volumes: 9`,
 * with all nine chapters hanging off the volumes, 0/328 pages read. The tile said "All read"
 * on a series the owner had never opened.
 *
 * A chapter-based WEBTOON returns the same chapters in BOTH places ("The Sword-Eating
 * Swordmaster": 21 loose chapters AND 21 under volume 1), so the union has to dedupe by
 * chapter `id` or every webtoon chapter would queue twice.
 *
 * This is also the "97 vs 103" discrepancy `pool()` already documented between Kavita's own
 * `unreadCount` and the run parsed here: the missing six were volume-based series, not
 * chapters reporting zero pages.
 *
 * `series-detail` returns every chapter with its own `pagesRead`/`pages`, so the unread run
 * is just a filter — and filtering rather than slicing from the continue point is what makes
 * a gap (an unread chapter behind a read one) lead, exactly as `continue-point` would.
 *
 * Sorted by (volume, chapter) rather than trusted as-returned: the array happened to be
 * ordered on the instance this was verified against, but nothing documents that guarantee —
 * and for a volume-based series the chapter numbers are ALL the sentinel, so a sort on the
 * chapter number alone would leave the volumes in whatever order the wire chose.
 */
function orderedAll(detail: KavitaSeriesDetailDto | null): UnreadEntry[] {
  const loose: UnreadEntry[] = [
    ...(detail?.chapters || []),
    ...(detail?.specials || []),
  ].map((chapter) => ({ chapter, volume: null }));

  const fromVolumes: UnreadEntry[] = (detail?.volumes || []).flatMap((volume) => (
    (volume?.chapters || []).map((chapter) => ({ chapter, volume }))
  ));

  const seen = new Set<number>();
  return [...loose, ...fromVolumes]
    .filter(({ chapter: ch }) => {
      if (!ch || ch.id == null) return false;
      // Dedupe by chapter id — the loose copy wins, which keeps a webtoon's ordering and
      // labelling byte-identical to what it was before volumes were read at all.
      if (seen.has(ch.id)) return false;
      seen.add(ch.id);
      return true;
    })
    .sort((a, b) => (
      (a.volume?.minNumber ?? 0) - (b.volume?.minNumber ?? 0)
      || (a.chapter.minNumber ?? 0) - (b.chapter.minNumber ?? 0)
    ));
}

function orderedUnread(detail: KavitaSeriesDetailDto | null): UnreadEntry[] {
  return orderedAll(detail).filter(({ chapter: ch }) => (
    (ch.pages ?? 0) > 0 && (ch.pagesRead ?? 0) < (ch.pages ?? 0)
  ));
}

function isFullyRead(ch: KavitaChapterDto): boolean {
  const pages = ch.pages ?? 0;
  return pages > 0 && (ch.pagesRead ?? 0) >= pages;
}

/**
 * A start floor {episode} — `episode` is the chapter (or volume) NUMBER, the
 * same field the tile and the picker persist. Earlier unread items are skipped
 * from the pick and never marked read. No start => always.
 */
function atOrAfterStart(entry: UnreadEntry, start: Start | null | undefined): boolean {
  if (!start || start.episode == null) return true;
  const n = Number(chapterItem(entry, 0).number);
  if (!Number.isFinite(n)) return true;
  return n >= start.episode;
}

/** Map with bounded concurrency, preserving input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      // In-bounds by the line above, which is what `noUncheckedIndexedAccess` cannot see.
      out[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return out;
}

// A Reading List is the RUNTIME ARTIFACT, never the store — the same standing argument as
// docs/why-queues-not-plex-playlists.md, which transfers verbatim. A reading list is a static
// list of concrete chapters; a queue is a watched-state-aware recipe that resolves, per user,
// at launch time. The list is rebuilt on launch rather than accumulated.
const LIST_PREFIX = 'QueuePilot';

export const listTitleFor = (setName: string): string => `${LIST_PREFIX} — ${setName}`;

/**
 * The prefix of a lineup that shares the HEAD's Kavita library.
 *
 * Kavita reading-list auto-advance stays INSIDE the manga reader (`history.replaceState`
 * + `init()`, never a remount). Library reading profiles (Webtoon scroll + custom width
 * vs manga paginated + 100% width) are applied only by the route resolver on first open.
 * Crossing a library in one list therefore keeps the previous library's reader. Until
 * Kavita reloads the profile on series change, the list we hand the reader must not
 * cross that boundary. QueuePilot tiles still show the full rotation; the next launch
 * opens the next library as a fresh navigation, which does apply its profile.
 *
 * Items with no `libraryId` stay in the prefix (we cannot split on a missing key).
 */
export function sameLibraryPrefix(items: readonly KavitaPlayItem[]): KavitaPlayItem[] {
  if (!items.length) return [];
  const head = items[0]!.libraryId;
  if (head == null || head === '') return [...items];
  const headKey = String(head);
  const out: KavitaPlayItem[] = [];
  for (const it of items) {
    if (it.libraryId != null && it.libraryId !== '' && String(it.libraryId) !== headKey) {
      break;
    }
    out.push(it);
  }
  return out;
}

/**
 * `client` is injectable so the offline tests can stub HTTP entirely — they run with no
 * token and no network, in the house style.
 */
export function kavitaProvider({ def, apiKey, client = null }: KavitaProviderOptions = {}): Provider {
  if (!def?.base_url && !client) throw new Error(`provider '${def?.id}' has no base_url`);
  const c: KavitaHttpClient = client || kavitaClient({ baseUrl: def?.base_url, apiKey });

  /**
   * The library ids a scope actually covers — the named ones, or EVERY library when the
   * queue named none.
   *
   * An empty checkbox group means "all", not "none"
   * (decision `2026-08-17-no-libraries-checked-means-every-library`), and the difference
   * only shows up on the paths that ENUMERATE a library rather than filter one: an
   * unscoped search has always searched the whole server, while an unscoped pool used to
   * come back empty and read as "nothing to read".
   */
  async function scopeOrEveryLibrary(libraries: readonly string[]): Promise<string[]> {
    const named = libraries.map(String).filter(Boolean);
    if (named.length) return named;
    const libs = await c.libraries();
    return (libs || []).map((l) => String(l.id));
  }

  return {
    id: def?.id || 'kavita',
    kind: 'kavita',
    label: def?.label || 'Kavita',

    /** Pull, not push. The UI must not offer this one a "Play on <device>" target. */
    delivery: 'pull',

    /**
     * What this provider's lineup is COUNTED in. Declared here rather than inferred above the
     * seam, for the same reason `delivery` is: the frontend renders one tile and the words on
     * it ("Ch 113" / "All read" vs "E5" / "All watched") are the provider's fact, not a branch
     * on `kind` somewhere up the stack.
     */
    unit: 'chapter',

    /**
     * Kavita's per-user identity is the API key itself, not a per-request token: reading
     * lists are per-user (`ownerUserName`), and a list built with a different account's key
     * is INVISIBLE to the reader meant to play it — silently, with an empty reader and no
     * error (§6). So the "profile" for this provider is whoever owns the configured key.
     */
    profileToken: async () => c.whoami(),

    /**
     * Free-text series search, scoped to the libraries this queue draws from.
     *
     * Scoped rather than server-wide because an unscoped search offers series the queue
     * could never play — picking "Dungeon Busters" out of Board Game Rulebooks for a
     * Webtoons queue would add an entry that silently never appears in a lineup.
     * `libraries: []` means "no scope given", and searches everything.
     */
    async search(q: string, { libraries = [] }: { libraries?: string[] } = {}): Promise<ProviderSearchHit[]> {
      const query = String(q || '').trim();
      if (!query) return [];
      const scope = new Set(libraries.map(String));
      const res = await c.search(query);
      return (res?.series || [])
        .filter((s) => !scope.size || scope.has(String(s.libraryId)))
        .map((s) => ({
          id: String(s.seriesId),
          // `name` is a REMOTE field and so optional on the DTO, while ProviderSearchHit
          // declares `title: string`. Asserted rather than defaulted to '': a nameless series
          // is a Kavita-side anomaly, and inventing an empty title here would render a blank
          // row that looks pickable. The JS this replaces passed `undefined` through the same
          // way. (Reported: ProviderSearchHit.title / ProviderLibrary.title / the pool's
          // `show` are all string-required against optional wire fields.)
          title: s.name as string,
          libraryId: String(s.libraryId),
          libraryTitle: s.libraryName || null,
          format: s.format ?? null,
          type: 'series',
        }));
    },

    /**
     * Resolve stored member ids back to displayable rows. A member that has vanished from
     * Kavita resolves to null rather than throwing, so one deleted series cannot make a
     * whole channel un-renderable.
     */
    async resolveMembers(ids: Iterable<string>): Promise<KavitaMemberRow[]> {
      const rows = await mapLimit([...ids], PROBE_CONCURRENCY, async (id): Promise<KavitaMemberRow | null> => {
        try {
          const s = await c.series(id);
          if (!s) return null;
          return {
            id: String(s.id ?? id),
            title: s.name,
            libraryId: String(s.libraryId ?? ''),
            format: s.format ?? null,
            pagesRead: s.pagesRead ?? null,
            pages: s.pages ?? null,
            type: 'series',
          };
        } catch {
          return null;
        }
      });
      return rows.filter((r): r is KavitaMemberRow => r != null);
    },

    /**
     * Resolve stored QUEUE/MEMBER ids to poster tiles — title, art, and what is next.
     *
     * The reading analogue of tiles.js, which resolves every entry through PLEX and therefore
     * answers "unresolved" for every Kavita id: no poster, no next-up, just the stored title.
     * That is what the live manga_webtoons channel would have shown for every entry it holds.
     *
     * One `series-detail` per id, like pool() and for the same reason — the series row carries
     * PAGES, never chapters, and a tile says what chapter comes next. Bounded, because this is
     * someone's self-hosted Kavita. Index-aligned with `ids`; a vanished series resolves to
     * null rather than throwing, so one deleted entry cannot make a whole queue un-renderable.
     */
    async tiles(ids) {
      return mapLimit([...ids].map(String), PROBE_CONCURRENCY, async (id) => {
        try {
          const [s, detail] = await Promise.all([c.series(id), c.seriesDetail(id)]);
          if (!s) return null;
          const unread = orderedUnread(detail);
          return {
            id: String(s.id ?? id),
            title: s.name,
            libraryId: String(s.libraryId ?? ''),
            format: s.format ?? null,
            // Chapters left, the same "how much is waiting" the pool tile means.
            unreadCount: detail?.unreadCount ?? unread.length,
            // `unread.length` is the guard `noUncheckedIndexedAccess` cannot see — the same
            // assertion the pool branch below already writes for the same read.
            next: unread.length ? chapterItem(unread[0] as UnreadEntry, Number(id)) : null,
          };
        } catch {
          return null;
        }
      });
    },

    /**
     * Every chapter (or volume) of a series, for the "Start from…" picker.
     *
     * One season: a webtoon has no seasons and a volume-based manga presents each
     * volume as a unit, so `multiSeason: false` hides the season row. `watched` is
     * fully-read, the same badge the Plex picker paints "Watched".
     */
    async listUnits(itemId: string): Promise<UnitList | null> {
      const detail = await c.seriesDetail(itemId);
      const all = orderedAll(detail);
      if (!all.length) return null;
      const episodes = all.map((entry) => {
        const item = chapterItem(entry, itemId);
        const n = Number(item.number);
        return {
          episode: Number.isFinite(n) ? n : null,
          title: item.title || '',
          watched: isFullyRead(entry.chapter),
        };
      });
      return { multiSeason: false, seasons: [{ season: 1, episodes }] };
    },

    /**
     * The channel's eligible POOL — every series with something unread, whether or not it is
     * an explicit member. This is what the Channels view renders, and it is the reading
     * analogue of the Plex rule pool.
     */
    async pool(
      { libraries = [], members = [] }: { libraries?: string[]; members?: string[] } = {},
    ): Promise<ProviderPoolBucket[]> {
      const explicit = members.map(String);
      // No libraries named = EVERY library, the same answer the editor's empty checkbox
      // group promises (decision `2026-08-17-no-libraries-checked-means-every-library`).
      // This used to return an empty pool, so a channel saved without ticking a box read
      // as "nothing to read" rather than "all of it".
      const libIds = await scopeOrEveryLibrary(libraries);
      if (!libIds.length) return [];

      const seriesLists = await Promise.all(libIds.map((id) => c.seriesForLibrary(id)));
      const allSeries = seriesLists.flat().filter((s): s is KavitaSeriesDto => s != null);

      // The pool pays for `series-detail` per series where a launch pays only for
      // `continue-point`, because the grid shows a COUNT and the series list has no chapter
      // count at all — only pages (verified against the live instance: `all-v2` returns
      // pages/pagesRead and nothing chapter-shaped). Pages remaining would read as a wildly
      // larger number than "chapters left" and mean something else. This is a deliberate
      // "show me everything" view, so one extra bounded pass is the right trade; the launch
      // path is untouched and stays cheap.
      const probed = await mapLimit(allSeries, POOL_CONCURRENCY, async (s): Promise<KavitaPoolRow | null> => {
        try {
          const detail = await c.seriesDetail(s.id as number | string);
          const unread = orderedUnread(detail);
          // Kavita's own `unreadCount` is the inclusion test, NOT the length of the run we
          // could parse. They disagree for a handful of series (97 vs 103 live, from
          // chapters reporting 0 pages), and if the pool were the stricter of the two it
          // would show fewer series than a launch actually draws from — a preview that
          // quietly understates the channel.
          const count = detail?.unreadCount ?? unread.length;
          if (!count && !unread.length) return null;
          return {
            seriesId: s.id,
            title: s.name,
            libraryId: s.libraryId ?? null,
            format: s.format ?? null,
            unreadCount: count || unread.length,
            // A series whose unread chapters we could not parse still belongs in the pool;
            // it just has no next-up line to show.
            items: unread.length ? [chapterItem(unread[0] as UnreadEntry, s.id)] : [],
          };
        } catch {
          // One unreadable series must not blank the whole grid.
          return null;
        }
      });
      const buckets = probed.filter((b): b is KavitaPoolRow => b != null);
      // Deliberately the PLEX PREVIEW BUCKET SHAPE — `ratingKey` / `show` / `unwatched` /
      // `next` — rather than a reading-flavoured one. The Channels grid already renders
      // this, so a reading channel needs no second render path, and `ratingKey` is here an
      // OPAQUE provider item id (a Kavita seriesId) rather than a Plex ratingKey. That
      // reading is safe because a queue draws from exactly one provider, so the id is never
      // ambiguous (decision 2026-08-13-a-queue-draws-from-exactly-one-provider).
      return buckets.map((b) => ({
        ratingKey: String(b.seriesId),
        // See the note in search(): a wire-optional name against a string-required field.
        show: b.title as string,
        // Chapters left, not series left — the same "how much is waiting" the Plex tile means.
        unwatched: b.unreadCount ?? b.items.length,
        // A pinned series is still part of the pool; the flag is what lets the grid show
        // which were chosen by hand versus swept in by the rule.
        isMember: explicit.includes(String(b.seriesId)),
        libraryId: b.libraryId == null ? '' : String(b.libraryId),
        next: b.items[0]
          ? {
            ratingKey: String(b.items[0].chapterId),
            title: b.items[0].title,
            // Chapters have no season; `episode` carries the chapter number so the tile's
            // existing "next up" line reads correctly without a reading-specific branch.
            episode: Number(b.items[0].number) || null,
            season: null,
          }
          : null,
      }));
    },

    /** Cover bytes, re-served by the app so the API key never reaches the browser. */
    cover: (seriesId: string) => c.cover(seriesId),

    /** Libraries, for the queue editor's provider block. */
    async libraries(): Promise<ProviderLibrary[]> {
      const libs = await c.libraries();
      // `title: l.name as string` — see the note in search().
      return (libs || []).map((l) => ({ id: String(l.id), title: l.name as string, type: l.type }));
    },

    /**
     * The whole queue's completion state in ONE call — strictly better than the Plex side,
     * which needs a history sweep per profile.
     */
    async progressState(
      { artifactId = null }: { artifactId?: string | number | null } = {},
    ): Promise<KavitaProgressState> {
      if (!artifactId) return { items: [] };
      const items = (await c.readingListItems(artifactId)) || [];
      return {
        items: items.map((it) => ({
          chapterId: it.chapterId as number | string,
          seriesId: it.seriesId as number | string,
          order: it.order as number,
          pagesRead: it.pagesRead as number,
          pagesTotal: it.pagesTotal as number,
          // The comparison is left EXACTLY as it was, undefined and all: `undefined > 0` is
          // false, so a row missing its counters reports not-done — which is the safe answer
          // and the one the JS gave. Coercing with `?? 0` would read the same here and be a
          // silent invention of the remote's data.
          done: (it.pagesTotal as number) > 0 && (it.pagesRead as number) >= (it.pagesTotal as number),
          lastReadAt: it.lastReadingProgressUtc || null,
        })),
      };
    },

    /**
     * The ordered lineup: the next unread chapter(s) of each series this queue draws from,
     * interleaved. `buildRotation` is backend-neutral (it round-robins over bucket objects
     * and never touches Plex), so the shape returned here is deliberately the same bucket
     * shape it already consumes — give it chapter buckets and it interleaves series exactly
     * as it interleaves shows.
     *
     * ## `entries` beat `libraries`, and that is the whole distinction
     *
     * A CURATED queue (`source: queue`) is its entries. A RULE-based channel has none and
     * draws from the libraries instead. This method originally knew only the second case, so
     * a curated reading queue silently played the library shelf: the live "Manga & Webtoons"
     * reading list came back holding twelve series in alphabetical order, exactly ONE of
     * which was among the ninety-three the owner had added. The entries were never read.
     */
    async buckets({
      cfg = {}, libraries = [], entries = [], isRandomOrder = false, batch = null,
      volumeBatch = null, limit = null,
    }: BucketsContext = {}): Promise<BucketsResult> {
      // `cfg` is the routing set config, read here for the fallbacks below only. It is a union
      // in BucketsContext (`RoutingSetCfg | Record<string, unknown>`) and neither `libraries`
      // nor `batch` is on RoutingSetCfg — both live on a provider BLOCK — so they are read
      // through an index view. Only `max_items` is a real set field.
      const cfgAny = cfg as Record<string, unknown>;
      const named = (libraries.length ? libraries : ((cfgAny.libraries as string[] | undefined) || [])).map(String);
      const curated = entries.filter((e) => e && e.id);
      // ENTRIES BEAT LIBRARIES (see this method's header), so the "every library" widening
      // is only asked for on the rule-based branch — a curated queue must never enumerate a
      // shelf, and calling for the library list here would be a request per launch that
      // nothing then reads.
      const libIds = curated.length ? named : await scopeOrEveryLibrary(named);
      if (!curated.length && !libIds.length) return { play: [], buckets: [] };
      // "Read at least X chapters before switching series" — the opening ask in the
      // feasibility record. Per-entry override, else per-queue, else the env default.
      // THIS is the CHAPTER count. A volume is a collection of chapters, not a chapter,
      // so it must not inherit this number (a queue at 3 chapters would otherwise dump
      // three whole manga volumes into one visit).
      const perSeries = Math.max(1, Number(batch ?? cfgAny.batch ?? KAVITA_BATCH_DEFAULT) || 1);
      // Volume count is its own knob. Default 1, always — never the chapter count,
      // never KAVITA_BATCH_DEFAULT. Absent / unusable falls to 1, never to "uncapped".
      const perVolume = Math.max(1, Number(volumeBatch ?? cfgAny.volumes ?? 1) || 1);
      // The SAME cap the Plex rotation runs under. Without it a real library queues
      // everything: Webtoons alone measured 103 series with something unread, which would
      // mean 103 sequential update-by-chapter writes on every launch, for a reading list
      // nobody will reach the end of. A queue is the next while, not the whole backlog.
      // The SAME playback length every other kind of set now runs under, so a reading queue
      // that says "8" gets 8. `limit` (an explicit caller override) and the legacy `max_items`
      // still win where they are set; the fallback is no longer a bare env constant.
      // A reading list is not a SITTING — it is a persistent artifact the tablet pulls from
      // over days, and its natural size is a window rather than "how many before you stop".
      // So a reading queue that states a playback length gets it, and one that says nothing
      // keeps the window it has always had instead of the ordered-queue default of 1.
      const fallback = initialQueueSize(playbackLength(cfgAny, ROTATION_LENGTH));
      const cap = Math.max(1, Number(limit ?? cfgAny.max_items ?? fallback) || fallback);

      // The series this queue may draw from, each carrying the per-visit batch that applies
      // to it. A curated entry's own `episodes:` override rides here; a library series has
      // none and takes the queue default. `start` is the same floor Plex already honours:
      // earlier unread chapters are skipped, never marked read.
      let sources: {
        series: KavitaSeriesDto;
        chapterBatch: number;
        volumeBatch: number;
        start: Start | null;
      }[];
      if (curated.length) {
        const rows = await mapLimit(curated, PROBE_CONCURRENCY, async (e) => {
          try {
            const s = await c.series(e.id);
            // A series deleted in Kavita drops out rather than throwing — one stale entry
            // must not make a ninety-three-entry queue unlaunchable.
            return s ? {
              series: s,
              chapterBatch: Math.max(1, Number(e.batch ?? perSeries) || perSeries),
              volumeBatch: Math.max(1, Number(e.volumes ?? perVolume) || perVolume),
              start: e.start ?? null,
            } : null;
          } catch {
            return null;
          }
        });
        sources = rows.filter((r): r is {
          series: KavitaSeriesDto; chapterBatch: number; volumeBatch: number; start: Start | null;
        } => r != null);
      } else {
        const seriesLists = await Promise.all(libIds.map((id) => c.seriesForLibrary(id)));
        sources = seriesLists.flat()
          .filter((s): s is KavitaSeriesDto => s != null)
          .map((series) => ({
            series, chapterBatch: perSeries, volumeBatch: perVolume, start: null,
          }));
      }

      // One continue-point probe per series, bounded. A series with nothing unread yields no
      // bucket at all, which is what keeps a finished series out of the rotation without a
      // separate "done" store — the read state in Kavita IS the done state.
      const probed = await mapLimit(sources, PROBE_CONCURRENCY, async ({
        series: s, chapterBatch, volumeBatch: volWant, start,
      }): Promise<KavitaSeriesBucket | null> => {
        const bucket = {
          key: `series:${s.id}`,
          title: s.name,
          seriesId: s.id,
          libraryId: s.libraryId ?? null,
          format: s.format ?? null,
        };

        // Cheap path: both counts are 1 and there is no start floor, so continue-point
        // names the single next item whether it is a chapter or a whole volume.
        if (chapterBatch <= 1 && volWant <= 1 && !start) {
          const ch = await c.continuePoint(s.id as number | string);
          if (!isUnread(ch)) return null;
          return { ...bucket, batch: 1, items: [chapterItem(ch, s.id)] };
        }

        // Need the ordered run to know WHAT the series is (volume vs chapter) and
        // therefore WHICH count applies. A volume-based manga must not inherit the
        // chapter count — that is the live "3 chapters" queue dumping 3 volumes.
        const detail = await c.seriesDetail(s.id as number | string);
        const unread = orderedUnread(detail).filter((e) => atOrAfterStart(e, start));
        if (!unread.length) return null;
        const head = chapterItem(unread[0] as UnreadEntry, s.id);
        const want = head.unit === 'volume' ? volWant : chapterBatch;
        return {
          ...bucket,
          batch: want,
          items: unread.slice(0, want).map((e) => chapterItem(e, s.id)),
        };
      });
      const buckets = probed.filter((b): b is KavitaSeriesBucket => b != null);

      // A channel plays in RANDOM order, which is what its editor copy promises and what the
      // Plex side gets from `buildRotation`'s injected rng. Without this a capped curated
      // channel serves the same first `cap` entries in stored order on every single launch —
      // the other eighty-one would never come up.
      if (isRandomOrder) {
        for (let i = buckets.length - 1; i > 0; i -= 1) {
          const j = Math.floor(Math.random() * (i + 1));
          [buckets[i], buckets[j]] = [buckets[j] as KavitaSeriesBucket, buckets[i] as KavitaSeriesBucket];
        }
      }

      // Round-robin each bucket's OWN batch at a time, so a queue reads three chapters of A,
      // then three of B, rather than one-and-switch. Interleaving across buckets (rather than
      // draining one) is what buildRotation does on the Plex side, and it is what makes the
      // queue roll into a different series instead of becoming a single-series binge.
      //
      // Per bucket rather than one global `perSeries`, because an entry may override it — a
      // shared slice width would silently apply one entry's "read 5" to every other series.
      const play: KavitaPlayItem[] = [];
      for (let round = 0; play.length < cap; round += 1) {
        let placedThisRound = false;
        for (const b of buckets) {
          const width = Math.max(1, b.batch ?? perSeries);
          const slice = b.items.slice(round * width, (round + 1) * width);
          for (const it of slice) {
            if (play.length >= cap) break;
            play.push({ ...it, bucket: b.key, seriesFormat: b.format, libraryId: b.libraryId });
            placedThisRound = true;
          }
          if (play.length >= cap) break;
        }
        // Every bucket is exhausted — stop, or this loops forever on a short library.
        if (!placedThisRound) break;
      }
      return { play, buckets };
    },

    /**
     * Build the Reading List. Rebuilt on launch, in order — `update-position` moves a single
     * item at a time, so building in order is both cheaper and the documented approach.
     *
     * Unlike Plex's playQueue, a Reading List PERSISTS and is visible in Kavita's own UI.
     * That is a UX consequence, not a design one: we reuse one list per set rather than
     * littering the user's list view with a new one per launch.
     *
     * Only the first library's run is written (see `sameLibraryPrefix`). Crossing libraries
     * in one list is a Kavita reader-profile bug: the manga reader does not remount, so a
     * manga chapter after two webtoon chapters keeps scroll + custom width.
     */
    async materialize(
      items: KavitaPlayItem[],
      // `setName` is `string | null` on the Provider interface (Plex defaults it to null), but
      // this side names a persistent Reading List with it, so it is narrowed to a string here
      // rather than being made null-safe — a null would title the list "QueuePilot — null",
      // which is what the JS did too. Declared, not fixed.
      { setName = 'queue' }: { setName?: string } = {},
    ): Promise<KavitaArtifact> {
      const title = listTitleFor(setName);
      const existing = ((await c.readingLists({ pageSize: 200 })) || [])
        .find((l) => l.title === title);

      let listId: number | string | null = existing?.id ?? null;
      if (listId == null) {
        const created = await c.createList(title);
        // `create` normally answers with the DTO, but the client falls back to the raw body
        // for a non-JSON response — so a bare id is still accepted here, exactly as before.
        listId = (typeof created === 'object' && created ? created.id : created) ?? null;
      } else {
        // CLEAR IT FIRST. This method's own docstring has always said the list is "rebuilt on
        // launch … rather than accumulated", and the code did the opposite: it found the
        // existing list and appended to it, forever. The live list reached 23 series — every
        // lineup ever built for this set, unioned — and the owner reported it as "stuff I
        // absolutely did NOT add".
        //
        // The list is the RUNTIME ARTIFACT, never the store: what belongs in it is exactly
        // this launch's lineup, so anything already there is last launch's answer to a
        // question nobody is asking again.
        //
        // Items are removed rather than the list being deleted and recreated, because the
        // list's ID is user-visible — it is the `/lists/153` the owner had open in Kavita —
        // and a fresh id per launch would break every bookmark and every link Kavita's own UI
        // renders to it.
        //
        // Best-effort per item: one row that refuses to delete must not abort the rebuild and
        // leave the reader with no lineup at all. A leftover row is visible and self-corrects
        // on the next launch; a thrown error here is a dead card.
        const stale = (await c.readingListItems(listId)) || [];
        for (const row of stale) {
          if (row?.id == null) continue;
          try {
            await c.deleteItem(listId, row.id);
          } catch (e) {
            console.log(`[kavita] could not clear list item ${row.id}: ${errMessage(e)}`);
          }
        }
      }
      // The tiles still show the full rotation. The list the reader auto-advances
      // through stops at the first library change — otherwise Kavita keeps the
      // previous library's reading profile (webtoon scroll on a paginated manga).
      const forList = sameLibraryPrefix(items);
      for (const it of forList) {
        await c.addChapter(listId as number | string, it.seriesId, it.chapterId);
      }
      const head = items[0] || null;
      return {
        provider: this.id,
        kind: 'kavita',
        readingListId: listId,
        title,
        setName,
        head,
        count: forList.length,
      };
    },

    /**
     * Keep a refilling reading queue's list stocked — the pull-side counterpart to extending
     * a Plex playQueue.
     *
     * THE LIST IS A SLIDING WINDOW, not an append-only log. Owner, 2026-08-17: "we should
     * probably remove some older list items when topping up to prevent the list from getting
     * too long". So a top-up appends at the tail AND drops the rows that are fully read.
     *
     * That trim is what keeps the 2026-08-15 decision intact rather than reopening it. That
     * record exists because `materialize()` silently appended forever and the live list
     * reached 23 series — "stuff I absolutely did NOT add". A window that trims is still
     * exactly this launch's lineup; a window that only grows is that bug by another door.
     *
     * Progress is read HERE, on demand, at the moment of the tick — no poll loop and no
     * subscription, per the 2026-08-16 decision. Kavita cannot push (SignalR
     * `UserProgressUpdate` is admin-only), so "on demand" is all there is; the MQTT tick is
     * simply a new kind of demand.
     *
     * The list ID is never recreated: it is the `/lists/153` the owner has open in a tab.
     */
    async topupList(
      { setName, window, at, build }: {
        setName: string;
        window: number;
        at: number;
        build: () => Promise<KavitaPlayItem[]>;
      },
    ): Promise<{ ok: boolean; reason?: string; added?: number; trimmed?: number; unread?: number }> {
      const title = listTitleFor(setName);
      const list = ((await c.readingLists({ pageSize: 200 })) || []).find((l) => l.title === title);
      // No list means nothing was ever launched for this set. Building one here would put a
      // lineup in front of a reader who did not ask for one.
      if (!list?.id) return { ok: true, reason: 'no reading list for this set yet' };

      const rows = (await c.readingListItems(list.id)) || [];
      // Unread = the chapter is not finished. `pagesRead < pages` is the same test the tile
      // grid uses; a row with no page count at all is counted as unread rather than dropped,
      // because treating unknown as "read" would trim a chapter nobody has opened.
      const isRead = (r: { pagesRead?: number; pagesTotal?: number }) =>
        typeof r.pagesTotal === 'number' && r.pagesTotal > 0 && (r.pagesRead ?? 0) >= r.pagesTotal;
      const unread = rows.filter((r) => !isRead(r)).length;
      if (unread > at) return { ok: true, reason: `${unread} unread, tops up at ${at}`, unread };

      const want = Math.max(0, window - unread);
      const alreadyChapters = new Set(rows.map((r) => String(r.chapterId)));
      const fresh = (await build())
        .filter((it) => !alreadyChapters.has(String(it.chapterId)))
        .slice(0, want);

      let added = 0;
      for (const it of fresh) {
        // Best-effort per item, like the rebuild path: one chapter that refuses to add must
        // not abort the top-up and leave the reader with the same short list.
        try {
          await c.addChapter(list.id, it.seriesId, it.chapterId);
          added += 1;
        } catch { /* keep going */ }
      }

      // Trim AFTER adding, never before: `remove-read` on a list whose unread tail is about
      // to be replaced would leave the reader momentarily holding an empty list, and this
      // runs while they may be mid-chapter.
      let trimmed = 0;
      if (added) {
        try {
          await c.removeRead(list.id);
          const after = (await c.readingListItems(list.id)) || [];
          trimmed = Math.max(0, rows.length + added - after.length);
        } catch { /* a list that keeps its read rows is untidy, not broken */ }
      }
      return { ok: true, added, trimmed, unread };
    },

    /**
     * The substitute for cast: a deep link into the reader, in reading-list mode.
     *
     * `?readingListId=` is what makes next/prev resolve through the LIST rather than the
     * series, so finishing a chapter rolls straight into a chapter of a different series
     * without leaving the reader — in place, via history.replaceState. That auto-advance is
     * native; it is the piece playback.js has to hand-build and push for Plex.
     *
     * The `manga` / `book` / `pdf` segment is chosen by the chapter's seriesFormat. A
     * MIXED-FORMAT list bounces the reader between variants, which is why a queue should stay
     * format-homogeneous (§3, §7).
     */
    handoff(artifact: KavitaArtifact): PullResult {
      const head = artifact.head;
      if (!head) {
        return { mode: 'pull', url: null, error: `reading list '${artifact.title}' is empty` };
      }
      const seg = readerSegment(head.seriesFormat);
      const url = `${c._base}/library/${head.libraryId}/series/${head.seriesId}`
        + `/${seg}/${head.chapterId}`
        + `?incognitoMode=false&readingListId=${artifact.readingListId}`;
      return {
        mode: 'pull',
        url,
        readingListId: artifact.readingListId,
        // No device, no push, no "playing" state to publish. The caller must not wait for a
        // session to appear the way the Plex path does.
        awaiting: null,
      };
    },
  };
}
