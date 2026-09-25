import { PLEX_CLIENT_IDENTIFIER, PLEX_TOKEN } from './config.js';

type Fetch = typeof fetch;

interface ResourceConnection { uri?: string; local?: boolean }
interface Resource {
  name?: string;
  clientIdentifier?: string;
  provides?: string;
  owned?: boolean;
  accessToken?: string;
  connections?: ResourceConnection[];
}

export interface PlexSource {
  id: string;
  name: string;
  owned: boolean;
  available: boolean;
  libraries: { id: string; title: string; type: 'movie' | 'show' }[];
}

async function jsonGet(url: string, token: string, fetchImpl: Fetch): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: {
      'X-Plex-Token': token,
      'X-Plex-Client-Identifier': PLEX_CLIENT_IDENTIFIER,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error(`Plex answered ${response.status}`);
  return response.json();
}

/** Discover only the servers this account can access. Tokens and connection URLs stay here. */
export async function plexSourcesForToken(
  accountToken: string,
  { fetchImpl = fetch }: { fetchImpl?: Fetch } = {},
): Promise<PlexSource[]> {
  const raw = await jsonGet('https://plex.tv/api/v2/resources?includeHttps=1', accountToken, fetchImpl);
  const resources = (Array.isArray(raw) ? raw : (raw as { resources?: Resource[] })?.resources || []) as Resource[];
  const servers = resources.filter((r) =>
    String(r.provides || '').split(',').includes('server') && Boolean(r.clientIdentifier),
  );

  return Promise.all(servers.map(async (server): Promise<PlexSource> => {
    const source: PlexSource = {
      id: String(server.clientIdentifier),
      name: server.name || 'Plex server',
      owned: Boolean(server.owned),
      available: false,
      libraries: [],
    };
    // A remote server's accessToken is server-scoped. The Home admin's token may stand in
    // only for a server that admin owns; using it for a shared server would bypass the
    // resource's grant and make an unauthorized library look available.
    const token = server.accessToken || (server.owned ? accountToken : null);
    if (!token) return source;

    // Plex may advertise LAN addresses we cannot route to. Try each advertised connection
    // until one serves this account's actual section list. No guessed endpoint is used.
    const connections = [...(server.connections || [])].sort(
      (a, b) => Number(Boolean(a.local)) - Number(Boolean(b.local)),
    );
    for (const connection of connections) {
      // A shared server may advertise an HTTP URL on the public internet. Do not send its
      // access token over that connection; Plex also advertises secure plex.direct URLs.
      if (!connection.uri?.startsWith('https://') && !server.owned) continue;
      if (!connection.uri) continue;
      try {
        const rawSections = await jsonGet(
          `${connection.uri.replace(/\/+$/, '')}/library/sections`, token, fetchImpl,
        ) as { MediaContainer?: { Directory?: { key?: string; title?: string; type?: string }[] } };
        source.available = true;
        source.libraries = (rawSections.MediaContainer?.Directory || [])
          .filter((section): section is { key: string; title: string; type: 'movie' | 'show' } =>
            Boolean(section.key && section.title)
            && (section.type === 'movie' || section.type === 'show'),
          )
          .map((section) => ({ id: section.key, title: section.title, type: section.type }));
        break;
      } catch {
        // The next advertised connection may work (local and remote URLs often differ).
      }
    }
    return source;
  }));
}

/** A managed user's switch token is required before resource discovery. */
export async function plexSourcesForProfile(
  userUuid: string | null,
  { fetchImpl = fetch }: { fetchImpl?: Fetch } = {},
): Promise<PlexSource[]> {
  let token = PLEX_TOKEN;
  if (!token) throw new Error('Plex is not connected');
  if (userUuid) {
    const response = await fetchImpl(`https://plex.tv/api/v2/home/users/${encodeURIComponent(userUuid)}/switch`, {
      method: 'POST',
      headers: {
        'X-Plex-Token': token,
        'X-Plex-Client-Identifier': PLEX_CLIENT_IDENTIFIER,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) throw new Error(`Could not switch Plex profile (${response.status})`);
    const switched = await response.json() as { authToken?: string };
    if (!switched.authToken) throw new Error('Plex did not return a profile token');
    token = switched.authToken;
  }
  return plexSourcesForToken(token, { fetchImpl });
}
