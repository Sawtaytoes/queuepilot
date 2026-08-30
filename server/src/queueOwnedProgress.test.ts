import { describe, expect, it } from 'vitest';

import { isPlaybackComplete } from './finished.js';
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

  it('advances only after at least 90 percent played', () => {
    expect(isPlaybackComplete({ position: 899, duration: 1000 })).toBe(false);
    expect(isPlaybackComplete({ position: 900, duration: 1000 })).toBe(true);
    expect(isPlaybackComplete({ position: null, duration: null })).toBe(false);
  });
});
