import { beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  materialize: vi.fn(async () => ({ readingListId: 7 })),
  handoff: vi.fn(() => ({ mode: 'pull', url: 'https://reader.example.com/library/2/series/3/manga/4?incognitoMode=false&readingListId=7' })),
  lineup: vi.fn(async (..._args: unknown[]) => [{ key: 'chapter:4' }]),
}));
vi.mock('../engine/routing.js', () => ({ loadSets: () => ({ sets: { reading: { enabled: true, source: 'queue' } } }) }));
vi.mock('./blocks.js', () => ({ isMixed: () => false, resolveSingle: () => ({ provider: 'books' }) }));
vi.mock('./index.js', () => ({ providerFor: () => ({ delivery: 'pull', kind: 'kavita', materialize: f.materialize, handoff: f.handoff }) }));
vi.mock('./pullLineup.js', () => ({ pullLineup: f.lineup }));
import { launcherRoutes } from './launcher.js';
import { readerHandoff } from './readerHandoff.js';

const destination = 'https://reader.example.com/library/2/series/3/manga/4?incognitoMode=false&readingListId=7';
const app = launcherRoutes();

describe('Android reader handoff', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('finishes one rebuild before serving fresh links with the complete reader context', async () => {
    const response = await app.request('/go/reading?only=chapter%3A4', { headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 16) Chrome/157.0' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('vary')).toBe('User-Agent');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(f.materialize).toHaveBeenCalledTimes(1);
    expect(f.lineup.mock.calls[0]?.[3]).toEqual({ only: 'chapter:4' });
    const body = await response.text();
    expect(body).toContain('Open Kavita website');
    expect(body).toContain('intent://reader.example.com/library/2/series/3/manga/4?incognitoMode=false&amp;readingListId=7#Intent;');
    expect(body).toContain(`S.browser_fallback_url=${encodeURIComponent(destination)};end`);
    expect(body).not.toContain('<script');
    expect(body).not.toContain('http-equiv="refresh"');
    expect(body).not.toContain('package=');
  });

  it('preserves the ordinary redirect on other devices', async () => {
    const response = await app.request('/go/reading');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(destination);
  });

  it('preserves launch errors on Android without offering a dead reader link', async () => {
    const response = await app.request('/go/missing', { headers: { 'User-Agent': 'Android' } });
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('unknown queue');
    expect(f.materialize).not.toHaveBeenCalled();
  });

  it('escapes navigation attributes and rejects executable or credential-bearing URLs', () => {
    const body = String(readerHandoff('https://reader.example.com/?q=%22%3E%3Cscript%3E&readingListId=7'));
    expect(body).not.toContain('<script>');
    expect(body).toContain('&amp;readingListId=7');
    expect(() => readerHandoff('javascript:alert(1)')).toThrow('Unsupported reader address');
    expect(() => readerHandoff('https://user:password@reader.example.com/')).toThrow('Unsupported reader address');
  });
});
