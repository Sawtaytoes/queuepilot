// Board Game Picker as a QueuePilot provider.
//
// The third backend, and the one that proves the seam: it is not a media server at all.
// There is no lineup object on the picker's side — no play queue, no reading list — so
// `materialize()` returns a DESCRIPTOR and `handoff()` returns a URL into the picker's
// `/play/:gameId`, which is the card someone actually reads standing at a shelf.
//
// The mapping that makes this work, and the one thing to understand before changing it:
//
//   Kavita          Board Game Picker
//   ------          -----------------
//   series          game
//   chapter         PLAY
//   pages read      the play log (already the household's book of record)
//
// "Plays before the next game" is therefore NOT a new knob. An entry's `episodes` is how
// many plays that game owes; the queue's own batch is how many of them one Open consumes
// (default 1 — one game night). When the entry's plays are spent it drops out of the
// lineup and the next game becomes the head.
//
// PROGRESS IS COUNTED FROM `queued_at`, NEVER FROM `playCount`. The picker's log goes back
// years: Wingspan at twenty lifetime plays with a batch of three would be finished the
// instant it was queued. See `EntryExtras.queued_at` and `Provider.stampsQueuedAt`.
import type {
  BoardGamesArtifact,
  BoardGamesPlayItem,
  BucketsContext,
  BucketsResult,
  CuratedEntryRef,
  PlayItem,
  Provider,
  ProviderCover,
  ProviderDefinition,
  ProviderLibrary,
  ProviderSearchHit,
  ProviderTileRow,
} from '../types.js';

import { errMessage } from '../errors.js';
import { boardGamesClient, type BoardGamesHttpClient } from './board-game-picker-client.js';

/** How many entries are probed at once. The picker is a LAN app; this is politeness. */
const PROBE_CONCURRENCY = 8;

/** The implicit "everything on the shelf" library, so a queue need not name a category. */
export const COLLECTION_LIBRARY = 'collection';

/** One play per Open. A game night is one game — see this file's header. */
const PLAYS_PER_OPEN_DEFAULT = 1;

/** How many plays one entry owes when neither it nor the queue says. */
const PLAYS_PER_GAME_DEFAULT = 1;

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

const toCount = (raw: unknown, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

/** One entry, resolved against the picker: how many plays it owes and how many are spent. */
export interface BoardGamesEntryState {
  gameId: string;
  title: string;
  owed: number;
  played: number;
  remaining: number;
}

export interface BoardGamesProviderOptions {
  def: ProviderDefinition;
  token?: string | null;
  client?: BoardGamesHttpClient | null;
}

export function boardGamesProvider({ def, token = null, client = null }: BoardGamesProviderOptions): Provider {
  const c = client || boardGamesClient({ baseUrl: def.base_url, token });

  const playItem = (state: BoardGamesEntryState, slot: number): BoardGamesPlayItem => ({
    bucket: state.gameId,
    gameId: state.gameId,
    // `number` is what the tile layer reads for its next-up line, so a game's next-up says
    // "Play 2 of 3" rather than borrowing a chapter number it does not have.
    number: slot,
    of: state.owed,
    slot,
    title: state.title,
    unit: 'play',
  });

  /**
   * Resolve one curated entry: the game, what it owes, and what it has already been played
   * SINCE IT WAS QUEUED.
   *
   * A game that has vanished from the picker (merged into another title, taken off the
   * shelf) resolves to null rather than throwing — one deleted game must not make a whole
   * queue un-launchable.
   */
  async function entryState(
    entry: { id: string; batch?: number | null; queuedAt?: number | null },
    owedDefault: number,
  ): Promise<BoardGamesEntryState | null> {
    const game = await c.game(entry.id);
    if (!game) return null;

    const owed = toCount(entry.batch, owedDefault);
    const plays = await c.plays(entry.id, entry.queuedAt ?? null);
    const played = plays.length;

    return {
      gameId: String(game.id ?? entry.id),
      owed,
      played,
      remaining: Math.max(0, owed - played),
      title: String(game.name ?? entry.id),
    };
  }

  return {
    id: def.id,
    kind: def.kind,
    label: def.label,
    delivery: 'pull',
    unit: 'play',
    // The picker's play log is lifetime; a queue entry's progress is not. See the header.
    stampsQueuedAt: true,

    /**
     * The owner's own categories, and ONLY those.
     *
     * The picker has no libraries — it is one shelf — so the whole shelf is what an
     * unscoped block already means (no boxes checked = every library, decision
     * `2026-08-17-no-libraries-checked-means-every-library`). A synthetic "Collection"
     * checkbox used to sit at the top of this list, and it was a trap: checking it
     * alongside "Roll 'n Write" LOOKED like "the shelf plus that category" and behaved
     * like the category alone, so `cubitos` — a game in no category — could not be found
     * from a queue whose boxes were all ticked.
     *
     * His categories (Roll 'n Write, …) are the real axis: the one he manages himself and
     * filters on.
     */
    async libraries(): Promise<ProviderLibrary[]> {
      const names = await c.categories();
      return names.map((name) => ({ id: name, title: name }));
    },

    /**
     * Search the shelf, scoped to the categories the queue's block named.
     *
     * No categories — the normal case now — searches everything. A stored `collection` id
     * is a queue written before the synthetic checkbox went away, and it MEANT the whole
     * shelf, so it widens the scope back to everything rather than narrowing to a category
     * the picker has never heard of.
     */
    async search(q: string, { libraries = [] }: { libraries?: string[] } = {}): Promise<ProviderSearchHit[]> {
      const query = String(q || '').trim();
      if (!query) return [];

      const named = libraries.map(String).filter(Boolean);
      const categories = named.includes(COLLECTION_LIBRARY)
        ? []
        : named;
      const games = await c.games(query, categories);

      return games.map((g) => ({
        id: String(g.id),
        title: String(g.name ?? ''),
        libraryId: COLLECTION_LIBRARY,
        libraryTitle: 'Collection',
        type: 'game',
      }));
    },

    /**
     * "We played this", from here.
     *
     * The picker's `/play/:gameId` card is the primary path — someone is standing at the
     * table with the box in front of them. This exists so a game everybody already knows
     * does not REQUIRE opening the picker to tick off a night.
     *
     * It posts to the same `POST /api/plays` the picker's own UI posts to, with no players
     * attached: whoever tapped this is not filling in a form, and attributing a play to
     * people is the picker's job, on its own screens.
     */
    async logProgress(gameId: string): Promise<{ ok: boolean; remaining?: number }> {
      const play = await c.logPlay(gameId);
      if (!play) return { ok: false };
      return { ok: true };
    },

    /** Box art, re-served from this origin — the picker is a LAN host. */
    cover(gameId: string): Promise<ProviderCover> {
      return c.cover(gameId);
    },

    /**
     * Poster tiles. `unreadCount` is plays LEFT, which is what a tile means by "how much is
     * waiting" — a game with no plays left reads "All played" rather than showing a next-up
     * it does not have.
     *
     * Index-aligned with `ids`, `null` for a game that has vanished.
     */
    async tiles(ids: Iterable<string>, entries: CuratedEntryRef[] = []): Promise<(ProviderTileRow | null)[]> {
      const wanted = [...ids].map(String);
      const byId = new Map(entries.map((e) => [String(e.id), e]));
      return mapLimit(wanted, PROBE_CONCURRENCY, async (id): Promise<ProviderTileRow | null> => {
        try {
          // The ENTRY's own context, not just the game's: how many plays it owes and when it
          // was queued are both properties of the queue entry. Without them a "3 plays" game
          // draws as "Play 1 of 1" and reads finished after one night.
          const state = await entryState(byId.get(id) ?? { id }, PLAYS_PER_GAME_DEFAULT);
          if (!state) return null;
          return {
            id: state.gameId,
            title: state.title,
            libraryId: COLLECTION_LIBRARY,
            unreadCount: state.remaining,
            next: state.remaining > 0 ? playItem(state, state.played + 1) : null,
          };
        } catch (e) {
          console.log(`[board-game-picker] tile ${id}: ${errMessage(e)}`);
          return null;
        }
      });
    },

    /**
     * The lineup.
     *
     * ENTRIES BEAT LIBRARIES — the same rule Kavita had to learn the hard way. A curated
     * queue's entries ARE the lineup; the category scope is only the pool a rule-based set
     * would draw from, and this provider has no rule-based mode at all. Without entries
     * there is nothing to play, and that is an empty lineup rather than "here is some of
     * the shelf".
     *
     * The head is played until its plays run out. It does NOT spill into the next game
     * mid-night: "three plays of this one" means three game nights, not a triple bill.
     */
    async buckets(ctx: BucketsContext): Promise<BucketsResult> {
      const entries = (ctx.entries || []).filter((e) => e && e.id);
      if (!entries.length) return { play: [], buckets: [] };

      const cfg = (ctx.cfg || {}) as { episodes?: unknown; max_items?: unknown };
      // The QUEUE's own count is plays-per-Open; an ENTRY's count is plays-per-game. Two
      // different questions that share one YAML key, which is exactly why this is spelled
      // out rather than passed through.
      const playsPerOpen = toCount(ctx.batch ?? cfg.episodes, PLAYS_PER_OPEN_DEFAULT);

      const states = (await mapLimit(
        entries,
        PROBE_CONCURRENCY,
        (e) => entryState(e, PLAYS_PER_GAME_DEFAULT).catch((err: unknown) => {
          console.log(`[board-game-picker] entry ${e.id}: ${errMessage(err)}`);
          return null;
        }),
      )).filter((s): s is BoardGamesEntryState => s != null);

      const playable = states.filter((s) => s.remaining > 0);
      const head = playable[0];
      if (!head) {
        return {
          play: [],
          buckets: states,
          // Everything queued has been played out. Reported as done entry keys so the
          // caller's own bookkeeping (TTL sweep, "remove all completed") still works — this
          // provider never writes queues.yaml itself.
          newlyDone: states.map((s) => s.gameId),
        };
      }

      const take = Math.min(head.remaining, playsPerOpen);
      const play: PlayItem[] = Array.from(
        { length: take },
        (_, i) => playItem(head, head.played + i + 1),
      );

      return {
        play,
        buckets: states,
        newlyDone: states.filter((s) => s.remaining === 0).map((s) => s.gameId),
      };
    },

    /**
     * Which queued games are finished.
     *
     * Plex answers a watched-ratingKey Set and this answers the same shape — the set of
     * game ids with no plays left. There is no artifact to poll: progress on this provider
     * IS the play log, exactly as Kavita's progress is pages read.
     */
    async progressState(ctx: BucketsContext): Promise<Set<string>> {
      const entries = (ctx.entries || []).filter((e) => e && e.id);
      if (!entries.length) return new Set();

      const states = await mapLimit(
        entries,
        PROBE_CONCURRENCY,
        (e) => entryState(e, PLAYS_PER_GAME_DEFAULT).catch(() => null),
      );

      return new Set(
        states.filter((s): s is BoardGamesEntryState => s != null && s.remaining === 0).map((s) => s.gameId),
      );
    },

    /**
     * A DESCRIPTOR, and nothing more.
     *
     * Plex builds a playQueue and Kavita rebuilds a Reading List because both own a lineup
     * object. The picker does not, and building a "tonight's list" inside it would grow a
     * second queue in the app whose entire job is to not be one.
     */
    materialize(items: PlayItem[], opts: { setName?: string | null } = {}): BoardGamesArtifact {
      const head = (items[0] as BoardGamesPlayItem | undefined) || null;
      const gameId = head ? String(head.gameId) : '';

      return {
        provider: def.id,
        kind: 'board-game-picker',
        count: items.length,
        gameId,
        head,
        remaining: head?.of != null && head.slot != null ? Math.max(0, head.of - head.slot + 1) : items.length,
        setName: String(opts.setName ?? ''),
        url: gameId ? `${c._base}/play/${encodeURIComponent(gameId)}` : '',
      };
    },

    /** Open tonight's game on the picker. The queue already chose; this is the card. */
    handoff(artifact: BoardGamesArtifact) {
      if (!artifact?.gameId || !artifact.url) {
        return { mode: 'pull' as const, url: null, error: 'nothing left to play in this queue' };
      }
      return { mode: 'pull' as const, url: artifact.url, awaiting: null };
    },
  };
}
