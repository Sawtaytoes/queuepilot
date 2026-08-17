// Steam Web API client. Thin, and shaped like the endpoints rather than like the engine —
// the media-neutral shape is steam.ts's job, not this file's.
//
// ONE endpoint does almost all of the work: `IPlayerService/GetOwnedGames` returns the whole
// owned library in a single response — appid, name, cumulative playtime, and the moment each
// game was last played. There is no per-game lookup, no search endpoint and no pagination,
// so this client fetches the library ONCE and answers every question from it.
//
// THE LIBRARY IS MEMOIZED, and that is not merely an optimisation. The account here owns
// ~960 games, the response is ~400 KB, and `search()` is called on every keystroke in the
// queue editor. Without the memo, typing "elden" is nine full library downloads.
//
// WHAT THIS FILE MUST NEVER FETCH: the profile, the friends list, or anything under
// `ISteamUser` beyond resolving the configured account. QueuePilot is a public repo and
// those endpoints carry people — the same rule the Board Game Picker client follows for
// `/api/collection`.
import type { ProviderCover } from '../types.js';

/** Steam's own host. Not configurable: this is the vendor's API, not a self-hosted service. */
const API_BASE = 'https://api.steampowered.com';

/**
 * Steam's public art CDN. Needs no key and no account — the library art for an appid is
 * world-readable, which is why `cover()` below sends no credential to it.
 */
const CDN_BASE = 'https://cdn.cloudflare.steamstatic.com/steam/apps';

/** How long the owned-games response is reused. See this file's header. */
const LIBRARY_TTL_MS = 60_000;

// --- the DTOs, as loosely as Steam actually returns them ---------------------- //
//
// Not in types.ts, for the same reason the Kavita and picker DTOs are not: these are a
// REMOTE API's response shapes. Every field is optional — a required field here would be a
// claim about Valve's server that nothing in this repo can hold it to.

/** One owned game, as `GetOwnedGames` returns it with `include_appinfo=1`. */
export interface SteamGameDto {
  appid?: number;
  name?: string;
  /** Cumulative MINUTES, all platforms. Written when a session ENDS — see steam.ts. */
  playtime_forever?: number;
  /** Minutes in the trailing two weeks. Absent on a game not played recently. */
  playtime_2weeks?: number;
  /**
   * Epoch SECONDS of the last session's end, or absent/0 for a game never played.
   *
   * This is the field the whole done-rule rests on. Verified live 2026-08-17: present on
   * 822 of 963 owned games, the remaining 141 being games never launched.
   */
  rtime_last_played?: number;
  img_icon_url?: string;
  [field: string]: unknown;
}

/** The `fetch` seam. Same shape as the other clients', for the same offline-test reason. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface SteamHttpClient {
  /** Every owned game, memoized. */
  library(): Promise<SteamGameDto[]>;
  /** One game by appid, from the memoized library. `null` when it is not owned. */
  game(appid: string): Promise<SteamGameDto | null>;
  /** Substring match over owned titles, best-effort ranked. */
  search(query: string): Promise<SteamGameDto[]>;
  cover(appid: string): Promise<ProviderCover>;
}

export interface SteamClientOptions {
  /** The Steam Web API key. REQUIRED — see steam.ts's requireToken call. */
  apiKey: string;
  /** The 64-bit account id whose library is queued. */
  steamId: string;
  fetchImpl?: FetchLike | null;
}

export function steamClient({ apiKey, steamId, fetchImpl = null }: SteamClientOptions): SteamHttpClient {
  if (!apiKey) throw new Error('steamClient needs an apiKey');
  if (!steamId) throw new Error('steamClient needs a steamId');
  const doFetch: FetchLike = fetchImpl || globalThis.fetch;

  let cached: SteamGameDto[] | null = null;
  let cachedAt = 0;
  /** In-flight de-duplication: nine concurrent keystrokes share ONE request, not nine. */
  let inFlight: Promise<SteamGameDto[]> | null = null;

  async function fetchLibrary(): Promise<SteamGameDto[]> {
    const params = new URLSearchParams({
      key: apiKey,
      steamid: steamId,
      include_appinfo: '1',
      include_played_free_games: '1',
    });
    const res = await doFetch(`${API_BASE}/IPlayerService/GetOwnedGames/v1/?${params}`, {
      headers: { Accept: 'application/json' },
    });
    // 401/403 is the key being wrong; anything else non-OK is Valve being unreachable. Both
    // throw rather than resolving empty — a queue that silently renders as "nothing owned"
    // is the failure mode this app has been bitten by twice.
    if (!res.ok) throw new Error(`steam GetOwnedGames -> ${res.status}`);

    const body = (await res.json()) as { response?: { games?: SteamGameDto[] } };
    const games = body?.response?.games;
    // An EMPTY `response` object is Steam's answer when the profile's game details are
    // private — a 200 with nothing in it. Distinguished from "owns no games" only by
    // intent, so it is called out by name here rather than read as an empty library.
    if (!Array.isArray(games)) {
      throw new Error(
        'steam GetOwnedGames returned no games array — this is what a PRIVATE profile looks '
        + "like (Steam answers 200 with an empty response). Check the account's Game Details "
        + 'privacy setting before suspecting the key.',
      );
    }
    return games;
  }

  async function library(): Promise<SteamGameDto[]> {
    if (cached && Date.now() - cachedAt < LIBRARY_TTL_MS) return cached;
    if (inFlight) return inFlight;

    inFlight = fetchLibrary()
      .then((games) => {
        cached = games;
        cachedAt = Date.now();
        return games;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return {
    library,

    async game(appid: string): Promise<SteamGameDto | null> {
      const wanted = String(appid);
      const games = await library();
      return games.find((g) => String(g.appid) === wanted) || null;
    },

    /**
     * Substring search over owned titles.
     *
     * Steam has no search endpoint scoped to a library, so this is a local filter over the
     * memoized response. Ranked so a prefix match beats a mid-string one — with ~960 games,
     * typing "port" should surface *Portal* above *Teleportation Simulator*.
     */
    async search(query: string): Promise<SteamGameDto[]> {
      const q = String(query || '').trim().toLowerCase();
      if (!q) return [];

      const games = await library();
      const scored: { game: SteamGameDto; rank: number }[] = [];
      for (const game of games) {
        const name = String(game.name ?? '').toLowerCase();
        if (!name) continue;
        const at = name.indexOf(q);
        if (at < 0) continue;
        // 0 = exact, 1 = starts-with, 2 = contains. Ties break on playtime, so the games
        // actually played float up — a library this size is mostly things bought in a sale.
        const rank = name === q ? 0 : at === 0 ? 1 : 2;
        scored.push({ game, rank });
      }
      scored.sort((a, b) => (
        a.rank - b.rank
        || Number(b.game.playtime_forever ?? 0) - Number(a.game.playtime_forever ?? 0)
        || String(a.game.name).localeCompare(String(b.game.name))
      ));
      return scored.map((s) => s.game);
    },

    /**
     * The library poster, as BYTES.
     *
     * Re-served through `/api/providers/:id/cover/:itemId` like every other provider's art.
     * Steam's CDN is public so hotlinking would technically work, but `coverUrl()` in
     * index.ts builds that path for every provider unconditionally, and a second art path
     * for one backend is exactly the kind of per-kind branch the seam exists to prevent.
     *
     * Falls back through the three shapes Valve publishes, because `library_600x900` is
     * missing for a fair number of older titles: the portrait poster, the landscape header,
     * then nothing. NO CREDENTIAL is sent — this is a public CDN, and appending the API key
     * to an image URL is how a key ends up in someone's browser history.
     */
    async cover(appid: string): Promise<ProviderCover> {
      const id = encodeURIComponent(String(appid));
      const candidates = [
        `${CDN_BASE}/${id}/library_600x900.jpg`,
        `${CDN_BASE}/${id}/header.jpg`,
      ];

      for (const url of candidates) {
        const res = await doFetch(url, {});
        if (!res.ok) continue;
        return {
          buffer: Buffer.from(await res.arrayBuffer()),
          contentType: res.headers.get('content-type') || 'image/jpeg',
        };
      }
      throw new Error(`steam: app '${appid}' has no library art`);
    },
  };
}
