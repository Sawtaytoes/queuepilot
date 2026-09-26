import { describe, expect, it } from 'vitest';

import {
  describe as describeEntry, entryKey as resolverEntryKey, resolveMember,
} from './engine/resolve.js';
import type { PlexClient } from './types.js';
import { entryKey as queueEntryKey } from './queues.js';

describe('shared Plex entry identity', () => {
  it('scopes the same rating key to its server in both entry-key readers', () => {
    const local = { ratingKey: '42', title: 'Local item' };
    const remote = { ratingKey: '42', title: 'Shared item', plex_server: 'friend-server' };

    expect(queueEntryKey(local)).toBe('rk:42');
    expect(queueEntryKey(remote)).toBe('server:friend-server:rk:42');
    expect(resolverEntryKey(remote)).toBe(queueEntryKey(remote));
    expect(describeEntry(remote).plexServer).toBe('friend-server');
  });

  it('uses the shared server watch state and qualified skip keys', async () => {
    const client: PlexClient = {
      container(path) {
        if (path === '/library/metadata/42') {
          return { Metadata: [{ ratingKey: '42', type: 'show', title: 'Shared show' }] };
        }
        if (path === '/library/metadata/42/allLeaves') {
          return { Metadata: [
            { ratingKey: '10', type: 'episode', title: 'One', parentIndex: 1,
              index: 1, duration: 1000, viewCount: 1 },
            { ratingKey: '11', type: 'episode', title: 'Two', parentIndex: 1,
              index: 2, duration: 1000 },
            { ratingKey: '12', type: 'episode', title: 'Three', parentIndex: 1,
              index: 3, duration: 1000 },
          ] };
        }
        throw new Error(`Unexpected path: ${path}`);
      },
      accountToken: async () => null,
    };
    const entry = describeEntry({ ratingKey: '42', plex_server: 'friend-server' });
    const result = await resolveMember(client, entry, {
      skipped: ['server:friend-server:rk:11', '12'],
    }, new Set(['12']), null, 3, true);

    expect(result?.items.map((item) => item.ratingKey)).toEqual(['12']);
    expect(result?.items[0]?.plexServer).toBe('friend-server');
  });
});
