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
import { readingListCoverBase64 } from './kavita-cover.js';
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

// How many series-detail probes run at once. One call per series, and a real library here
// has ~100 series with something unread. Bounded rather than unbounded because this is
// someone's self-hosted Kavita, not a CDN — a 100-wide burst is a denial-of-service
// impression. (An earlier continue-point shortcut was dropped: it named the next chapter
// without its volume, which broke volume labelling and the volumes-first order.)
const PROBE_CONCURRENCY = 8;

// The pool view pays one call per series and is an explicit "show me everything" action, so
// it runs wider than a launch does. Still bounded — this is a self-hosted Kavita, not a CDN.
const POOL_CONCURRENCY = 16;

/**
 * Kavita's "this file is not subdivided into chapters" sentinel (`Parser.DefaultChapterNumber`).
 * Every chapter of a VOLUME-based manga carries it, so a volume of Alice in Borderland arrives
 * as `number: '-100000'`. Rendering that verbatim gives a tile reading "Ch -100000".
 *
 * It is NOT the only shape. Some tankobon libraries parse each volume file as
 * `number: '1'` / title "Chapter 1" — every volume identical — and Kavita's own series
 * view still labels them Vol. N. The sole-chapter-of-a-volume rule below catches that.
 */
const NO_CHAPTER_NUMBER = -100000;

/**
 * Is this chapter the volume itself (one file = one volume), rather than a chapter inside it?
 *
 * Two live shapes both mean "the volume":
 *   1. The `-100000` sentinel (Alice in Borderland, Skeleton Knight).
 *   2. Exactly one chapter hanging off the volume, even when Kavita numbered it `1`
 *      (Otherworldly Munchkin — every volume file titled "Chapter 1").
 *
 * A webtoon puts many chapters under volume 1, so (2) does not fire and they stay chapters.
 */
function isWholeVolume(ch: KavitaChapterDto, volume: KavitaVolumeDto | null): boolean {
  if (volume == null) return false;
  if (Number(ch.minNumber ?? ch.number) === NO_CHAPTER_NUMBER) return true;
  return (volume.chapters?.length ?? 0) === 1;
}

/**
 * One unread chapter plus the volume it came from (null for a loose chapter).
 *
 * The volume is carried rather than discarded because it is the only place the reader's
 * actual unit of progress is named: for a volume-based series the chapter number is often
 * the sentinel (or a repeated "1"), and "Volume 3" lives on the volume alone.
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
  // Accepts a bare chapter too: a continue-point answer has no volume on the wire. Prefer
  // the UnreadEntry form whenever series-detail is available — without the volume, a
  // whole-volume chapter cannot be labelled as one.
  const { chapter: ch, volume } = 'chapter' in entry
    ? entry as UnreadEntry
    : { chapter: entry as KavitaChapterDto, volume: null };
  // A whole-volume chapter is presented AS the volume: that is what the reader opens, what
  // Kavita's own UI calls it, and the only number that means anything to a person.
  const asVolume = isWholeVolume(ch, volume);
  return {
    // `id` is optional on the DTO and every caller has already proved it non-null
    // (orderedUnread rejects a chapter without one), so this asserts rather than defaults —
    // a `?? 0` here would mint a chapter id that does not exist.
    chapterId: ch.id as number,
    seriesId: seriesId as number | string,
    title: asVolume
      ? (volume!.name || `Volume ${volume!.number ?? volume!.minNumber ?? '?'}`)
      : (ch.titleName || ch.title || ch.range || String(ch.number)),
    number: asVolume ? (volume!.number ?? volume!.minNumber) : ch.number,
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
 * ## Volumes before loose chapters
 *
 * A MIXED series (tankobon volumes AND weekly chapter releases) must not lead with the
 * newest chapter. Volumes are the real catch-up read; loose chapters are the brand-new
 * ones that sit ahead of the latest volume. Sorting by
 * `(volume?.minNumber ?? 0, chapter)` put every loose chapter at "volume 0" and therefore
 * FIRST — which is how a queue with `batch: 3` opened on chapter 48.5 of a series whose
 * Volume 1 was still unread. Volumes go first (by volume number); loose chapters follow
 * (by chapter number). Decision: `2026-08-22-volumes-read-before-loose-chapters`.
 *
 * ## The volume copy wins the dedupe
 *
 * The same chapter id often appears loose AND under a volume. Preferring the loose copy
 * (the original rule) stripped the volume off every tankobon that Kavita also listed in
 * `chapters[]`, so a sole-chapter volume labelled itself "Chapter 1" instead of "Volume N".
 * Preferring the volume copy keeps labelling working without changing a webtoon's order:
 * its chapters still sort by chapter number under volume 1.
 */
function orderedAll(detail: KavitaSeriesDetailDto | null): UnreadEntry[] {
  const loose: UnreadEntry[] = [
    ...(detail?.chapters || []),
    ...(detail?.specials || []),
  ].map((chapter) => ({ chapter, volume: null }));

  const fromVolumes: UnreadEntry[] = (detail?.volumes || []).flatMap((volume) => (
    (volume?.chapters || []).map((chapter) => ({ chapter, volume }))
  ));

  // Volume copy first so it wins the dedupe — see the header.
  const seen = new Set<number>();
  const merged: UnreadEntry[] = [];
  for (const entry of [...fromVolumes, ...loose]) {
    const ch = entry.chapter;
    if (!ch || ch.id == null) continue;
    if (seen.has(ch.id)) continue;
    seen.add(ch.id);
    merged.push(entry);
  }

  return merged.sort((a, b) => {
    const aHasVol = a.volume != null;
    const bHasVol = b.volume != null;
    // Volumes before loose chapters — the catch-up read leads; weekly releases trail.
    if (aHasVol !== bHasVol) return aHasVol ? -1 : 1;
    if (aHasVol && bHasVol) {
      return (a.volume!.minNumber ?? 0) - (b.volume!.minNumber ?? 0)
        || (a.chapter.minNumber ?? 0) - (b.chapter.minNumber ?? 0);
    }
    return (a.chapter.minNumber ?? 0) - (b.chapter.minNumber ?? 0);
  });
}

/**
 * Is this chapter unread?
 *
 * `pages: 0` means Kavita does not know the length — keep it rather than treat the gap as
 * "already read". The old continue-point path had the same rule; dropping unknowns here
 * would make a whole series vanish from the rotation for a metadata hole.
 */
function isChapterUnread(ch: KavitaChapterDto): boolean {
  if (ch.id == null) return false;
  const pages = ch.pages ?? 0;
  if (pages <= 0) return true;
  return (ch.pagesRead ?? 0) < pages;
}

function orderedUnread(detail: KavitaSeriesDetailDto | null): UnreadEntry[] {
  return orderedAll(detail).filter(({ chapter: ch }) => isChapterUnread(ch));
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

export const listTitleFor = (name: string): string => `${LIST_PREFIX} — ${name}`;

/**
 * The set's list, by title, tolerating the title it USED to have.
 *
 * Lists were named after the set's id (`QueuePilot — manga_webtoons`) until 2026-08-17 and are
 * named after its label now (`QueuePilot — Manga & Webtoons`). Both are candidates here, label
 * first, so a list built under the old name is FOUND — and then renamed in place by
 * `materialize()`, keeping the id that `/lists/153` and every link Kavita renders point at.
 *
 * Kept as one function because two callers need the same tolerance: `materialize()`, which
 * does the renaming, and `topupList()`, which would otherwise decide a renamed list "was
 * never launched for this set" and silently stop topping it up.
 */
export function findSetList<T extends { title?: string }>(
  lists: T[],
  { setName, setLabel }: { setName: string; setLabel?: string | null },
): T | undefined {
  const title = listTitleFor(setLabel || setName);
  const legacy = listTitleFor(setName);
  return lists.find((l) => l.title === title)
    ?? (legacy === title ? undefined : lists.find((l) => l.title === legacy));
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
     * The series page in Kavita's own UI — the same address `handoff()` builds its reader
     * link from, minus the chapter.
     *
     * Resolved here, on the click, rather than carried on every tile: this string contains
     * Kavita's base URL, which must not appear in a JSON body (see the provider interface's
     * note and `e2e/kavita-covers-test.ts`). One series read per click.
     */
    async webUrl(itemId: string): Promise<string | null> {
      const s = await c.series(itemId);
      if (!s || s.libraryId == null) return null;

      return `${c._base}/library/${s.libraryId}/series/${s.id ?? itemId}`;
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

      // One series-detail probe per series, bounded. A series with nothing unread yields no
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

        // Always walk series-detail. The old continue-point shortcut named the next
        // chapter WITHOUT its volume, so a whole-volume item lost its label (and a
        // mixed series could not apply the volumes-first order). series-detail is
        // the same call tiles/pool already pay for; the volume context is load-bearing.
        const detail = await c.seriesDetail(s.id as number | string);
        const unread = orderedUnread(detail).filter((e) => atOrAfterStart(e, start));
        if (!unread.length) return null;
        const head = chapterItem(unread[0] as UnreadEntry, s.id);
        // A volume-based manga must not inherit the chapter count — that is the live
        // "3 chapters" queue dumping 3 volumes.
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
     * THE WHOLE LINEUP IS WRITTEN, libraries and all. It did not use to be: between
     * 2026-08-16 and 2026-08-17 the list stopped at the first library change, to dodge a
     * Kavita reader-profile bug (Kareadita/Kavita#4859 — the manga reader does not remount on
     * auto-advance, so a manga after a webtoon keeps scroll + custom width). That cost far
     * more than it bought: the lineup INTERLEAVES series and a random-order queue alternates
     * libraries, so the cut landed after one or two series and the live Manga & Webtoons list
     * came back holding 4 chapters out of 12. The owner backs out of the reader and reopens
     * when the pagination is wrong, which is one tap against a list that is a third the size
     * it should be (decision `2026-08-17-the-reading-list-crosses-libraries-again`).
     *
     * A list that has no cover of ours gets one (see `putCover` below) — the artwork is the
     * one part of this artifact that is NOT rebuilt per launch.
     */
    async materialize(
      items: KavitaPlayItem[],
      // `setName` is `string | null` on the Provider interface (Plex defaults it to null), but
      // this side names a persistent Reading List with it, so it is narrowed to a string here
      // rather than being made null-safe — a null would title the list "QueuePilot — null",
      // which is what the JS did too. Declared, not fixed.
      //
      // `setLabel` is the set's HUMAN name, and it TITLES the list — "QueuePilot — Manga &
      // Webtoons", not "QueuePilot — manga_webtoons". A list built under the old id-title is
      // found by `findSetList` and RENAMED IN PLACE below, so the id survives the change.
      { setName = 'queue', setLabel = null }: { setName?: string; setLabel?: string | null } = {},
    ): Promise<KavitaArtifact> {
      const title = listTitleFor(setLabel || setName);
      const existing = findSetList(
        (await c.readingLists({ pageSize: 200 })) || [],
        { setName, setLabel },
      );

      // RENAME IN PLACE rather than create a new list under the new title: the id is
      // user-visible — it is the `/lists/153` the owner has open — and every link Kavita's own
      // UI renders points at it.
      //
      // ⚠️ `coverImageLocked` MUST be echoed back. `POST /api/ReadingList/update` takes the
      // whole DTO, and sending `false` for it does not merely leave the flag alone — it
      // UNLOCKS and CLEARS the cover (`coverImage: ''`, probed live 2026-08-17). A rename that
      // spelled that field `false` would silently delete the artwork the launch before it
      // uploaded. `summary` and `promoted` are echoed for the same reason.
      if (existing?.id != null && existing.title !== title) {
        try {
          await c.updateList(existing.id, {
            title,
            summary: existing.summary ?? '',
            promoted: existing.promoted ?? false,
            coverImageLocked: existing.coverImageLocked ?? false,
          });
        } catch (e) {
          console.log(`[kavita] could not rename list ${existing.id}: ${errMessage(e)}`);
        }
      }

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
      // ARTWORK. Everything else in this method is rebuilt per launch; the cover is the one
      // thing that must NOT be, so it is written only when the list has no cover of ours:
      // a brand-new list, or one Kavita is still auto-generating art for
      // (`coverImageLocked: false` — an uploaded cover sets that flag and Kavita stops
      // regenerating). Without it the cover is whatever page opened this launch's first
      // chapter, and it changes every time the lineup does.
      //
      // BEFORE the items go on, deliberately: an upload while the list is empty is the same
      // request either way, and doing it first means a failure here cannot leave the reader
      // waiting on a render for a lineup that was otherwise ready.
      if (listId != null && !existing?.coverImageLocked) {
        // Best-effort, like the clear above: a cover is decoration and a launch that dies for
        // want of one is a dead card. The render is pure CPU (Satori, no network) and the
        // upload is one call, so the cost of trying is bounded.
        try {
          await c.uploadListCover(listId, await readingListCoverBase64(setLabel || setName));
        } catch (e) {
          console.log(`[kavita] could not set cover on list ${listId}: ${errMessage(e)}`);
        }
      }
      // Every item, in lineup order — the list the reader walks is the rotation the tiles
      // show. A library change mid-list can leave Kavita on the previous library's reading
      // profile (see this method's header); backing out and reopening applies the right one.
      for (const it of items) {
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
        count: items.length,
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
      { setName, setLabel = null, window, at, build }: {
        setName: string;
        // The list is titled with the LABEL since 2026-08-17, so a top-up that looked only for
        // the id-title would report "nothing was ever launched for this set" about a list it
        // is looking straight at, and quietly stop refilling it.
        setLabel?: string | null;
        window: number;
        at: number;
        build: () => Promise<KavitaPlayItem[]>;
      },
    ): Promise<{ ok: boolean; reason?: string; added?: number; trimmed?: number; unread?: number }> {
      const list = findSetList(
        (await c.readingLists({ pageSize: 200 })) || [],
        { setName, setLabel },
      );
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
