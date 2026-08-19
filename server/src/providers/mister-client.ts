// MiSTer FPGA client, over the mrext "remote" API. Thin, and shaped like the endpoints
// rather than like the engine — the media-neutral shape is mister.ts's job.
//
// mrext runs ON the MiSTer itself and indexes the ROM share, so this is a LAN service with
// no credential at all: it is configured by base URL, the same named exception the Board
// Game Picker takes. Requiring a token it does not issue would report a working backend as
// NOT CONFIGURED.
//
// A GAME IS ADDRESSED BY ITS ABSOLUTE PATH. There is no id, no database key, and nothing
// stable-but-opaque to store — mrext identifies a game as
// `/media/fat/games/SNES/Games/Super Mario World (USA).zip/Super Mario World (USA).sfc`,
// and that string is what a queue entry holds. It is stable as long as the ROM stays put,
// which is exactly the guarantee the ROM share already makes (games-ingest's symlink
// convention exists to keep those paths from moving).
//
// WHAT THIS FILE DOES NOT DO: launch. mrext exposes `POST /games/launch`, and calling it
// from here would skip the three things Home Assistant does around a launch — save via the
// OSD, enable the Xbox Wireless Adapter, and switch the remote to Retro Games — and would
// be a new REST bridge between services, which the house rules forbid. Launching stays with
// HA's `script.control_games`; this app answers WHAT to launch.
import type { ProviderCover, ProviderSearchHit } from '../types.js';
import { boxartUrls } from './mister-boxart.js';
import { isCachedMiss, readCachedArt, writeCachedArt } from './mister-boxart-cache.js';

/** How long the systems list is reused. It changes when cores are installed, i.e. rarely. */
const SYSTEMS_TTL_MS = 300_000;

// --- the DTOs, as loosely as mrext actually returns them ---------------------- //

/** A system (= core) — `SNES`, `NES`, `Arcade`. The provider's "libraries". */
export interface MisterSystemDto {
  id?: string;
  name?: string;
  category?: string;
}

/** One indexed game. `path` is the identity — see this file's header. */
export interface MisterGameDto {
  name?: string;
  path?: string;
  system?: MisterSystemDto;
}

/** `GET /games/playing` — all empty strings when the core is sitting at the menu. */
export interface MisterPlayingDto {
  core?: string;
  system?: string;
  systemName?: string;
  game?: string;
  gameName?: string;
}

/** The `fetch` seam. Same shape as the other clients', for the same offline-test reason. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface MisterHttpClient {
  _base: string;
  systems(): Promise<MisterSystemDto[]>;
  search(query: string, system?: string): Promise<MisterGameDto[]>;
  /** What is running RIGHT NOW, or null at the menu. The close-watcher's signal. */
  playing(): Promise<MisterPlayingDto | null>;
  /**
   * Box art for a game, from the libretro archive — NOT from the MiSTer.
   *
   * On this client rather than in the provider because it is a network fetch with a
   * fallback chain, which is exactly what this layer is for; the provider stays the
   * media-neutral shape. See mister-boxart.ts for why the art comes from elsewhere at all.
   */
  cover(system: string, title: string): Promise<ProviderCover>;
}

export interface MisterClientOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike | null;
}

export function misterClient({ baseUrl, fetchImpl = null }: MisterClientOptions = {}): MisterHttpClient {
  if (!baseUrl) throw new Error('misterClient needs a baseUrl');
  // The API lives under `/api` on the host that proxies the MiSTer. Tolerated with or
  // without it in config, because both spellings are the obvious thing to write and a
  // wrong-looking-but-working URL is worse than accepting either.
  const root = String(baseUrl).replace(/\/+$/, '');
  const base = root.endsWith('/api') ? root : `${root}/api`;
  const doFetch: FetchLike = fetchImpl || globalThis.fetch;

  let systemsCache: MisterSystemDto[] | null = null;
  let systemsAt = 0;

  async function req<T>(path: string, init: RequestInit = {}, fallback: T): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
      ...init,
      headers: { Accept: 'application/json', ...(init.headers || {}) },
    });
    // 404 is an ANSWER here — a game removed from the share, a system with no index — so it
    // returns the fallback. Anything else is the MiSTer being off or unreachable, which
    // must NOT read as an empty queue: a MiSTer that is powered down is the normal state of
    // a MiSTer, and "your queue is empty" would be a lie every time it is asleep.
    if (res.status === 404) return fallback;
    if (!res.ok) throw new Error(`mister ${init.method || 'GET'} ${path} -> ${res.status}`);
    return (await res.json()) as T;
  }

  return {
    _base: base,

    async systems(): Promise<MisterSystemDto[]> {
      if (systemsCache && Date.now() - systemsAt < SYSTEMS_TTL_MS) return systemsCache;
      const body = await req<{ systems?: MisterSystemDto[] }>('/games/search/systems', {}, {});
      const list = Array.isArray(body.systems) ? body.systems : [];
      systemsCache = list;
      systemsAt = Date.now();
      return list;
    },

    /**
     * Search the index. `system` is a SINGLE system id or `all` — mrext takes no list, which
     * is why mister.ts fans out rather than passing a scope straight through.
     */
    async search(query: string, system = 'all'): Promise<MisterGameDto[]> {
      const body = await req<{ data?: MisterGameDto[] }>('/games/search', {
        body: JSON.stringify({ query: String(query || ''), system: String(system || 'all') }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }, {});
      return Array.isArray(body.data) ? body.data : [];
    },

    /**
     * Box art, as BYTES, re-served through this origin like every other provider's.
     *
     * Tries box art, then the title screen, then an in-game snap. A miss on all three throws,
     * which the cover route turns into the same blank tile a MiSTer queue had before — no art
     * is a normal outcome here, not an error worth a stack trace.
     *
     * NOTE this is the one call in this client that does not go to the MiSTer at all, so it
     * works while the MiSTer is powered down — which is most of the time.
     */
    async cover(system: string, title: string): Promise<ProviderCover> {
      const candidates = boxartUrls(system, title);
      if (!candidates.length) throw new Error(`mister: no thumbnail source for system '${system}'`);

      // The cache is checked before the network on BOTH answers — see mister-boxart-cache.ts
      // for why remembering a miss matters more than remembering a hit.
      const cached = await readCachedArt(system, title);
      if (cached) return { buffer: cached, contentType: 'image/png' };
      if (await isCachedMiss(system, title)) {
        throw new Error(`mister: no artwork for “${title}” (${system}) [cached]`);
      }

      for (const url of candidates) {
        // Deliberately NOT `doFetch`: that seam exists so the offline suite can stub the
        // MiSTer, and this is a different host entirely. A test that wants to stub the
        // archive injects its own client.
        const res = await fetch(url);
        if (!res.ok) continue;
        const buffer = Buffer.from(await res.arrayBuffer());
        await writeCachedArt(system, title, buffer);
        // Always image/png: all three archive folders serve .png, so this is a fact about
        // the source rather than a guess, and it means a cache hit needs no sidecar to
        // remember a content type by.
        return { buffer, contentType: 'image/png' };
      }
      await writeCachedArt(system, title, null);
      throw new Error(`mister: no artwork for “${title}” (${system})`);
    },

    /**
     * What is running now, or null.
     *
     * mrext answers with every field empty rather than 404ing when the core is at the menu,
     * so "no game" is a shape rather than a status — which is exactly the transition the
     * close-watcher cares about.
     */
    async playing(): Promise<MisterPlayingDto | null> {
      const body = await req<MisterPlayingDto>('/games/playing', {}, {});
      return body && String(body.game || '') ? body : null;
    },
  };
}

/** A game DTO as the editor's search hit. Exported so the provider and its tests agree. */
export const toSearchHit = (g: MisterGameDto): ProviderSearchHit => ({
  id: String(g.path ?? ''),
  title: String(g.name ?? ''),
  libraryId: String(g.system?.id ?? ''),
  libraryTitle: String(g.system?.name ?? g.system?.id ?? ''),
  type: 'game',
});
