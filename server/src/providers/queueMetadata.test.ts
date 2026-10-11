import { describe as suite, expect, it } from 'vitest';
import { describe, nextQueue } from '../engine/resolve.js';
import type { PlexClient, PlexMediaContainer } from '../types.js';
import { queueMetadataClient } from './queueMetadata.js';

const entries = (keys: string[]) => keys.map((ratingKey) => ({ ratingKey, plexServer: null }));
const movie = (ratingKey: string, viewCount = 0) => ({ ratingKey, type: 'movie', title: `Movie ${ratingKey}`, viewCount });

suite('fresh lineup metadata batches', () => {
  it('groups direct home-server keys, preserves profile scope and leaves other reads live', async () => {
    const calls: [string, string | null | undefined][] = [];
    let count = 0;
    const client: PlexClient = {
      container(path, token) {
        calls.push([path, token]);
        return { Metadata: [movie('1', count), movie('2', count)] };
      },
      accountToken: () => 'minted',
    };
    const first = await queueMetadataClient(client, [
      ...entries(['1', '2', '1']), { ratingKey: '3', plexServer: 'remote-server' },
      { ratingKey: 'unsafe/key', plexServer: null },
    ], 'profile-token');
    expect(calls).toEqual([['/library/metadata/1,2', 'profile-token']]);
    expect((await first.container('/library/metadata/1', 'profile-token')).Metadata).toEqual([movie('1')]);
    await first.container('/library/metadata/1', 'other-profile');
    await first.container('/library/metadata/1');
    await first.container('/library/metadata/1/allLeaves', 'profile-token');
    await first.container('/library/metadata/1?includeExtras=1', 'profile-token');
    expect(calls.slice(1)).toEqual([
      ['/library/metadata/1', 'other-profile'], ['/library/metadata/1', null],
      ['/library/metadata/1/allLeaves', 'profile-token'],
      ['/library/metadata/1?includeExtras=1', 'profile-token'],
    ]);
    expect(await first.accountToken('profile')).toBe('minted');
    count = 1;
    const second = await queueMetadataClient(client, entries(['1', '2']), 'profile-token');
    expect((await second.container('/library/metadata/1', 'profile-token')).Metadata?.[0]?.viewCount).toBe(1);
    expect((await first.container('/library/metadata/1', 'profile-token')).Metadata?.[0]?.viewCount).toBe(0);
  });

  it('keeps batches bounded and joins responses by identity rather than response order', async () => {
    const sizes: number[] = [];
    const client: PlexClient = {
      container(path) {
        const keys = path.slice('/library/metadata/'.length).split(',');
        sizes.push(keys.length);
        return { Metadata: keys.reverse().map((key) => movie(key)) };
      },
      accountToken: () => null,
    };
    const wrapped = await queueMetadataClient(client, entries(Array.from({ length: 121 }, (_, i) => String(i + 1))), null);
    expect(sizes).toEqual([50, 50, 21]);
    expect((await wrapped.container('/library/metadata/1')).Metadata).toEqual([movie('1')]);
    expect((await wrapped.container('/library/metadata/121')).Metadata).toEqual([movie('121')]);
    expect(sizes).toHaveLength(3);
  });

  it('retries missing and ambiguous rows individually without accepting unexpected rows', async () => {
    const calls: string[] = [];
    const client: PlexClient = {
      container(path) {
        calls.push(path);
        return path.includes(',')
          ? { Metadata: [movie('1'), movie('1'), movie('9')] }
          : { Metadata: [movie(path.split('/').at(-1)!)] };
      },
      accountToken: () => null,
    };
    const wrapped = await queueMetadataClient(client, entries(['1', '2']), null);
    for (const key of ['1', '2', '9']) {
      expect((await wrapped.container(`/library/metadata/${key}`)).Metadata).toEqual([movie(key)]);
    }
    expect(calls).toEqual(['/library/metadata/1,2', '/library/metadata/1', '/library/metadata/2', '/library/metadata/9']);
  });

  it('falls back after a batch failure and preserves individual failures', async () => {
    const client: PlexClient = {
      container(path) {
        if (path.includes(',') || path.endsWith('/2')) throw Error('unavailable');
        return { Metadata: [movie('1')] };
      },
      accountToken: () => null,
    };
    const wrapped = await queueMetadataClient(client, entries(['1', '2']), null);
    expect((await wrapped.container('/library/metadata/1')).Metadata).toEqual([movie('1')]);
    expect(() => wrapped.container('/library/metadata/2')).toThrow('unavailable');
  });

  it('does not add a prefetch to empty, single-entry or remote-only starts', async () => {
    const client: PlexClient = { container: () => { throw Error('unexpected read'); }, accountToken: () => null };
    expect(await queueMetadataClient(client, [], null)).toBe(client);
    expect(await queueMetadataClient(client, entries(['1']), null)).toBe(client);
    expect(await queueMetadataClient(client, [{ ratingKey: '1', plexServer: 'remote' }], null)).toBe(client);
  });

  it('preserves seeded lineup, queue history, shared-server identity and fresh episode resolution', async () => {
    const direct = new Map(['1', '2', '3'].map((key) => [key, movie(key)]));
    const leaves = [{ ratingKey: '40', title: 'Episode', type: 'episode', parentIndex: 1, index: 1, duration: 1000 }];
    direct.set('4', { ratingKey: '4', title: 'Series', type: 'show', viewCount: 0 });
    let leafReads = 0;
    const client: PlexClient = {
      container(path): PlexMediaContainer {
        if (path.endsWith('/allLeaves')) { leafReads += 1; return { Metadata: leaves }; }
        return { Metadata: path.slice('/library/metadata/'.length).split(',')
          .flatMap((key) => direct.has(key) ? [direct.get(key)!] : []).reverse() };
      },
      accountToken: () => null,
    };
    const remote: PlexClient = { ...client, container: () => ({ Metadata: [{ ...movie('1'), title: 'Shared Movie' }] }) };
    const list = [
      describe({ ratingKey: '1', placement: 'priority', lead: 'always' }),
      describe({ ratingKey: '2', watch_history: 'provider' }),
      describe({ ratingKey: '3', weight: 2 }),
      describe({ ratingKey: '4', item_order: 'shuffle' }),
      describe({ id: 'remote-entry', ratingKey: '1', plex_server: 'remote-server' }),
    ];
    const cfg = { watch_history: 'queue', length: 10, add_as: 'random' };
    const rng = () => {
      let seed = 7;
      return { random: () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; },
        shuffle: (items: unknown[]) => { items.reverse(); } };
    };
    const run = (home: PlexClient) => nextQueue(home, 'fixture', cfg, list, new Set(['2']), 'profile-token', rng(),
      async () => true, () => new Map(), async (entry) => entry.plexServer ? remote : home);
    const before = await run(client);
    const wrapped = await queueMetadataClient(client, list, 'profile-token');
    expect(await run(wrapped)).toEqual(before);
    expect(before.play.some((item) => item.plexServer === 'remote-server' && item.title === 'Shared Movie')).toBe(true);
    expect(before.play.some((item) => item.ratingKey === '2')).toBe(false);
    expect(leafReads).toBe(2);
    leaves.push({ ...leaves[0]!, ratingKey: '41', title: 'New Episode', index: 2 });
    const refreshed = await run(await queueMetadataClient(client, list, 'profile-token'));
    expect(refreshed.play.some((item) => item.ratingKey === '41')).toBe(true);
    expect(leafReads).toBe(3);
  });
});
