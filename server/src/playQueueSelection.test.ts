import { describe, expect, it, vi } from 'vitest';
import type { PlexClient } from './types.js';

const calls = vi.hoisted(() => [] as URL[]);
vi.mock('undici', async (original) => ({
  ...await original<typeof import('undici')>(),
  request: vi.fn(async (url: string) => {
    const parsed = new URL(url);
    calls.push(parsed);
    const keys = parsed.searchParams.get('uri')!.split('/').at(-1)!.split(',');
    // Plex's continuous mode expands even an episode key into the rest of its show.
    const expanded = parsed.searchParams.get('continuous') === '1' ? [...keys, '102', '103'] : keys;
    return { statusCode: 200, body: { text: async () => JSON.stringify({
      MediaContainer: { size: expanded.length, playQueueID: 77, Metadata: expanded.map((ratingKey) => ({ ratingKey })) },
    }) } };
  }),
}));
import { createPlayQueue } from './playback.js';
import { describe as describeEntry, nextQueue } from './engine/resolve.js';

const client: PlexClient = {
  container(path) {
    if (path.endsWith('/allLeaves')) return { Metadata: [
      { ratingKey: '101', type: 'episode', title: 'Spooky episode', parentIndex: 1, index: 1, viewOffset: 1000, duration: 10000 },
      { ratingKey: '102', type: 'episode', title: 'Ordinary episode', parentIndex: 1, index: 2 },
    ] };
    const ratingKey = path.split('/').at(-1)!;
    return { Metadata: [{ ratingKey, type: ratingKey === '100' ? 'show' : 'movie', title: ratingKey }] };
  },
  accountToken: async () => null,
};
const options = { token: 'fixture', host: 'http://192.0.2.10:32400', machineIdentifier: 'fixture-server' };

describe('QueuePilot owns Plex queue selection', () => {
  it('does not ask Plex to expand a single selected episode into its series', async () => {
    await createPlayQueue(['101'], options);
    expect(calls.at(-1)!.searchParams.get('continuous')).toBe('0');
    expect(calls.at(-1)!.searchParams.get('uri')).toBe('server://fixture-server/com.plexapp.plugins.library/library/metadata/101');
  });

  it('queues one selected seasonal episode and then another member of the seasonal pool', async () => {
    const lineup = await nextQueue(client, 'seasonal', {
      source: 'queue', kind: 'picks', add_as: 'random', length: 2,
    }, [describeEntry({ ratingKey: '100', episodes: 1 }), describeEntry({ ratingKey: '200' })], new Set<string>(), null);
    const keys = lineup.play.map((item) => item.ratingKey);
    expect(keys).toHaveLength(2);
    expect(keys).toEqual(['101', '200']);
    expect(keys).not.toContain('102');
    await createPlayQueue(keys, options);
    expect(calls.at(-1)!.searchParams.get('continuous')).toBe('0');
    expect(calls.at(-1)!.searchParams.get('uri')!.split('/').at(-1)).toBe(keys.join(','));
  });
});
