// The ratings route must use the profile's managed token even when the caller does not
// provide a library scope. Otherwise it asks Plex for the admin's libraries and hides ratings
// that the selected profile is allowed to use.
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as plex from '../plex.js';
import * as plexSources from '../plexSources.js';
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
