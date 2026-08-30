import { describe, expect, it } from 'vitest';

import { nowPlayingMs, providerProgressVerdict } from './finished.js';
import { normalizeStart } from './queues.js';

describe('queue-owned progress', () => {
  it('stores queue history as part of a manual start point', () => {
    expect(normalizeStart({ season: 1, episode: 1, history: 'queue' })).toEqual({
      season: 1, episode: 1, history: 'queue',
    });
    expect(normalizeStart({ season: 1, episode: 1, history: 'provider' })).toEqual({
      season: 1, episode: 1, history: 'provider',
    });
  });

  it('does not accept an unknown history mode', () => {
    expect(normalizeStart({ season: 1, episode: 1, history: 'shared' })).toEqual({
      season: 1, episode: 1,
    });
  });

  it('converts the live player seconds to Plex seek milliseconds', () => {
    expect(nowPlayingMs(12.345)).toBe(12_345);
    expect(nowPlayingMs(null)).toBe(0);
  });

  it('lets Plex decide completion by observing the play-count increment', () => {
    expect(providerProgressVerdict(1, 2, 0)).toEqual({ isCompleted: true, positionMs: 0 });
    expect(providerProgressVerdict(1, 1, 456_789)).toEqual({
      isCompleted: false, positionMs: 456_789,
    });
    expect(providerProgressVerdict(1, 1, 0)).toEqual({ isCompleted: false, positionMs: 0 });
  });
});
