import { KAVITA_URL } from '../../env.js';
import { tokenFor } from '../../providers/config.js';

/**
 * A read-only client for one Kavita library.
 *
 * Kavita is one place rulebook PDFs can live. Nothing in the app depends on it: this file is
 * reached only by the rulebook linker, which writes plain URLs into the database and then
 * never talks to Kavita again. Someone keeping their rulebooks in Calibre, a Nextcloud folder,
 * or a shoebox writes a different linker — or types the URLs in by hand, which the UI supports
 * for exactly that reason.
 *
 * Two things about the API that cost an afternoon:
 *
 *   1. **The API key is not a bearer token.** It buys a JWT from
 *      `/api/Plugin/authenticate`, and that JWT is what every other call wants.
 *   2. **`POST /api/Series?libraryId=` is gone** (404 on 0.8.x). The surviving route is
 *      `POST /api/Series/all-v2` with a filter DTO, whose fields are *numeric ids* — 19 is the
 *      library. So the response is ALSO filtered by `libraryId` client-side: if a future
 *      Kavita renumbers the field, this returns fewer matches rather than the wrong library's.
 */

export interface KavitaSeries {
  id: number;
  name: string;
}

/** Only the three fields of Kavita's series DTO this reads. */
interface RawSeries {
  id?: unknown;
  libraryId?: unknown;
  name?: unknown;
}

export interface KavitaConfig {
  /** e.g. `https://kavita.example.com` — no trailing slash. */
  baseUrl: string;
  apiKey: string;
  libraryId: number;
}

/** The numeric id of the `libraries` filter field in Kavita's DTO. */
const FILTER_FIELD_LIBRARY = 19;

const trimSlash = (url: string): string => url.replace(/\/+$/, '');

/**
 * Read the linker's configuration.
 *
 * The base URL and the API key come from the machinery this app already has, NOT from a second
 * read of `process.env`: `KAVITA_URL` is `env.ts`'s single deploy-time base URL, and
 * `tokenFor('kavita', 'kavita')` is the one credential path allowed to resolve a token (env
 * `KAVITA_API_KEY` first, then the 0600 provider-secrets file). Only the library number, which
 * is specific to this linker and to nothing else, is read from the environment here.
 *
 * `null` — not a throw — when it is absent: no Kavita is the normal state of this app, and the
 * caller says so and exits 0.
 */
export const kavitaConfigFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): KavitaConfig | null => {
  const baseUrl = KAVITA_URL;
  const apiKey = tokenFor('kavita', 'kavita').token;
  if (!baseUrl || !apiKey) return null;

  return {
    apiKey,
    baseUrl: trimSlash(baseUrl),
    libraryId: Number(env.KAVITA_RULEBOOK_LIBRARY_ID ?? 1),
  };
};

/** Exchange the API key for the JWT everything else needs. */
export const authenticate = async (config: KavitaConfig): Promise<string> => {
  const url = new URL('/api/Plugin/authenticate', config.baseUrl);
  url.searchParams.set('apiKey', config.apiKey);
  url.searchParams.set('pluginName', 'board-game-picker');

  const response = await fetch(url, { method: 'POST' });
  if (!response.ok)
    throw new Error(`Kavita auth failed — ${response.status}. Check KAVITA_API_KEY.`);

  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== 'string') throw new Error('Kavita auth returned no token');

  return body.token;
};

export const listSeries = async (
  config: KavitaConfig,
  token: string,
): Promise<KavitaSeries[]> => {
  const url = new URL('/api/Series/all-v2', config.baseUrl);
  url.searchParams.set('PageNumber', '1');
  // One page: a rulebook library is hundreds of series at the very most, and paging adds a
  // failure mode for no gain.
  url.searchParams.set('PageSize', '1000');

  const response = await fetch(url, {
    body: JSON.stringify({
      combination: 1,
      limitTo: 0,
      statements: [
        {
          comparison: 0,
          field: FILTER_FIELD_LIBRARY,
          value: String(config.libraryId),
        },
      ],
    }),
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    method: 'POST',
  });

  if (!response.ok) throw new Error(`Kavita series listing failed — ${response.status}`);

  // `unknown` first, then narrowed: the platform `fetch` types `json()` as `any`, which
  // silently disables every type check downstream of it.
  const body: unknown = await response.json();
  if (!Array.isArray(body)) return [];

  return (body as RawSeries[])
    .filter((series) => series.libraryId === config.libraryId)
    .map((series) => ({
      id: Number(series.id),
      // Never coerced: a non-string `name` is a payload we do not understand, and
      // `[object Object]` matched against the collection is worse than one missing rulebook.
      name: typeof series.name === 'string' ? series.name : '',
    }))
    .filter((series) => Number.isFinite(series.id) && series.name !== '');
};

/**
 * The page a human should land on. Kavita's series route, not a file download: the reader is
 * the good bit, and a URL with a token in it would be a credential pasted into the database.
 */
export const seriesUrl = (config: KavitaConfig, seriesId: number): string =>
  `${config.baseUrl}/library/${config.libraryId}/series/${seriesId}`;
