import { describe, expect, it } from 'vitest';
import { modernQueueLink, plexOwnsMediaButtons } from './plexPlaybackModern.js';

describe('modern Plex playback protocol', () => {
  it('addresses the complete server queue and converts resume milliseconds to seconds', () => {
    const url = new URL(modernQueueLink('test-server', 42, 15000, '123'));
    expect(url.protocol).toBe('plex:');
    expect(url.hostname + url.pathname).toBe('watch/video');
    expect(url.searchParams.get('uri')).toBe('server://test-server/com.plexapp.plugins.library/library/metadata/123');
    expect(url.searchParams.get('offset')).toBe('15');
    expect(url.searchParams.get('containerKey')).toBe('/playQueues/42');
    expect(url.searchParams.get('key')).toBe('/library/metadata/123');
    expect(url.searchParams.has('token')).toBe(false);
  });
  it.each([['bad\'server', 42], ['server', '42&offset=9'], ['server', '42/metadata/1']])(
    'rejects untrusted queue identities (%s, %s)', (server, queue) => {
      expect(() => modernQueueLink(String(server), queue, 0, '123')).toThrow();
    },
  );
  it.each([NaN, Infinity, -1])('rejects invalid offsets (%s)', (offset) => {
    expect(() => modernQueueLink('server', 42, offset, '123')).toThrow();
  });
  it('requires Plex to own the media button session, not merely appear in session history', () => {
    expect(plexOwnsMediaButtons('  Media button session is com.plexapp.android/player (userId=0)')).toBe(true);
    expect(plexOwnsMediaButtons('Media button session is com.example/player\npackage=com.plexapp.android')).toBe(false);
    expect(plexOwnsMediaButtons('Media button session is null')).toBe(false);
    expect(plexOwnsMediaButtons(null)).toBe(false);
  });
});
