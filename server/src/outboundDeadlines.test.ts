// Pins the 2026-11-13 decision: no process-wide TLS bypass, a self-signed LAN Plex is reached
// only through its scoped agent, and every outbound call carries a deadline.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

type UndiciCall = { url: string; opts: { dispatcher?: unknown; signal?: unknown } };
const undiciCalls = vi.hoisted(() => [] as UndiciCall[]);
vi.mock('undici', async (original) => ({
  ...await original<typeof import('undici')>(),
  request: vi.fn(async (url: string, opts: UndiciCall['opts']) => {
    undiciCalls.push({ url, opts });
    if (url.endsWith('/library/metadata/7')) {
      const body = JSON.stringify({ MediaContainer: { Metadata: [{ thumb: '/library/metadata/7/thumb/1' }] } });
      return { statusCode: 200, headers: {}, body: { json: async () => JSON.parse(body), dump: async () => {} } };
    }
    // The transcode fails, so the raw art fallback is exercised as well.
    if (url.includes('/photo/:/transcode')) {
      return { statusCode: 500, headers: {}, body: { dump: async () => {} } };
    }
    return {
      statusCode: 200,
      headers: { 'content-type': 'image/png' },
      body: { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer },
    };
  }),
}));

import { plextv } from './plexTv.js';
import { thumb } from './plex.js';
import { kavitaClient } from './providers/kavita-client.js';
import { misterClient } from './providers/mister-client.js';
import { steamClient } from './providers/steam-client.js';

const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json' },
});

afterEach(() => {
  vi.unstubAllGlobals();
  undiciCalls.length = 0;
});

describe('TLS', () => {
  it('the runtime image sets no process-wide certificate bypass', () => {
    const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
    const settings = dockerfile.split('\n').filter((line) => !line.trimStart().startsWith('#'));
    expect(settings.join('\n')).not.toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/);
  });

  it('poster reads from PLEX_URL go through the scoped Plex agent, with a deadline', async () => {
    const poster = await thumb('7');
    expect(poster?.contentType).toBe('image/png');
    expect(poster?.buffer).toEqual(Buffer.from([1, 2, 3]));
    const posterCalls = undiciCalls.filter((c) => !c.url.endsWith('/library/metadata/7'));
    expect(posterCalls.map((c) => c.url.includes('/photo/:/transcode'))).toEqual([true, false]);
    const plexAgent = undiciCalls[0]!.opts.dispatcher;
    expect(plexAgent).toBeDefined();
    for (const call of posterCalls) {
      expect(call.opts.dispatcher).toBe(plexAgent);
      expect(call.opts.signal).toBeInstanceOf(AbortSignal);
    }
  });
});

describe('every outbound call has a deadline', () => {
  it('plex.tv uses the one shared helper, verified TLS, and a timeout', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ ok: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(plextv('/api/v2/devices', 'fixture-token')).resolves.toEqual({ ok: 1 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://plex.tv/api/v2/devices');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    // No custom dispatcher: plex.tv must never borrow the LAN agent's rejectUnauthorized:false.
    expect((init as { dispatcher?: unknown }).dispatcher).toBeUndefined();
  });

  it('Kavita: auth, API calls and covers', async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => (url.includes('/authenticate')
      ? jsonResponse({ token: 'jwt', username: 'Ada' })
      : jsonResponse({ id: 1 })));
    const client = kavitaClient({ baseUrl: 'https://kavita.example.com', apiKey: 'k', fetchImpl });
    await client.series(1);
    await client.cover(1);
    expect(fetchImpl.mock.calls.length).toBe(3);
    for (const [, init] of fetchImpl.mock.calls) expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('MiSTer: the API', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ data: [] }));
    await misterClient({ baseUrl: 'http://mister.example.com', fetchImpl }).search('zelda');
    expect(fetchImpl.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('Steam: the owned-games read', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ response: { games: [] } }));
    await steamClient({ apiKey: 'k', steamId: '1', fetchImpl }).library();
    expect(fetchImpl.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
