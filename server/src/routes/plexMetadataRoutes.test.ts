// The ratings route must use the profile's managed token even when the caller does not
// provide a library scope. Otherwise it asks Plex for the admin's libraries and hides ratings
// that the selected profile is allowed to use.
import { describe, expect, it, vi } from 'vitest';

import * as plex from '../plex.js';
import { plexMetadataRoutes } from './plexMetadataRoutes.js';

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
