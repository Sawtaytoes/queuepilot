// The one plex.tv JSON helper. `plex.ts` (managed-user tokens, Plex Home users) and
// `playback.ts` (the Companion device list) each used to carry their own copy, and the two
// drifted: one gained a timeout and the other did not.
//
// TLS: plex.tv has a public certificate, so this uses the global `fetch` with full
// certificate checks. It must never borrow the LAN Plex agent, whose
// `rejectUnauthorized: false` exists only for a self-signed local server. The global
// `fetch` is also the seam the e2e harnesses replace to answer plex.tv offline.
import { PLEX_CLIENT_IDENTIFIER, PLEX_TOKEN } from './config.js';
import { PLEXTV_TIMEOUT_MS } from './env.js';

export async function plextv<T = unknown>(path: string, token = PLEX_TOKEN, method = 'GET'): Promise<T> {
  const res = await fetch(`https://plex.tv${path}`, {
    method,
    headers: {
      'X-Plex-Token': token,
      'X-Plex-Client-Identifier': PLEX_CLIENT_IDENTIFIER,
      Accept: 'application/json',
    },
    // A WAN call with no timeout hangs whatever waits on it for as long as the OS keeps a
    // black-holed socket open. The seek path and the page load both wait on this one.
    signal: AbortSignal.timeout(PLEXTV_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`plex.tv ${res.status} for ${path}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}
