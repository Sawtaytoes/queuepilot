import { PLEX_CLIENT_IDENTIFIER, PLEX_TOKEN } from './config.js';
import type { NextEp, PlexClient, PlexMediaContainer, PlexMetadata, Start } from './types.js';
import type { ShowEpisodes } from './plex.js';

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

/** A private connection. Never return its URL or token from an HTTP route. */
export interface PlexServerAccess {
  id: string;
  name: string;
  baseUrl: string;
  token: string;
  libraries: PlexSource['libraries'];
}

async function profileToken(userUuid: string | null, fetchImpl: Fetch): Promise<string> {
  if (!PLEX_TOKEN) throw new Error('Plex is not connected');
  if (!userUuid) return PLEX_TOKEN;
  const response = await fetchImpl(`https://plex.tv/api/v2/home/users/${encodeURIComponent(userUuid)}/switch`, {
    method: 'POST',
    headers: {
      'X-Plex-Token': PLEX_TOKEN,
      'X-Plex-Client-Identifier': PLEX_CLIENT_IDENTIFIER,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error(`Could not switch Plex profile (${response.status})`);
  const switched = await response.json() as { authToken?: string };
  if (!switched.authToken) throw new Error('Plex did not return a profile token');
  return switched.authToken;
}

/** Resolve a server only through the selected account's current Plex grant. */
export async function plexServerAccessForProfile(
  userUuid: string | null,
  serverId: string,
  { fetchImpl = fetch }: { fetchImpl?: Fetch } = {},
): Promise<PlexServerAccess | null> {
  if (!/^[a-zA-Z0-9-]+$/.test(serverId)) return null;
  const token = await profileToken(userUuid, fetchImpl);
  const raw = await jsonGet('https://plex.tv/api/v2/resources?includeHttps=1', token, fetchImpl);
  const resources = (Array.isArray(raw) ? raw : (raw as { resources?: Resource[] })?.resources || []) as Resource[];
  const server = resources.find((r) => r.clientIdentifier === serverId
    && String(r.provides || '').split(',').includes('server'));
  if (!server) return null;
  const serverToken = server.accessToken || (server.owned ? token : null);
  if (!serverToken) return null;
  const connections = [...(server.connections || [])].sort(
    (a, b) => Number(Boolean(a.local)) - Number(Boolean(b.local)),
  );
  for (const connection of connections) {
    if (!connection.uri?.startsWith('https://') && !server.owned) continue;
    if (!connection.uri) continue;
    const baseUrl = connection.uri.replace(/\/+$/, '');
    try {
      const sections = await jsonGet(`${baseUrl}/library/sections`, serverToken, fetchImpl) as {
        MediaContainer?: { Directory?: { key?: string; title?: string; type?: string }[] };
      };
      return {
        id: serverId,
        name: server.name || 'Plex server',
        baseUrl,
        token: serverToken,
        libraries: (sections.MediaContainer?.Directory || [])
          .filter((s): s is { key: string; title: string; type: 'movie' | 'show' } =>
            Boolean(s.key && s.title) && (s.type === 'movie' || s.type === 'show'))
          .map((s) => ({ id: s.key, title: s.title, type: s.type })),
      };
    } catch {
      // A Plex server can advertise several connections; try the next one.
    }
  }
  return null;
}

export async function plexServerGet(
  access: PlexServerAccess, path: string, fetchImpl: Fetch = fetch,
): Promise<{ MediaContainer?: PlexMediaContainer }> {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid Plex path');
  return jsonGet(`${access.baseUrl}${path}`, access.token, fetchImpl) as Promise<{
    MediaContainer?: PlexMediaContainer;
  }>;
}

export function plexServerClient(access: PlexServerAccess, fetchImpl: Fetch = fetch): PlexClient {
  return {
    async container(path: string): Promise<PlexMediaContainer> {
      return (await plexServerGet(access, path, fetchImpl)).MediaContainer || {};
    },
    async accountToken(): Promise<string> { return access.token; },
  };
}

export interface PlexServerSearchHit {
  ratingKey: string;
  title: string;
  year: number | null;
  editionTitle: string | null;
  type: 'movie' | 'show';
  sectionId: number;
  hasThumb: boolean;
  viewCount: number;
  viewOffset: number;
  duration: number;
  leafCount: number;
  viewedLeafCount: number;
  plexServer: string;
  plexServerName: string;
}

/** Search only libraries proven to belong to this account's server grant. */
export async function plexServerSearch(
  access: PlexServerAccess,
  sectionIds: readonly string[],
  query: string,
  fetchImpl: Fetch = fetch,
): Promise<PlexServerSearchHit[]> {
  const allowed = new Set(access.libraries.map((library) => library.id));
  const sections = sectionIds.length ? sectionIds.filter((id) => allowed.has(id)) : [...allowed];
  const seen = new Set<string>();
  const hits: PlexServerSearchHit[] = [];
  for (const section of sections) {
    let rows: PlexMetadata[] = [];
    try {
      const result = await plexServerGet(
        access,
        `/library/sections/${encodeURIComponent(section)}/all?title=${encodeURIComponent(query)}`
          + '&includeGuids=1&X-Plex-Container-Size=50',
        fetchImpl,
      );
      rows = result.MediaContainer?.Metadata || [];
    } catch {
      continue;
    }
    for (const row of rows) {
      if ((row.type !== 'movie' && row.type !== 'show') || row.ratingKey == null) continue;
      const ratingKey = String(row.ratingKey);
      if (seen.has(ratingKey)) continue;
      seen.add(ratingKey);
      hits.push({
        ratingKey,
        title: String(row.title || 'Untitled'),
        year: row.year == null ? null : Number(row.year),
        editionTitle: row.editionTitle ? String(row.editionTitle) : null,
        type: row.type,
        sectionId: Number(section),
        hasThumb: Boolean(row.thumb),
        viewCount: Number(row.viewCount) || 0,
        viewOffset: Number(row.viewOffset) || 0,
        duration: Number(row.duration) || 0,
        leafCount: Number(row.leafCount) || 0,
        viewedLeafCount: Number(row.viewedLeafCount) || 0,
        plexServer: access.id,
        plexServerName: access.name,
      });
    }
  }
  return hits;
}

/** The same season/episode picker shape as the home server, read under the shared grant. */
export async function plexServerEpisodes(
  access: PlexServerAccess,
  ratingKey: string,
  includeSpecialChoices = false,
  fetchImpl: Fetch = fetch,
): Promise<ShowEpisodes | null> {
  if (!/^\d+$/.test(ratingKey)) return null;
  const leaves = (await plexServerGet(access, `/library/metadata/${ratingKey}/allLeaves`, fetchImpl))
    .MediaContainer?.Metadata;
  if (!leaves) return null;
  const countable = leaves.filter((leaf) => leaf.type === 'episode' && Number(leaf.duration) > 0)
    .filter((leaf) => !(Number(leaf.parentIndex) === 0
      && Number(leaf.index) >= 200 && Number(leaf.index) <= 399));
  const realSeasons = new Set(countable
    .map((leaf) => Number(leaf.parentIndex) || 0).filter((season) => season !== 0));
  const seasons = new Map<number, ShowEpisodes['seasons'][number]['episodes']>();
  for (const leaf of countable) {
    const season = Number(leaf.parentIndex) || 0;
    if (!includeSpecialChoices && realSeasons.size && season === 0) continue;
    const rows = seasons.get(season) || [];
    rows.push({
      ratingKey: String(leaf.ratingKey || ''),
      episode: leaf.index == null ? null : Number(leaf.index),
      title: String(leaf.title || ''),
      watched: Number(leaf.viewCount) > 0,
    });
    seasons.set(season, rows);
  }
  return {
    multiSeason: realSeasons.size > 1,
    seasons: [...seasons].sort((a, b) => (a[0] === 0 ? 1 : b[0] === 0 ? -1 : a[0] - b[0]))
      .map(([season, episodes]) => ({
        season,
        episodes: episodes.sort((a, b) => Number(a.episode) - Number(b.episode)),
      })),
  };
}

/** Read an item's poster without exposing the shared server token or URL. */
export async function plexServerThumb(
  access: PlexServerAccess,
  ratingKey: string,
  fetchImpl: Fetch = fetch,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  if (!/^\d+$/.test(ratingKey)) return null;
  const metadata = await plexServerGet(access, `/library/metadata/${ratingKey}`, fetchImpl);
  const thumb = metadata.MediaContainer?.Metadata?.[0]?.thumb;
  if (!thumb || typeof thumb !== 'string' || !thumb.startsWith('/')) return null;
  const response = await fetchImpl(`${access.baseUrl}${thumb}`, {
    headers: {
      'X-Plex-Token': access.token,
      'X-Plex-Client-Identifier': PLEX_CLIENT_IDENTIFIER,
    },
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) return null;
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') || 'image/jpeg',
  };
}

/** Resolve the display and next-up fields for one shared-server entry. */
export async function plexServerTile(
  access: PlexServerAccess,
  value: { ratingKey?: unknown; title?: unknown },
  start: Start | null,
  skipped: ReadonlySet<string>,
  includedSpecials: ReadonlySet<string>,
  completed: ReadonlySet<string> | null,
  progress: ReadonlyMap<string, { positionMs: number }> | null,
  setId: string,
): Promise<{
  resolved: boolean; ratingKey: string | null; type: string | null; title: string;
  year: number | null; editionTitle: string | null; childCount: null; nextEp: NextEp | null;
  isNextEpFailed: boolean; skippedCount: number; partiallyWatched: boolean;
  viewOffset: number; duration: number; webUrl: null; cover: string | null; isFinished: boolean;
}> {
  const ratingKey = value.ratingKey == null ? '' : String(value.ratingKey);
  const fallback = String(value.title || (ratingKey ? `ratingKey ${ratingKey}` : 'Unknown item'));
  const unresolved = () => ({
    resolved: false, ratingKey: null, type: null, title: fallback, year: null,
    editionTitle: null, childCount: null, nextEp: null, isNextEpFailed: false,
    skippedCount: 0, partiallyWatched: false, viewOffset: 0, duration: 0,
    webUrl: null as null, cover: null, isFinished: false,
  });
  if (!/^\d+$/.test(ratingKey)) return unresolved();
  try {
    const result = await plexServerGet(access, `/library/metadata/${ratingKey}`);
    const item = result.MediaContainer?.Metadata?.[0];
    if (!item || (item.type !== 'movie' && item.type !== 'show')) return unresolved();
    const cover = item.thumb
      ? `/api/shared-plex-thumb/${encodeURIComponent(setId)}`
        + `/${encodeURIComponent(access.id)}/${encodeURIComponent(ratingKey)}`
      : null;
    let nextEp: NextEp | null = null;
    let isNextEpFailed = false;
    let skippedCount = 0;
    if (item.type === 'show') {
      try {
        const leaves = (await plexServerGet(access, `/library/metadata/${ratingKey}/allLeaves`))
          .MediaContainer?.Metadata || [];
        const countable = leaves
          .filter((leaf) => leaf.type === 'episode' && Number(leaf.duration) > 0)
          .filter((leaf) => !(Number(leaf.parentIndex) === 0
            && Number(leaf.index) >= 200 && Number(leaf.index) <= 399));
        const hasRegular = countable.some((leaf) => Number(leaf.parentIndex) !== 0);
        const playable = countable
          .filter((leaf) => Number(leaf.parentIndex) !== 0 || !hasRegular
            || includedSpecials.has(`server:${access.id}:rk:${String(leaf.ratingKey)}`))
          .sort((a, b) => Number(a.parentIndex) - Number(b.parentIndex) || Number(a.index) - Number(b.index));
        skippedCount = playable.filter((leaf) => skipped.has(
          `server:${access.id}:rk:${String(leaf.ratingKey)}`,
        )).length;
        const candidate = playable
          .filter((leaf) => {
            if (!start) return true;
            const season = Number(leaf.parentIndex) || 0;
            const episode = Number(leaf.index) || 0;
            return season > Number(start.season || 0)
              || (season === Number(start.season || 0) && episode >= Number(start.episode || 0));
          })
          .find((leaf) => {
            const key = String(leaf.ratingKey);
            if (skipped.has(`server:${access.id}:rk:${key}`)) return false;
            if (completed) return !completed.has(key);
            return !(Number(leaf.viewCount) > 0);
          });
        if (candidate) {
          const position = progress?.get(String(candidate.ratingKey))?.positionMs
            ?? (Number(candidate.viewOffset) || 0);
          nextEp = {
            ratingKey: String(candidate.ratingKey),
            season: Number(candidate.parentIndex) || null,
            episode: Number(candidate.index) || null,
            title: candidate.title ? String(candidate.title) : null,
            partiallyWatched: position > 0 && !(Number(candidate.viewCount) > 0),
            viewOffset: position,
            duration: Number(candidate.duration) || 0,
          };
        }
      } catch {
        isNextEpFailed = true;
      }
    }
    const viewOffset = Number(item.viewOffset) || 0;
    const watched = Number(item.viewCount) > 0;
    return {
      resolved: true,
      ratingKey,
      type: item.type,
      title: String(item.title || fallback),
      year: item.year == null ? null : Number(item.year),
      editionTitle: item.editionTitle ? String(item.editionTitle) : null,
      childCount: null,
      nextEp,
      isNextEpFailed,
      skippedCount,
      partiallyWatched: item.type === 'movie'
        ? viewOffset > 0 && !watched
        : Boolean(nextEp?.partiallyWatched),
      viewOffset: item.type === 'movie' ? viewOffset : Number(nextEp?.viewOffset) || 0,
      duration: item.type === 'movie' ? Number(item.duration) || 0 : Number(nextEp?.duration) || 0,
      webUrl: null,
      cover,
      isFinished: item.type === 'movie' && watched,
    };
  } catch {
    return unresolved();
  }
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
  const token = await profileToken(userUuid, fetchImpl);
  return plexSourcesForToken(token, { fetchImpl });
}
