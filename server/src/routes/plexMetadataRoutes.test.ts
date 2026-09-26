// The ratings route must use the profile's managed token even when the caller does not
// provide a library scope. Otherwise it asks Plex for the admin's libraries and hides ratings
// that the selected profile is allowed to use.
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as plex from '../plex.js';
import * as plexSources from '../plexSources.js';
import * as sets from '../sets.js';
import { plexMetadataRoutes } from './plexMetadataRoutes.js';

afterEach(() => vi.restoreAllMocks());

describe('GET /plex-sources', () => {
  it('uses the selected Home account and refuses an unknown profile', async () => {
    vi.spyOn(plex, 'homeUsers').mockResolvedValue([
      { name: 'Admin', username: 'admin-login', id: 1, uuid: null, admin: true, restricted: false },
      { name: 'Kids', username: null, id: 2, uuid: 'kids-uuid', admin: false, restricted: true },
    ]);
    const discover = vi.spyOn(plexSources, 'plexSourcesForProfile').mockResolvedValue([]);
    vi.spyOn(plex, 'machineIdentifier').mockResolvedValue('home-server');

    const admin = await plexMetadataRoutes().request('/plex-sources');
    expect(admin.status).toBe(200);
    expect(await admin.json()).toEqual({ profile: 'admin-login', sources: [] });
    expect(discover).toHaveBeenLastCalledWith(null);

    const kids = await plexMetadataRoutes().request('/plex-sources?profile=Kids');
    expect(kids.status).toBe(200);
    expect(await kids.json()).toEqual({ profile: 'Kids', sources: [] });
    expect(discover).toHaveBeenLastCalledWith('kids-uuid');

    const unknown = await plexMetadataRoutes().request('/plex-sources?profile=not-a-user');
    expect(unknown.status).toBe(400);
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('marks the home server as local even when a managed account does not own it', async () => {
    vi.spyOn(plex, 'homeUsers').mockResolvedValue([
      { name: 'Kids', username: null, id: 2, uuid: 'kids-uuid', admin: false, restricted: true },
    ]);
    vi.spyOn(plex, 'machineIdentifier').mockResolvedValue('home-server');
    vi.spyOn(plexSources, 'plexSourcesForProfile').mockResolvedValue([
      { id: 'home-server', name: 'Home', owned: false, available: true, libraries: [] },
      { id: 'shared-server', name: 'Shared', owned: false, available: true, libraries: [] },
    ]);

    const response = await plexMetadataRoutes().request('/plex-sources?profile=Kids');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      profile: 'Kids',
      sources: [
        { id: 'home-server', name: 'Home', owned: false, local: true, available: true, libraries: [] },
        { id: 'shared-server', name: 'Shared', owned: false, local: false, available: true, libraries: [] },
      ],
    });
  });
});

describe('GET /ratings', () => {
  it('mints the profile token before loading every video library', async () => {
    const accountToken = vi.spyOn(plex, 'accountToken').mockResolvedValue('managed-token');
    const sections = vi.spyOn(plex, 'sections').mockResolvedValue([
      { id: 1, other: false, title: 'Shows', type: 'show', video: true },
      { id: 2, other: false, title: 'Music', type: 'artist', video: false },
    ]);
    const contentRatings = vi
      .spyOn(plex, 'contentRatings')
      .mockResolvedValue(['G', 'TV-Y7']);

    const response = await plexMetadataRoutes().request(
      '/ratings?uuid=profile-uuid',
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ratings: ['G', 'TV-Y7'],
    });
    expect(accountToken).toHaveBeenCalledWith('profile-uuid');
    expect(sections).toHaveBeenCalledOnce();
    expect(contentRatings).toHaveBeenCalledWith([1], 'managed-token');
  });
});

describe('GET /search on a shared Plex server', () => {
  it('derives access from the queue profile and returns server-scoped hits', async () => {
    vi.spyOn(sets, 'getSet').mockResolvedValue({
      id: 'fixture', source: 'queue', delivery: 'push', requires_profile: 'Kids',
    } as unknown as Awaited<ReturnType<typeof sets.getSet>>);
    vi.spyOn(plex, 'homeUsers').mockResolvedValue([
      { name: 'Kids', username: null, id: 2, uuid: 'kids-uuid', admin: false, restricted: true },
    ]);
    const access = {
      id: 'friend-id', name: 'Friend', baseUrl: 'https://friend.example', token: 'grant',
      libraries: [{ id: '7', title: 'Movies', type: 'movie' as const }],
    };
    const resolveAccess = vi.spyOn(plexSources, 'plexServerAccessForProfile').mockResolvedValue(access);
    vi.spyOn(plexSources, 'plexServerSearch').mockResolvedValue([{
      ratingKey: '42', title: 'Fixture Film', year: 2001, editionTitle: null,
      type: 'movie', sectionId: 7, hasThumb: true, viewCount: 0, viewOffset: 0,
      duration: 1_000, leafCount: 0, viewedLeafCount: 0,
      plexServer: 'friend-id', plexServerName: 'Friend',
    }]);

    const response = await plexMetadataRoutes().request(
      '/search?set=fixture&q=Fixture&plex_server=friend-id&section=7',
    );

    expect(response.status).toBe(200);
    expect(resolveAccess).toHaveBeenCalledWith('kids-uuid', 'friend-id');
    expect(await response.json()).toEqual({ results: [expect.objectContaining({
      ratingKey: '42', plexServer: 'friend-id',
      cover: '/api/shared-plex-thumb/fixture/friend-id/42',
    })] });
  });

  it('uses the queue-selected libraries and rejects a different library', async () => {
    vi.spyOn(sets, 'getSet').mockResolvedValue({
      id: 'fixture', source: 'queue', delivery: 'push', requires_profile: 'Kids',
      shared_libraries: { 'friend-id': ['7'] },
    } as unknown as Awaited<ReturnType<typeof sets.getSet>>);
    vi.spyOn(plex, 'homeUsers').mockResolvedValue([
      { name: 'Kids', username: null, id: 2, uuid: 'kids-uuid', admin: false, restricted: true },
    ]);
    vi.spyOn(plexSources, 'plexServerAccessForProfile').mockResolvedValue({
      id: 'friend-id', name: 'Friend', baseUrl: 'https://friend.example', token: 'grant',
      libraries: [
        { id: '7', title: 'Movies', type: 'movie' },
        { id: '8', title: 'Shows', type: 'show' },
      ],
    });
    const search = vi.spyOn(plexSources, 'plexServerSearch').mockResolvedValue([]);

    const scoped = await plexMetadataRoutes().request('/search?set=fixture&q=Film&plex_server=friend-id');
    expect(scoped.status).toBe(200);
    expect(search).toHaveBeenCalledWith(expect.anything(), ['7'], 'Film');

    const blocked = await plexMetadataRoutes().request(
      '/search?set=fixture&q=Film&plex_server=friend-id&section=8',
    );
    expect(blocked.status).toBe(403);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('combines home results with checked shared libraries in default Add search', async () => {
    vi.spyOn(sets, 'getSet').mockResolvedValue({
      id: 'fixture', source: 'queue', delivery: 'push', requires_profile: 'Kids',
      sections: [1], item_sections: [], shared_libraries: { 'friend-id': ['7'] },
    } as unknown as Awaited<ReturnType<typeof sets.getSet>>);
    vi.spyOn(plex, 'sections').mockResolvedValue([]);
    vi.spyOn(plex, 'search').mockResolvedValue([{
      ratingKey: '42', title: 'Home Film', type: 'movie', sectionId: 1,
    }] as unknown as Awaited<ReturnType<typeof plex.search>>);
    vi.spyOn(plex, 'collections').mockResolvedValue([]);
    vi.spyOn(plex, 'homeUsers').mockResolvedValue([
      { name: 'Kids', username: null, id: 2, uuid: 'kids-uuid', admin: false, restricted: true },
    ]);
    vi.spyOn(plexSources, 'plexServerAccessForProfile').mockResolvedValue({
      id: 'friend-id', name: 'Friend', baseUrl: 'https://friend.example', token: 'grant',
      libraries: [
        { id: '7', title: 'Movies', type: 'movie' },
        { id: '8', title: 'Shows', type: 'show' },
      ],
    });
    const sharedSearch = vi.spyOn(plexSources, 'plexServerSearch').mockResolvedValue([{
      ratingKey: '42', title: 'Shared Film', year: 2001, editionTitle: null,
      type: 'movie', sectionId: 7, hasThumb: true, viewCount: 0, viewOffset: 0,
      duration: 1_000, leafCount: 0, viewedLeafCount: 0,
      plexServer: 'friend-id', plexServerName: 'Friend',
    }]);

    const response = await plexMetadataRoutes().request('/search?set=fixture&q=Film&collections=1');
    expect(response.status).toBe(200);
    expect(sharedSearch).toHaveBeenCalledWith(expect.anything(), ['7'], 'Film');
    expect(await response.json()).toEqual({ results: [
      expect.objectContaining({ ratingKey: '42', title: 'Home Film' }),
      expect.objectContaining({ ratingKey: '42', title: 'Shared Film',
        plexServer: 'friend-id', cover: '/api/shared-plex-thumb/fixture/friend-id/42' }),
    ] });
  });
});
