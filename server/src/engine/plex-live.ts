// Live undici-backed Plex client for the Node selection engine (D3 follow-on #4).
// Same surface as the corpus replay client (plex-replay.ts): container(path, token) and
// accountToken(uuid). Both return Promises; the engine awaits every call, so the sync
// replay client still works (await on a plain value is a no-op).
//
// Reuses server/src/plex.js — the same keepalive pool, retry policy, and account-token
// mint that the web API already uses in production. No second HTTP stack.
import { plexGet, accountToken as mintAccountToken } from '../plex.js';
import type { PlexClient, PlexMediaContainer } from '../types.js';

export function liveClient(): PlexClient {
  return {
    async container(path: string, token: string | null = null): Promise<PlexMediaContainer> {
      const data = (await plexGet(path, token)) as { MediaContainer?: PlexMediaContainer } | null;
      return (data && data.MediaContainer) || {};
    },
    // null uuid => admin token path (engine treats null as "use default X-Plex-Token").
    async accountToken(uuid: string | null | undefined): Promise<string | null> {
      if (!uuid) return null;
      return (await mintAccountToken(uuid)) as string | null;
    },
  };
}
