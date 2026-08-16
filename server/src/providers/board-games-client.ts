// Board Game Picker HTTP client. Thin, and shaped like the endpoints rather than like the
// engine — the media-neutral shape is board-games.ts's job, not this file's.
//
// The picker exposes a DELIBERATELY NARROW integration surface: games and play timestamps,
// and nothing carrying a person (board-games decision
// 2026-08-16-the-integration-api-is-games-only-never-the-collection). Its `/api/collection`
// endpoint holds players, groups and who was at the table.
//
//   THIS FILE MUST NEVER CALL `/api/collection`.
//
// QueuePilot is a public repo; a convenience fetch of that URL would put the household's
// people into this app's cache, logs and error reports. The offline suite asserts on it.
//
// Auth is an OPTIONAL bearer token. The picker only demands one when its own
// BOARD_GAME_PICKER_API_TOKEN is set, so an unset token here is the normal deployment and
// not the "unconfigured" failure Plex and Kavita treat it as.
import type { ProviderCover } from '../types.js';

// --- the DTOs, as loosely as the picker actually returns them ----------------- //
//
// Not in types.ts, for the same reason the Kavita DTOs are not: these are a REMOTE API's
// response shapes. Every field is optional — a required field here would be a claim about
// someone else's server that nothing in this repo can hold it to.

/** One physical box of a game. The picker's shelf location lives here. */
export interface BoardGamesBoxDto {
  id?: string;
  label?: string;
  kind?: string;
  locationText?: string | null;
  [field: string]: unknown;
}

/** A game, as `/api/games` and `/api/games/:id` return it. */
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

/** A play row. Three keys, by the picker's own design — no players, no notes. */
export interface BoardGamesPlayDto {
  id?: string;
  gameId?: string;
  playedAt?: string;
  [field: string]: unknown;
}

/** The `fetch` seam. Same shape as the Kavita client's, for the same offline-test reason. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface BoardGamesHttpClient {
  _base: string;
  games(query: string, categories?: string[]): Promise<BoardGamesGameDto[]>;
  game(id: string): Promise<BoardGamesGameDto | null>;
  plays(gameId: string, since?: number | null): Promise<BoardGamesPlayDto[]>;
  categories(): Promise<string[]>;
  logPlay(gameId: string): Promise<BoardGamesPlayDto | null>;
  cover(gameId: string): Promise<ProviderCover>;
}

export interface BoardGamesClientOptions {
  baseUrl?: string;
  /** Optional — see this file's header. Sent as `Authorization: Bearer` when present. */
  token?: string | null;
  fetchImpl?: FetchLike | null;
}

export function boardGamesClient({
  baseUrl, token = null, fetchImpl = null,
}: BoardGamesClientOptions = {}): BoardGamesHttpClient {
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
    if (!res.ok) throw new Error(`board-games ${init.method || 'GET'} ${path} -> ${res.status}`);
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
     * `since` is EPOCH SECONDS here because that is what the entry stamp is; the picker
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
      if (!imagePath) throw new Error(`board-games: game '${gameId}' has no box art`);

      const url = imagePath.startsWith('http') ? imagePath : `${base}${imagePath}`;
      const res = await doFetch(url, { headers: { ...auth } });
      if (!res.ok) throw new Error(`board-games cover ${gameId} -> ${res.status}`);

      return {
        buffer: Buffer.from(await res.arrayBuffer()),
        contentType: res.headers.get('content-type') || 'image/jpeg',
      };
    },
  };
}
