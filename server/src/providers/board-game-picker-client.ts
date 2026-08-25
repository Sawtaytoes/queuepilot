// Board Game Picker as a QueuePilot data source — IN PROCESS since WP-4e, over HTTP before it.
//
// ── What changed, and what deliberately did not ──────────────────────────────────────────
//
// WP-4b absorbed the collection into this app's book of record. This file used to reach the
// sibling app over HTTP for every read; it now answers the same four questions out of
// `store/db/boardgames.ts`, and `providers/board-game-picker.ts` IS UNCHANGED. That is the
// proof the seam was drawn in the right place: the provider was written against a client
// interface, not against a URL, so swapping the transport is this file and nothing else.
//
// The wire shape is kept byte-for-byte rather than improved. `game()` returns exactly what
// `GET /api/games/:id` returned — the sibling app's own `Game`, which is what our absorbed
// `Game` is a port of — and `plays()` returns the same THREE KEYS its integration endpoint
// wrote out by hand. So the two transports are comparable object-for-object, which is what
// `e2e/board-game-transport-parity-test.ts` compares.
//
// ── ⚠️ THE WRITE CAME HOME IN WP-4d — THERE IS NO HTTP LEFT IN REPOSITORY MODE ──────────
//
// `logPlay()` was the one call still on the wire, and the reason was never the seam. TWO BOOKS
// OF RECORD WERE OPEN: the absorb REPLACED all twelve `board_game_*` tables whenever the source
// file's fingerprint changed, so a play written here was erased by the next start, silently.
//
// WP-4d retires the source file in the same change as the first writers, which is the rule
// `AGENTS.md` states and the condition WP-4e was waiting on. So the write is local now, and
// `boardGamesRepositoryClient` builds no HTTP client at all.
//
// Two things to know before you trust it:
//
//   1. IT RECORDS NOBODY, on purpose. `personIds: []` is stated rather than defaulted. Whoever
//      pressed "we played this" on a tile is not filling in a form, and a play may RENEW a
//      known-how claim but must never INVENT one — so guessing the roster here would write a
//      claim against a name that appears on no screen. The screen that asks is the Collection
//      screen (WP-8), through `POST /api/board-games/plays`.
//   2. A play against a title this store does not hold answers `null` rather than throwing,
//      which is what the HTTP client did with the sibling app's 404. `board_game_plays.game_id`
//      carries a foreign key, so the insert would otherwise take down the request.
//
// `BOARD_GAME_TRANSPORT=http` still puts BOTH the reads and the write back on the wire — see
// the rollback note below. That is what keeps the parity gate able to compare them.
//
// ── The privacy rule survives the transport swap ─────────────────────────────────────────
//
// The old file's loudest line was THIS FILE MUST NEVER CALL `/api/collection`, because that
// payload carries people, groups and who was at the table, and this repo is public. Reading
// rows instead does not retire the rule, it relocates it: `plays()` maps to the same three
// keys the sibling app's integration endpoint hand-wrote, so `playerIds` and `notes` are
// dropped HERE rather than trusted not to arrive. `listBoardGamePlays()` returns both.
//
// ── The rollback ─────────────────────────────────────────────────────────────────────────
//
// `BOARD_GAME_TRANSPORT=http` puts every read back on the wire, the way `STORE_BACKEND=yaml`
// puts the store back on the files. It is one env var and one restart, it keeps the HTTP
// implementation honest by keeping it running, and it is what lets the parity gate compare
// the two forever rather than once.
import { readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

import { imagesDirectory } from '../boardgames/enrich/images.js';
import type { Game } from '../boardgames/types.js';
import {
  getBoardGame,
  listBoardGameCategories,
  listBoardGamePlays,
  listBoardGames,
  searchBoardGames,
} from '../store/db/boardgames.js';
import { logBoardGamePlay } from '../store/db/boardgamePlays.js';
import { bookOfRecord } from '../store/db/open.js';
import type { SqliteDatabase } from '../store/sqlite.js';
import type { ProviderCover } from '../types.js';

// --- the DTOs, as loosely as the wire actually carried them ------------------- //
//
// Not in types.ts, for the same reason the Kavita DTOs are not: these were a REMOTE API's
// response shapes, and every field is optional because a required one would have been a claim
// about someone else's server. They are kept optional now that the rows are local — the
// provider reads them defensively either way, and narrowing them would be a change to the
// contract `board-game-picker.ts` was written against.

/** One physical box of a game. The shelf location lives here. */
export interface BoardGamesBoxDto {
  id?: string;
  label?: string;
  kind?: string;
  locationText?: string | null;
  [field: string]: unknown;
}

/** A game. The same object `GET /api/games/:id` used to return. */
export interface BoardGamesGameDto {
  id?: string;
  name?: string;
  imagePath?: string | null;
  yearPublished?: number | null;
  publishers?: string[];
  ownerCategories?: string[];
  boxes?: BoardGamesBoxDto[];
  playCount?: number;
  [field: string]: unknown;
}

/** A play row. Three keys, and the two it does NOT carry are the point — see the header. */
export interface BoardGamesPlayDto {
  id?: string;
  gameId?: string;
  playedAt?: string;
  [field: string]: unknown;
}

/** The `fetch` seam. Still here: `logPlay` is still a POST, and so is a remote cover URL. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * What `board-game-picker.ts` is written against. Both transports satisfy it, and the offline
 * suites hand it a stub.
 */
export interface BoardGamesCollectionClient {
  _base: string;
  games(query: string, categories?: string[]): Promise<BoardGamesGameDto[]>;
  game(id: string): Promise<BoardGamesGameDto | null>;
  plays(gameId: string, since?: number | null): Promise<BoardGamesPlayDto[]>;
  categories(): Promise<string[]>;
  logPlay(gameId: string): Promise<BoardGamesPlayDto | null>;
  cover(gameId: string): Promise<ProviderCover>;
}

/**
 * The name the provider imports.
 *
 * Kept as an alias rather than renamed at the call site, because `board-game-picker.ts` not
 * changing IS this package's proof. It is no longer an accurate name — most of this client
 * speaks to a table.
 */
export type BoardGamesHttpClient = BoardGamesCollectionClient;

export interface BoardGamesClientOptions {
  baseUrl?: string;
  /**
   * Optional. The sibling app only demands one when its own `BOARD_GAME_PICKER_API_TOKEN` is
   * set, so an unset token is the normal deployment and not the "unconfigured" failure Plex
   * and Kavita treat it as. Still sent on `logPlay`.
   */
  token?: string | null;
  fetchImpl?: FetchLike | null;
  /** The book of record. Defaults to the process-wide handle, opened on FIRST READ. */
  db?: SqliteDatabase | null;
}

/**
 * `http` puts every read back on the wire. See the header — this is the rollback, and it is
 * also what keeps the parity gate able to compare the two.
 */
export const BOARD_GAME_TRANSPORT: 'repository' | 'http' =
  process.env.BOARD_GAME_TRANSPORT === 'http' ? 'http' : 'repository';

/**
 * Where the artwork lives, beside the book of record.
 *
 * ⚠️ RE-EXPORTED FROM THE MODULE THAT WRITES IT, not computed again here. WP-4d landed the
 * enrichment, so this directory now has a WRITER as well as three readers, and three separate
 * copies of one `||` expression is how a reader ends up 404ing every cover the writer just
 * made. One definition, in `boardgames/enrich/images.ts`; the name stays for its callers.
 */
export const imagesPath = imagesDirectory;

/** Content type off the file name. The staged art is `.webp`; the other two are what the
 * enrichment wrote before it was. */
const CONTENT_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/**
 * The play bound, as the sibling app's `parseSince()` computed it.
 *
 * Epoch SECONDS in, milliseconds out. A value that is not a finite number is NO BOUND rather
 * than a bound of zero plays — the old endpoint says why, and it is worth repeating: silently
 * returning nothing would read as "already played" and skip a game the owner queued.
 */
const playBound = (since: number | null | undefined): number | null =>
  since == null || !Number.isFinite(since) ? null : since * 1000;

/** The three keys, written out. Spreading the row would ship `playerIds` and `notes`. */
const toPlayDto = (play: { gameId: string; id: string; playedAt: string }): BoardGamesPlayDto => ({
  gameId: play.gameId,
  id: play.id,
  playedAt: play.playedAt,
});

// --- the HTTP transport ------------------------------------------------------- //

/**
 * The pre-WP-4e client, unchanged in behaviour and now reachable only through
 * `BOARD_GAME_TRANSPORT=http`.
 *
 * It is not dead code. It is the rollback, it is the other half of the parity gate, and it is
 * still the transport `logPlay` uses in BOTH modes.
 *
 *   THIS FILE MUST NEVER CALL `/api/collection`.
 *
 * That payload carries players, groups and who was at the table, and this repo is public.
 */
export function boardGamesHttpClient({
  baseUrl, token = null, fetchImpl = null,
}: BoardGamesClientOptions = {}): BoardGamesCollectionClient {
  if (!baseUrl) throw new Error('boardGamesClient needs a baseUrl');
  const base = String(baseUrl).replace(/\/+$/, '');
  const doFetch: FetchLike = fetchImpl || globalThis.fetch;
  const auth: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  async function req<T>(path: string, init: RequestInit = {}, fallback: T): Promise<T> {
    const url = `${base}${path}`;
    const res = await doFetch(url, {
      ...init,
      headers: { Accept: 'application/json', ...auth, ...(init.headers || {}) },
    });
    // 404 is an ANSWER on this API — a game that was merged away or taken off the shelf —
    // so it returns the fallback rather than throwing. Anything else is the picker being
    // wrong or unreachable, and a queue that silently renders empty is the failure mode
    // this app has been bitten by before.
    if (res.status === 404) return fallback;
    if (!res.ok) throw new Error(`board-game-picker ${init.method || 'GET'} ${path} -> ${res.status}`);
    return (await res.json()) as T;
  }

  return {
    _base: base,

    games(query: string, categories: string[] = []): Promise<BoardGamesGameDto[]> {
      const params = new URLSearchParams({ q: String(query || '') });
      if (categories.length) params.set('categories', categories.join(','));
      return req<BoardGamesGameDto[]>(`/api/games?${params}`, {}, []);
    },

    game(id: string): Promise<BoardGamesGameDto | null> {
      return req<BoardGamesGameDto | null>(`/api/games/${encodeURIComponent(id)}`, {}, null);
    },

    /**
     * Plays for one game, optionally only those since a moment.
     *
     * `since` is EPOCH SECONDS here because that is what the entry stamp is; the endpoint
     * accepts both that and an ISO string.
     */
    plays(gameId: string, since: number | null = null): Promise<BoardGamesPlayDto[]> {
      const params = new URLSearchParams({ gameId: String(gameId) });
      if (since != null) params.set('since', String(since));
      return req<BoardGamesPlayDto[]>(`/api/plays?${params}`, {}, []);
    },

    categories(): Promise<string[]> {
      return req<string[]>('/api/categories', {}, []);
    },

    /** Log a play from here, so a known game does not REQUIRE opening the picker. */
    logPlay(gameId: string): Promise<BoardGamesPlayDto | null> {
      return req<BoardGamesPlayDto | null>('/api/plays', {
        body: JSON.stringify({ gameId }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }, null);
    },

    /**
     * The box art, as BYTES.
     *
     * Re-served through `/api/providers/:id/cover/:itemId` rather than hotlinked, exactly
     * as Kavita's is: the picker is a LAN host, and a browser on mobile data cannot reach
     * it even though this server can.
     */
    async cover(gameId: string): Promise<ProviderCover> {
      const game = await this.game(gameId);
      const imagePath = typeof game?.imagePath === 'string' ? game.imagePath : '';
      if (!imagePath) throw new Error(`board-game-picker: game '${gameId}' has no box art`);

      const url = imagePath.startsWith('http') ? imagePath : `${base}${imagePath}`;
      const res = await doFetch(url, { headers: { ...auth } });
      if (!res.ok) throw new Error(`board-game-picker cover ${gameId} -> ${res.status}`);

      return {
        buffer: Buffer.from(await res.arrayBuffer()),
        contentType: res.headers.get('content-type') || 'image/jpeg',
      };
    },
  };
}

// --- the in-process transport ------------------------------------------------- //

/**
 * The same six answers, out of the book of record.
 *
 * Each read re-assembles from rows rather than caching. That is deliberate for the moment:
 * WP-4d brings the first writers of these tables, and a cache with no invalidation hook would
 * turn "the owner just edited a game" into "the owner just edited a game, restart the app".
 * The whole collection is five queries; the shelf is a few hundred rows.
 *
 * The database handle is resolved PER CALL, never at construction. `providers/index.ts` builds
 * a client for every board-game route on a server that may have no collection at all, and an
 * eager `bookOfRecord()` would create `/config/queuepilot.sqlite` for a harness that never
 * asked a board-game question.
 */
export function boardGamesRepositoryClient({
  baseUrl, fetchImpl = null, db = null,
}: BoardGamesClientOptions = {}): BoardGamesCollectionClient {
  // Required even though NOTHING is fetched any more — WP-4d brought the last call home, so
  // this factory no longer builds an HTTP client at all. `_base` is what `materialize()` builds
  // `/play/<gameId>` out of, and that card is still a screen in the sibling app. WP-10 owns
  // retiring it and the host it runs on; this package ends at the transport.
  if (!baseUrl) throw new Error('boardGamesClient needs a baseUrl');
  const base = String(baseUrl).replace(/\/+$/, '');
  const handle = (): SqliteDatabase => db ?? bookOfRecord();

  /** A `Game` IS the DTO — this app's `Game` is a port of the one the endpoint serialised. */
  const toDto = (game: Game): BoardGamesGameDto => game as unknown as BoardGamesGameDto;

  return {
    _base: base,

    /**
     * Search the shelf. `searchBoardGames` is the ported endpoint body, so the empty-term
     * rule, the category scope, the publisher and year matching and the excluded-game rule
     * are all the same code that answered over HTTP.
     */
    games(query: string, categories: string[] = []): Promise<BoardGamesGameDto[]> {
      const database = handle();
      return Promise.resolve(
        searchBoardGames(listBoardGames(database), { categories, query }).map(toDto),
      );
    },

    /** One title, or null — which is what the endpoint's 404 already meant. */
    game(id: string): Promise<BoardGamesGameDto | null> {
      const found = listBoardGames(handle()).find((game) => game.id === id);
      return Promise.resolve(found ? toDto(found) : null);
    },

    /**
     * Plays for one game, optionally only those since a moment.
     *
     * `since` is EPOCH SECONDS, because that is what the entry stamp is. Newest first, the
     * ordering `listBoardGamePlays()` already guarantees — the provider only counts them, but
     * an order that changes between transports is a difference waiting to matter.
     */
    plays(gameId: string, since: number | null = null): Promise<BoardGamesPlayDto[]> {
      const after = playBound(since);
      return Promise.resolve(
        listBoardGamePlays(handle())
          .filter((play) => play.gameId === gameId)
          .filter((play) => {
            if (after === null) return true;
            const playedAt = Date.parse(play.playedAt);
            return !Number.isNaN(playedAt) && playedAt >= after;
          })
          .map(toPlayDto),
      );
    },

    categories(): Promise<string[]> {
      return Promise.resolve(listBoardGameCategories(handle()));
    },

    /**
     * THE WRITE CAME HOME (WP-4d).
     *
     * This was the one call left on the wire, and the reason was never the seam — it was that
     * two books of record were open and the absorb REPLACED all twelve tables on a fingerprint
     * change, so a play written here was erased by the next start. WP-4d retires the source
     * file, so the erasing no longer happens and the write belongs where the reads are.
     *
     * ⚠️ IT RECORDS NOBODY, AND THAT IS THE CORRECT ANSWER HERE. `personIds: []` is stated on
     * purpose, not defaulted: whoever pressed "we played this" on a tile is not filling in a
     * form, and a play may never INVENT a participant or a known-how claim from a counter
     * (`store/db/boardgamePlays.ts`). The screen that asks who was at the table is the
     * Collection screen WP-8 built, and it posts to `POST /api/board-games/plays` instead.
     * Do not "improve" this by guessing the roster.
     */
    logPlay(gameId: string): Promise<BoardGamesPlayDto | null> {
      // A play against a title this store has never heard of is a caller error, not a row.
      // `board_game_plays.game_id` has a foreign key, so the insert would throw; answering
      // `null` is what the HTTP client did with the 404 the sibling app returned.
      if (getBoardGame(gameId, handle()) === null) return Promise.resolve(null);
      return Promise.resolve(
        toPlayDto(logBoardGamePlay({ gameId, personIds: [] }, handle())),
      );
    },

    /**
     * The box art, as BYTES, off the staged `board-game-images/` directory.
     *
     * The covers are NOT a cache — 32 of them the owner chose by hand, and the upstream that
     * served the rest has turned access off — so they were copied across with the collection
     * and this reads the copy. A path that is an absolute URL still goes over the network,
     * because that was never the sibling app's host: it is an upstream image server, and the
     * HTTP client fetched it directly too.
     */
    async cover(gameId: string): Promise<ProviderCover> {
      const game = await this.game(gameId);
      const imagePath = typeof game?.imagePath === 'string' ? game.imagePath : '';
      if (!imagePath) throw new Error(`board-game-picker: game '${gameId}' has no box art`);

      if (imagePath.startsWith('http')) {
        const doFetch: FetchLike = fetchImpl || globalThis.fetch;
        const res = await doFetch(imagePath, {});
        if (!res.ok) throw new Error(`board-game-picker cover ${gameId} -> ${res.status}`);
        return {
          buffer: Buffer.from(await res.arrayBuffer()),
          contentType: res.headers.get('content-type') || 'image/jpeg',
        };
      }

      // `basename` and nothing else. The stored value is `/images/<hash>-600.webp` written by
      // the sibling app's own enrichment, but it is still a TEXT COLUMN in a database this app
      // no longer owns the writers of — joining it onto a directory with `join()` alone would
      // let `../` out of that directory.
      const file = join(imagesPath(), basename(imagePath));
      let buffer: Buffer;
      try {
        buffer = readFileSync(file);
      } catch {
        throw new Error(`board-game-picker: box art for '${gameId}' is not staged at ${file}`);
      }

      return {
        buffer,
        contentType: CONTENT_TYPES[extname(file).toLowerCase()] || 'image/jpeg',
      };
    },
  };
}

/**
 * The client `board-game-picker.ts` gets when nothing hands it one.
 *
 * In process by default since WP-4e; `BOARD_GAME_TRANSPORT=http` is the rollback.
 */
export function boardGamesClient(
  options: BoardGamesClientOptions = {},
): BoardGamesCollectionClient {
  return BOARD_GAME_TRANSPORT === 'http'
    ? boardGamesHttpClient(options)
    : boardGamesRepositoryClient(options);
}
