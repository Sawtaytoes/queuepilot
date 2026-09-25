import { describe, expect, it } from 'vitest';
import { plexSourcesForToken } from './plexSources.js';

const reply = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

describe('Plex source discovery', () => {
  it('lists only the account grants and uses each remote server token', async () => {
    const requests: { url: string; token: string | null }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const token = new Headers(init?.headers).get('X-Plex-Token');
      requests.push({ url, token });
      if (url.startsWith('https://plex.tv/')) return reply([
        {
          name: 'Home', clientIdentifier: 'home-id', provides: 'server', owned: true,
          accessToken: 'home-grant', connections: [{ uri: 'https://home.example' }],
        },
        {
          name: 'Friend', clientIdentifier: 'friend-id', provides: 'server', owned: false,
          accessToken: 'friend-grant',
          connections: [{ uri: 'https://offline.example' }, { uri: 'https://friend.example' }],
        },
        { name: 'Phone', clientIdentifier: 'phone-id', provides: 'player' },
      ]);
      if (url.startsWith('https://offline.example/')) throw new Error('unreachable');
      if (url.startsWith('https://home.example/')) return reply({
        MediaContainer: { Directory: [{ key: '1', title: 'Movies', type: 'movie' }] },
      });
      if (url.startsWith('https://friend.example/')) return reply({
        MediaContainer: { Directory: [
          { key: '1', title: 'Shows', type: 'show' },
          { key: '2', title: 'Music', type: 'artist' },
        ] },
      });
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    const sources = await plexSourcesForToken('selected-account', { fetchImpl });
    expect(sources).toEqual([
      { id: 'home-id', name: 'Home', owned: true, available: true,
        libraries: [{ id: '1', title: 'Movies', type: 'movie' }] },
      { id: 'friend-id', name: 'Friend', owned: false, available: true,
        libraries: [{ id: '1', title: 'Shows', type: 'show' }] },
    ]);
    expect(requests.find((r) => r.url.startsWith('https://plex.tv/'))?.token).toBe('selected-account');
    expect(requests.find((r) => r.url.startsWith('https://friend.example/'))?.token).toBe('friend-grant');
    expect(JSON.stringify(sources)).not.toContain('grant');
    expect(JSON.stringify(sources)).not.toContain('friend.example');
  });

  it('does not use the admin token for a shared server without a grant', async () => {
    const requests: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      requests.push(String(input));
      return reply([{
        name: 'Friend', clientIdentifier: 'friend-id', provides: 'server', owned: false,
        connections: [{ uri: 'https://friend.example' }],
      }]);
    }) as typeof fetch;
    expect(await plexSourcesForToken('selected-account', { fetchImpl })).toEqual([{
      id: 'friend-id', name: 'Friend', owned: false, available: false, libraries: [],
    }]);
    expect(requests).toHaveLength(1);
  });
});
