// MiSTer FPGA as a QueuePilot provider.
//
// The fifth backend, and the one with NO progress of its own. The mapping:
//
//   Steam                        MiSTer
//   -----                        ------
//   game (an owned appid)        game (an indexed ROM path)
//   play (one session)           play (one session)
//   `rtime_last_played`          — NOTHING. mrext keeps no history at all.
//
// WHY THIS ONE IS WATCHED RATHER THAN POLLED. Steam writes a timestamp when a game exits, so
// "has this been played since I queued it" is a question its API can answer. mrext cannot:
// it indexes the ROM share and reports what is running RIGHT NOW (`/games/playing`), and
// remembers nothing once the core returns to the menu. So progress here is not read off the
// backend — it is the app's own `done` flag, written when Home Assistant observes the close
// and says so over MQTT. That is the whole architectural difference between the two game
// providers, and the reason they are separate kinds.
//
// Consequences worth stating rather than discovering:
//
//   * `progressState()` is EMPTY, always. Not a stub — an accurate answer. Nothing about
//     what has been played is knowable from this backend, and inventing a guess (say, "the
//     head is done once something else is running") would retire entries on a stray launch.
//   * A queue advances because an entry got marked done, exactly as a hand-marked queue
//     does. `launcher.ts` already drops done entries before `buckets()` is called, so the
//     head is simply the first entry still waiting.
//   * `stampsQueuedAt` is FALSE. The stamp exists to separate lifetime progress from
//     since-queued progress; with no lifetime record to confuse it with, a stamp would be a
//     key nothing ever reads.
//
// A GAME IS ITS PATH. See mister-client.ts's header — there is no id to store.
import type {
  BucketsContext,
  BucketsResult,
  CuratedEntryRef,
  MisterArtifact,
  MisterPlayItem,
  PlayItem,
  Provider,
  ProviderDefinition,
  ProviderCover,
  ProviderLibrary,
  ProviderSearchHit,
  ProviderTileRow,
} from '../types.js';

import { errMessage } from '../errors.js';
import { misterClient, toSearchHit, type MisterHttpClient } from './mister-client.js';

/** mrext's own "every system" sentinel for a scoped search. */
const ALL_SYSTEMS = 'all';

/** How many scoped searches run at once when a queue names several systems. */
const SEARCH_CONCURRENCY = 4;

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * The display name for a ROM path, for when an entry carries no stored title.
 *
 * `/media/fat/games/SNES/Games/Super Mario World (USA).zip/Super Mario World (USA).sfc`
 * becomes `Super Mario World (USA)`. Derived rather than looked up because mrext has no
 * get-one-game endpoint — searching for a title to recover the title it came from would be
 * circular, and would put a network call behind every tile.
 */
export function titleFromPath(path: string): string {
  const leaf = String(path || '').split('/').filter(Boolean).pop() || '';
  return leaf.replace(/\.[a-z0-9]{1,5}$/i, '') || String(path || '');
}

/** The system id a ROM path sits under, or '' — `/media/fat/games/<SYSTEM>/…`. */
export function systemFromPath(path: string): string {
  const parts = String(path || '').split('/').filter(Boolean);
  const at = parts.indexOf('games');
  return at >= 0 && parts[at + 1] ? String(parts[at + 1]) : '';
}

export interface MisterProviderOptions {
  def: ProviderDefinition;
  client?: MisterHttpClient | null;
}

export function misterProvider({ def, client = null }: MisterProviderOptions): Provider {
  const c = client || misterClient({ baseUrl: def.base_url });

  const playItem = (path: string, title: string): MisterPlayItem => ({
    bucket: path,
    number: 1,
    of: 1,
    path,
    slot: 1,
    title,
    unit: 'play',
  });

  const entryTitle = (entry: { id: string; title?: string | null }) => (
    String(entry.title || '').trim() || titleFromPath(entry.id)
  );

  return {
    id: def.id,
    kind: def.kind,
    label: def.label,
    delivery: 'pull',
    unit: 'play',
    // Nothing to count from. See this file's header.
    stampsQueuedAt: false,

    /** The installed systems — SNES, NES, Arcade. A queue scopes its searches to these. */
    async libraries(): Promise<ProviderLibrary[]> {
      const systems = await c.systems();
      return systems
        .filter((s) => s.id)
        .map((s) => ({ id: String(s.id), title: String(s.name || s.id) }));
    },

    /**
     * Search the index, scoped to the systems the queue's block named.
     *
     * mrext takes ONE system per request, so several named systems fan out and merge rather
     * than being passed through. No systems named searches everything, which is what an
     * unscoped block already means
     * (decision `2026-08-17-no-libraries-checked-means-every-library`).
     */
    async search(q: string, { libraries = [] }: { libraries?: string[] } = {}): Promise<ProviderSearchHit[]> {
      const query = String(q || '').trim();
      if (!query) return [];

      const named = libraries.map(String).filter(Boolean);
      if (!named.length) return (await c.search(query, ALL_SYSTEMS)).map(toSearchHit);

      const perSystem = await mapLimit(named, SEARCH_CONCURRENCY, (system) => (
        c.search(query, system).catch((e: unknown) => {
          // One dead system must not empty the whole result. A core can be installed with
          // no index yet, which answers 404 and reads as "nothing here" rather than an error.
          console.log(`[mister] search ${system}: ${errMessage(e)}`);
          return [];
        })
      ));

      // Merge, keeping the first hit per path: a game reachable from two named systems is
      // still one game.
      const seen = new Set<string>();
      const out: ProviderSearchHit[] = [];
      for (const hit of perSystem.flat().map(toSearchHit)) {
        if (!hit.id || seen.has(hit.id)) continue;
        seen.add(hit.id);
        out.push(hit);
      }
      return out;
    },

    /**
     * Box art, from the libretro thumbnail archive rather than from the MiSTer.
     *
     * mrext serves no artwork at all, so a MiSTer queue drew as a grid of grey rectangles
     * beside Plex posters and Steam library art. The archive is keyed on No-Intro names,
     * which is exactly what this ROM share is named in — see mister-boxart.ts, which also
     * records the measured hit rate and why an unmapped system returns nothing rather than
     * guessing at a neighbouring console's art.
     *
     * Both arguments come out of the stored PATH, so this needs no index lookup and works
     * while the MiSTer is powered down.
     */
    cover(path: string): Promise<ProviderCover> {
      return c.cover(systemFromPath(path), titleFromPath(path));
    },

    /**
     * Poster tiles.
     *
     * Everything here is derived from the stored path, so a tile costs no network call to
     * the MiSTer and a powered-down MiSTer still renders its queue. The art is fetched
     * separately, by the cover route, from a host that is not the MiSTer.
     */
    async tiles(ids: Iterable<string>, entries: CuratedEntryRef[] = []): Promise<(ProviderTileRow | null)[]> {
      const byId = new Map(entries.map((e) => [String(e.id), e]));
      return [...ids].map(String).map((id): ProviderTileRow => {
        const entry = byId.get(id);
        const title = entryTitle({ id, title: (entry as { title?: string } | undefined)?.title ?? null });
        return {
          id,
          title,
          libraryId: systemFromPath(id),
          // One play, always waiting: nothing here can tell us it has been played, so a
          // tile shows what it owes and the `done` flag is what removes it.
          unreadCount: 1,
          next: playItem(id, title),
        };
      });
    },

    /**
     * The lineup: the first entry still waiting.
     *
     * `launcher.ts` has already dropped entries marked done, so the head is simply the
     * first one left. ENTRIES BEAT LIBRARIES — a curated queue's entries ARE the lineup, and
     * this provider has no rule-based mode: "a random ROM off the share" is not something
     * anyone asked to be handed.
     */
    async buckets(ctx: BucketsContext): Promise<BucketsResult> {
      const entries = (ctx.entries || []).filter((e) => e && e.id);
      if (!entries.length) return { play: [], buckets: [] };

      const head = entries[0] as { id: string; title?: string | null };
      const title = entryTitle(head);

      return {
        play: [playItem(String(head.id), title)] as PlayItem[],
        buckets: entries.map((e) => ({
          path: String(e.id),
          title: entryTitle(e as { id: string; title?: string | null }),
          owed: 1,
          played: 0,
          remaining: 1,
        })),
        // Never inferred. Only Home Assistant knows a game closed, and it says so by marking
        // the entry — see this file's header.
        newlyDone: [],
      };
    },

    /**
     * Nothing is knowable. See this file's header.
     *
     * An empty Set is the same shape Plex and Steam answer with, and it is the honest one:
     * this backend has no record of anything having been played.
     */
    async progressState(): Promise<Set<string>> {
      return new Set();
    },

    /** A DESCRIPTOR — there is no lineup object on the MiSTer's side to build. */
    materialize(items: PlayItem[], opts: { setName?: string | null } = {}): MisterArtifact {
      const head = (items[0] as MisterPlayItem | undefined) || null;
      const path = head ? String(head.path) : '';

      return {
        provider: def.id,
        kind: 'mister',
        count: items.length,
        head,
        path,
        setName: String(opts.setName ?? ''),
        system: systemFromPath(path),
      };
    },

    /**
     * What to launch — NOT the launch itself.
     *
     * This provider deliberately does not start anything. A MiSTer launch has to go through
     * Home Assistant's `script.control_games`, which saves via the OSD, enables the Xbox
     * Wireless Adapter, waits for that script to clear tty1, and switches the remote to
     * Retro Games. Calling mrext's `/games/launch` from here would skip all four and would
     * add a service-to-service REST bridge the house rules forbid.
     *
     * So the artifact carries the path, and HA reads it (over the existing MQTT preview
     * topic) and launches. `url` is null because there is no URL a browser could usefully
     * follow — a `steam://`-style handoff has no MiSTer equivalent.
     */
    handoff(artifact: MisterArtifact) {
      if (!artifact?.path) {
        return { mode: 'pull' as const, url: null, error: 'nothing left to play in this queue' };
      }
      return {
        mode: 'pull' as const,
        url: null,
        error:
          `“${artifact.head?.title || titleFromPath(artifact.path)}” is next. A MiSTer game is `
          + 'started by its card or the remote, which is what enables the controller adapter '
          + 'and switches the activity — this queue chooses what plays, not when.',
      };
    },
  };
}
