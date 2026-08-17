// Steam as a QueuePilot provider.
//
// The fourth backend, and the first whose backend reports a game ENDING rather than
// starting. The mapping:
//
//   Board Game Picker      Steam
//   -----------------      -----
//   game                   game (an appid in the owned library)
//   PLAY                   PLAY (one session)
//   the play log           `rtime_last_played` — when the last session ENDED
//
// WHY THIS PROVIDER NEEDS NO WATCHER. Steam writes `playtime_forever` and
// `rtime_last_played` when a game EXITS, not when it launches. That is exactly the owner's
// rule — "per session; when the game is closed, it's done" — reported by the backend itself,
// so this reads like Plex or Kavita (ask what has been played) rather than needing something
// to observe the close. MiSTer has no such record and does need a watcher; that is the
// difference between the two game providers, and the reason they are separate kinds.
//
// PROGRESS IS COUNTED FROM `queued_at`, NEVER FROM `playtime_forever`. A 508-hour game with
// a lifetime total would be finished the instant it was queued — the same trap the picker's
// play log sets, and the reason `Provider.stampsQueuedAt` exists.
//
// ONE PLAY PER ENTRY, deliberately — see PLAYS_PER_GAME below.
import type {
  BucketsContext,
  BucketsResult,
  CuratedEntryRef,
  PlayItem,
  Provider,
  ProviderCover,
  ProviderDefinition,
  ProviderSearchHit,
  ProviderTileRow,
  SteamArtifact,
  SteamPlayItem,
} from '../types.js';

import { errMessage } from '../errors.js';
import { steamClient, type SteamHttpClient } from './steam-client.js';

/**
 * The implicit "everything you own" library.
 *
 * Steam has no categories to expose — the account's own shelves live client-side in the
 * Steam app and are not in the Web API at all — so `libraries()` is deliberately absent and
 * every queue draws from the whole library (decision
 * `2026-08-17-no-libraries-checked-means-every-library`). This id exists only to label a
 * search hit, which the editor requires.
 */
export const LIBRARY_ID = 'library';

/**
 * How many plays one Steam entry owes: ALWAYS one.
 *
 * Not a default — a clamp, and the honest limit of what this backend can answer. Steam
 * reports a CUMULATIVE playtime and the moment of the LAST session; it publishes no session
 * log. So "has this been played since I queued it" is answerable and "has this been played
 * three times since I queued it" is not, without this app polling and recording every
 * increment itself.
 *
 * Rather than honour a `plays` knob that could never reach 2, an entry is done after one
 * session. If per-session counting is wanted later, it needs a persisted per-entry playtime
 * baseline — a real feature, not a tweak here.
 */
const PLAYS_PER_GAME = 1;

/** How many entries are resolved at once. Every one is a lookup in the SAME memoized
 *  library response, so this is a loop bound rather than a politeness limit. */
const PROBE_CONCURRENCY = 16;

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

/** One entry, resolved against the library: what it owes and whether it has been played. */
export interface SteamEntryState {
  appid: string;
  title: string;
  owed: number;
  played: number;
  remaining: number;
  /** Epoch seconds of the last session's end, or null for a game never played. */
  lastPlayed: number | null;
}

export interface SteamProviderOptions {
  def: ProviderDefinition;
  apiKey: string;
  steamId: string;
  client?: SteamHttpClient | null;
}

export function steamProvider({ def, apiKey, steamId, client = null }: SteamProviderOptions): Provider {
  const c = client || steamClient({ apiKey, steamId });

  const playItem = (state: SteamEntryState, slot: number): SteamPlayItem => ({
    appid: state.appid,
    bucket: state.appid,
    number: slot,
    of: state.owed,
    slot,
    title: state.title,
    unit: 'play',
  });

  /**
   * Resolve one curated entry: the game, and whether it has been played SINCE IT WAS QUEUED.
   *
   * A game no longer in the library (refunded, or a family-shared title that went away)
   * resolves to null rather than throwing — one missing game must not make a whole queue
   * un-launchable.
   *
   * An entry with NO `queued_at` counts as unplayed regardless of its lifetime playtime.
   * That is the conservative direction on purpose: the launcher stamps the entry on first
   * launch, and until it does, reading a lifetime total as "played" would retire a game the
   * owner has never played *from this queue*.
   */
  async function entryState(
    entry: { id: string; queuedAt?: number | null },
  ): Promise<SteamEntryState | null> {
    const game = await c.game(entry.id);
    if (!game) return null;

    const appid = String(game.appid ?? entry.id);
    const rtime = Number(game.rtime_last_played ?? 0);
    const lastPlayed = Number.isFinite(rtime) && rtime > 0 ? rtime : null;
    const queuedAt = Number(entry.queuedAt ?? 0);

    const played = (
      Number.isFinite(queuedAt) && queuedAt > 0
      && lastPlayed != null && lastPlayed > queuedAt
    ) ? 1 : 0;

    return {
      appid,
      lastPlayed,
      owed: PLAYS_PER_GAME,
      played,
      remaining: Math.max(0, PLAYS_PER_GAME - played),
      title: String(game.name ?? entry.id),
    };
  }

  return {
    id: def.id,
    kind: def.kind,
    label: def.label,
    // A launch is a `steam://` URL, which is a thing to OPEN rather than a lineup to push at
    // a device. That URL is also the integration point for launching from Home Assistant:
    // it is handed to the PC as a command argument rather than being followed by a browser.
    delivery: 'pull',
    unit: 'play',
    // Steam's playtime is lifetime; a queue entry's progress is not. See the header.
    stampsQueuedAt: true,

    /**
     * Search the owned library.
     *
     * `libraries` is accepted and ignored: Steam exposes no categories through the Web API,
     * so there is no scope to honour. Declaring the parameter keeps the signature the seam
     * expects rather than making the caller special-case this provider.
     */
    async search(q: string): Promise<ProviderSearchHit[]> {
      const games = await c.search(q);
      return games.map((g) => ({
        id: String(g.appid),
        title: String(g.name ?? ''),
        libraryId: LIBRARY_ID,
        libraryTitle: 'Library',
        type: 'game',
      }));
    },

    /** Library art, re-served from this origin like every other provider's. */
    cover(appid: string): Promise<ProviderCover> {
      return c.cover(appid);
    },

    /**
     * Poster tiles. `unreadCount` is plays LEFT — a game already played since it was queued
     * reads "All played" rather than showing a next-up it does not have.
     *
     * Index-aligned with `ids`, `null` for a game no longer owned.
     */
    async tiles(ids: Iterable<string>, entries: CuratedEntryRef[] = []): Promise<(ProviderTileRow | null)[]> {
      const wanted = [...ids].map(String);
      const byId = new Map(entries.map((e) => [String(e.id), e]));
      return mapLimit(wanted, PROBE_CONCURRENCY, async (id): Promise<ProviderTileRow | null> => {
        try {
          // The ENTRY's own context, not just the game's: when it was queued is a property
          // of the queue entry, and without it every tile reads as never-played.
          const state = await entryState(byId.get(id) ?? { id });
          if (!state) return null;
          return {
            id: state.appid,
            title: state.title,
            libraryId: LIBRARY_ID,
            unreadCount: state.remaining,
            next: state.remaining > 0 ? playItem(state, state.played + 1) : null,
          };
        } catch (e) {
          console.log(`[steam] tile ${id}: ${errMessage(e)}`);
          return null;
        }
      });
    },

    /**
     * The lineup.
     *
     * ENTRIES BEAT LIBRARIES, the rule Kavita and the picker both had to learn: a curated
     * queue's entries ARE the lineup. This provider has no rule-based mode — "some game out
     * of the 963 you own" is not a thing anyone wants pushed at them — so no entries means
     * an empty lineup rather than a slice of the library.
     *
     * The head is the first game not yet played since it was queued. Exactly one item is
     * ever returned: a session is a whole evening, so there is no batch to spill into.
     */
    async buckets(ctx: BucketsContext): Promise<BucketsResult> {
      const entries = (ctx.entries || []).filter((e) => e && e.id);
      if (!entries.length) return { play: [], buckets: [] };

      const states = (await mapLimit(
        entries,
        PROBE_CONCURRENCY,
        (e) => entryState(e).catch((err: unknown) => {
          console.log(`[steam] entry ${e.id}: ${errMessage(err)}`);
          return null;
        }),
      )).filter((s): s is SteamEntryState => s != null);

      const head = states.find((s) => s.remaining > 0);
      if (!head) {
        return {
          play: [],
          buckets: states,
          // Everything queued has been played. Reported as done ids so the caller's own
          // bookkeeping (TTL sweep, "remove all completed") still works — this provider
          // never writes queues.yaml itself.
          newlyDone: states.map((s) => s.appid),
        };
      }

      return {
        play: [playItem(head, head.played + 1)] as PlayItem[],
        buckets: states,
        newlyDone: states.filter((s) => s.remaining === 0).map((s) => s.appid),
      };
    },

    /**
     * Which queued games are finished — the set of appids played since they were queued.
     *
     * Same shape Plex answers with (a Set of ids), because progress on this provider IS the
     * last-played timestamp, exactly as Kavita's progress is pages read.
     */
    async progressState(ctx: BucketsContext): Promise<Set<string>> {
      const entries = (ctx.entries || []).filter((e) => e && e.id);
      if (!entries.length) return new Set();

      const states = await mapLimit(
        entries,
        PROBE_CONCURRENCY,
        (e) => entryState(e).catch(() => null),
      );

      return new Set(
        states.filter((s): s is SteamEntryState => s != null && s.remaining === 0).map((s) => s.appid),
      );
    },

    /**
     * A DESCRIPTOR, and nothing more.
     *
     * Plex builds a playQueue and Kavita rebuilds a Reading List because both own a lineup
     * object on their side. Steam does not — there is no such thing as a Steam queue — so
     * this describes the one game that is next and lets `handoff()` turn it into a URL.
     */
    materialize(items: PlayItem[], opts: { setName?: string | null } = {}): SteamArtifact {
      const head = (items[0] as SteamPlayItem | undefined) || null;
      const appid = head ? String(head.appid) : '';

      return {
        provider: def.id,
        kind: 'steam',
        appid,
        count: items.length,
        head,
        setName: String(opts.setName ?? ''),
        // The launch primitive. `rungameid` takes NO arguments — everything about how a game
        // starts is configured on the PC — which is why this is the whole payload.
        url: appid ? `steam://rungameid/${encodeURIComponent(appid)}` : '',
      };
    },

    /** Start tonight's game. The queue already chose; this is the URL that opens it. */
    handoff(artifact: SteamArtifact) {
      if (!artifact?.appid || !artifact.url) {
        return { mode: 'pull' as const, url: null, error: 'nothing left to play in this queue' };
      }
      return { mode: 'pull' as const, url: artifact.url, awaiting: null };
    },
  };
}
