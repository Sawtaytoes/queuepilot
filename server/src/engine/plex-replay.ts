// Node side of the D3 corpus oracle: serve the SAME recordings the Python plex.py record/replay
// writes (see queue_builder/plex.py _corpus_record / docs/d3-engine-parity-corpus.md), so the
// Node selection engine can run offline against the fixed synthetic corpus that
// `e2e/engine-parity.mjs` diffs both engines over.
//
// File scheme (identical to Python): <dir>/get/<alias>/<sha1(path)[:16]>.json, payload
// { "data": { "MediaContainer": … } }. Alias buckets by identity, never the token:
//   * history is fetched with the admin token   → alias "admin"   (token null here)
//   * a managed account's library view           → alias "acct:<uuid>"
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { isNodeError } from '../errors.js';
import type { PlexClient, PlexMediaContainer } from '../types.js';

// Mirror of Python urllib.parse.urlencode(quote_via=quote_plus) for the exact query strings the
// engine builds — the sha1 key is over the literal path, so an off-by-one in encoding is a miss.
function quotePlus(s: unknown): string {
  return encodeURIComponent(String(s)).replace(/%20/g, '+').replace(/[!'()*~]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
export function urlencode(pairs: readonly (readonly [unknown, unknown])[]): string {
  return pairs.map(([k, v]) => `${quotePlus(k)}=${quotePlus(v)}`).join('&');
}

const aliasFor = (token: string | null | undefined): string => (token == null ? 'admin' : `acct:${token}`);

/**
 * A replay client with the surface the engine needs: container(path, token) + accountToken(uuid).
 *
 * SYNCHRONOUS on purpose — see `PlexClient` in types.ts. Every engine call site awaits, and
 * `await` on a plain value is a no-op, so the parity gates can run the whole engine offline
 * against the recorded corpus. Making these async would break exactly that.
 */
export function replayClient(dir: string): PlexClient {
  const container = (p: string, token: string | null = null): PlexMediaContainer => {
    const h = createHash('sha1').update(p, 'utf8').digest('hex').slice(0, 16);
    const file = path.join(dir, 'get', aliasFor(token), `${h}.json`);
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (e) {
      if (isNodeError(e) && e.code === 'ENOENT') {
        throw new Error(`corpus miss: get ${p} (alias ${aliasFor(token)}) — regenerate the corpus`);
      }
      throw e;
    }
    // Cast, not a guard: a corpus file that isn't `{data: {MediaContainer}}` is a broken fixture,
    // and the original threw on it. `payload.data` still TypeErrors on a literal `null` payload.
    const payload = JSON.parse(raw) as { data?: { MediaContainer?: PlexMediaContainer } };
    const data = payload.data || {};
    return data.MediaContainer || {};
  };
  return {
    container,
    // Replay: hand back the uuid itself as the "token", so container() buckets it as acct:<uuid>
    // — matching how the Python shim buckets an account's recorded _get calls.
    accountToken: (uuid: string | null | undefined): string | null => uuid || null,
  };
}
