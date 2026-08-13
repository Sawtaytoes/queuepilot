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
import { kavitaClient, readerSegment } from './kavita-client.js';
import { KAVITA_BATCH_DEFAULT, ROTATION_LENGTH } from '../env.js';

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
function isUnread(ch) {
  if (!ch || ch.id == null) return false;
  const pages = ch.pages ?? 0;
  if (pages <= 0) return true; // unknown length — do not silently drop it
  return (ch.pagesRead ?? 0) < pages;
}

/** One lineup item from a Kavita ChapterDto. `seriesId` is threaded in — Kavita leaves it null. */
function chapterItem(ch, seriesId) {
  return {
    chapterId: ch.id,
    seriesId,
    title: ch.titleName || ch.title || ch.range || String(ch.number),
    number: ch.number,
    pages: ch.pages,
    pagesRead: ch.pagesRead,
  };
}

/**
 * A series' unread chapters, in reading order.
 *
 * `series-detail` returns every chapter with its own `pagesRead`/`pages`, so the unread run
 * is just a filter — and filtering rather than slicing from the continue point is what makes
 * a gap (an unread chapter behind a read one) lead, exactly as `continue-point` would.
 *
 * Sorted by `minNumber` rather than trusted as-returned: the array happened to be ordered on
 * the instance this was verified against, but nothing documents that guarantee.
 */
function orderedUnread(detail) {
  const all = [
    ...(detail?.chapters || []),
    ...(detail?.specials || []),
  ];
  return all
    .filter((ch) => ch && (ch.pages ?? 0) > 0 && (ch.pagesRead ?? 0) < ch.pages)
    .sort((a, b) => (a.minNumber ?? 0) - (b.minNumber ?? 0));
}

/** Map with bounded concurrency, preserving input order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
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

export const listTitleFor = (setName) => `${LIST_PREFIX} — ${setName}`;

/**
 * @param {{def: object, apiKey: string, client?: object}} opts
 * `client` is injectable so the offline tests can stub HTTP entirely — they run with no
 * token and no network, in the house style.
 */
export function kavitaProvider({ def, apiKey, client = null } = {}) {
  if (!def?.base_url && !client) throw new Error(`provider '${def?.id}' has no base_url`);
  const c = client || kavitaClient({ baseUrl: def.base_url, apiKey });

  return {
    id: def?.id || 'kavita',
    kind: 'kavita',
    label: def?.label || 'Kavita',

    /** Pull, not push. The UI must not offer this one a "Play on <device>" target. */
    delivery: 'pull',

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
    async search(q, { libraries = [] } = {}) {
      const query = String(q || '').trim();
      if (!query) return [];
      const scope = new Set(libraries.map(String));
      const res = await c.search(query);
      return (res?.series || [])
        .filter((s) => !scope.size || scope.has(String(s.libraryId)))
        .map((s) => ({
          id: String(s.seriesId),
          title: s.name,
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
    async resolveMembers(ids) {
      const rows = await mapLimit([...ids], PROBE_CONCURRENCY, async (id) => {
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
      return rows.filter(Boolean);
    },

    /**
     * The channel's eligible POOL — every series with something unread, whether or not it is
     * an explicit member. This is what the Channels view renders, and it is the reading
     * analogue of the Plex rule pool.
     */
    async pool({ libraries = [], members = [] } = {}) {
      const explicit = members.map(String);
      const libIds = (libraries.length ? libraries : []).map(String);
      if (!libIds.length) return [];

      const seriesLists = await Promise.all(libIds.map((id) => c.seriesForLibrary(id)));
      const allSeries = seriesLists.flat().filter(Boolean);

      // The pool pays for `series-detail` per series where a launch pays only for
      // `continue-point`, because the grid shows a COUNT and the series list has no chapter
      // count at all — only pages (verified against the live instance: `all-v2` returns
      // pages/pagesRead and nothing chapter-shaped). Pages remaining would read as a wildly
      // larger number than "chapters left" and mean something else. This is a deliberate
      // "show me everything" view, so one extra bounded pass is the right trade; the launch
      // path is untouched and stays cheap.
      const probed = await mapLimit(allSeries, POOL_CONCURRENCY, async (s) => {
        try {
          const detail = await c.seriesDetail(s.id);
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
            items: unread.length ? [chapterItem(unread[0], s.id)] : [],
          };
        } catch {
          // One unreadable series must not blank the whole grid.
          return null;
        }
      });
      const buckets = probed.filter(Boolean);
      // Deliberately the PLEX PREVIEW BUCKET SHAPE — `ratingKey` / `show` / `unwatched` /
      // `next` — rather than a reading-flavoured one. The Channels grid already renders
      // this, so a reading channel needs no second render path, and `ratingKey` is here an
      // OPAQUE provider item id (a Kavita seriesId) rather than a Plex ratingKey. That
      // reading is safe because a queue draws from exactly one provider, so the id is never
      // ambiguous (decision 2026-08-13-a-queue-draws-from-exactly-one-provider).
      return buckets.map((b) => ({
        ratingKey: String(b.seriesId),
        show: b.title,
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
    cover: (seriesId) => c.cover(seriesId),

    /** Libraries, for the queue editor's provider block. */
    async libraries() {
      const libs = await c.libraries();
      return (libs || []).map((l) => ({ id: String(l.id), title: l.name, type: l.type }));
    },

    /**
     * The whole queue's completion state in ONE call — strictly better than the Plex side,
     * which needs a history sweep per profile.
     */
    async progressState({ artifactId = null } = {}) {
      if (!artifactId) return { items: [] };
      const items = (await c.readingListItems(artifactId)) || [];
      return {
        items: items.map((it) => ({
          chapterId: it.chapterId,
          seriesId: it.seriesId,
          order: it.order,
          pagesRead: it.pagesRead,
          pagesTotal: it.pagesTotal,
          done: it.pagesTotal > 0 && it.pagesRead >= it.pagesTotal,
          lastReadAt: it.lastReadingProgressUtc || null,
        })),
      };
    },

    /**
     * The ordered lineup: the next unread chapter(s) of each series in the block's libraries,
     * interleaved. `buildRotation` is backend-neutral (it round-robins over bucket objects
     * and never touches Plex), so the shape returned here is deliberately the same bucket
     * shape it already consumes — give it chapter buckets and it interleaves series exactly
     * as it interleaves shows.
     */
    async buckets({ cfg = {}, libraries = [], batch = null, limit = null } = {}) {
      const libIds = (libraries.length ? libraries : (cfg.libraries || [])).map(String);
      if (!libIds.length) return { play: [], buckets: [] };
      // "Read at least X chapters before switching series" — the opening ask in the
      // feasibility record. Per-set override, else the env default.
      const perSeries = Math.max(1, Number(batch ?? cfg.batch ?? KAVITA_BATCH_DEFAULT) || 1);
      // The SAME cap the Plex rotation runs under. Without it a real library queues
      // everything: Webtoons alone measured 103 series with something unread, which would
      // mean 103 sequential update-by-chapter writes on every launch, for a reading list
      // nobody will reach the end of. A queue is the next while, not the whole backlog.
      const cap = Math.max(1, Number(limit ?? cfg.max_items ?? ROTATION_LENGTH) || ROTATION_LENGTH);

      const seriesLists = await Promise.all(libIds.map((id) => c.seriesForLibrary(id)));
      const allSeries = seriesLists.flat().filter(Boolean);

      // One continue-point probe per series, bounded. A series with nothing unread yields no
      // bucket at all, which is what keeps a finished series out of the rotation without a
      // separate "done" store — the read state in Kavita IS the done state.
      const probed = await mapLimit(allSeries, PROBE_CONCURRENCY, async (s) => {
        const bucket = {
          key: `series:${s.id}`,
          title: s.name,
          seriesId: s.id,
          libraryId: s.libraryId ?? null,
          format: s.format ?? null,
        };

        // ONE chapter wanted: continue-point answers it in a single call.
        if (perSeries <= 1) {
          const ch = await c.continuePoint(s.id);
          if (!isUnread(ch)) return null;
          return { ...bucket, items: [chapterItem(ch, s.id)] };
        }

        // MORE than one wanted — "read 3 chapters, then switch series", the opening ask in
        // the feasibility record. continue-point only ever returns the single next chapter,
        // so a batch needs the ordered run and its read state.
        const detail = await c.seriesDetail(s.id);
        const unread = orderedUnread(detail);
        if (!unread.length) return null;
        return { ...bucket, items: unread.slice(0, perSeries).map((ch) => chapterItem(ch, s.id)) };
      });
      const buckets = probed.filter(Boolean);

      // Round-robin `perSeries` at a time, so a queue reads three chapters of A, then three
      // of B, rather than one-and-switch. Interleaving across buckets (rather than draining
      // one) is what buildRotation does on the Plex side, and it is what makes the queue
      // roll into a different series instead of becoming a single-series binge.
      const play = [];
      for (let round = 0; play.length < cap; round += 1) {
        let placedThisRound = false;
        for (const b of buckets) {
          const slice = b.items.slice(round * perSeries, (round + 1) * perSeries);
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
     */
    async materialize(items, { setName = 'queue' } = {}) {
      const title = listTitleFor(setName);
      const existing = ((await c.readingLists({ pageSize: 200 })) || [])
        .find((l) => l.title === title);

      let listId = existing?.id ?? null;
      if (listId == null) {
        const created = await c.createList(title);
        listId = created?.id ?? created;
      }
      for (const it of items) {
        await c.addChapter(listId, it.seriesId, it.chapterId);
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
    handoff(artifact) {
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
