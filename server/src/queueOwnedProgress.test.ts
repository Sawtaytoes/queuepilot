import { describe, expect, it } from 'vitest';

import { nowPlayingMs, providerProgressVerdict } from './finished.js';
import { normalizeStart } from './queues.js';
import { effectiveWatchHistory, storedEntryWatchHistory } from './watchHistory.js';

describe('queue-owned progress', () => {
  it('keeps reading the first model where history lived inside a manual start', () => {
    expect(normalizeStart({ season: 1, episode: 1, history: 'queue' })).toEqual({
      season: 1, episode: 1, history: 'queue',
    });
    expect(normalizeStart({ season: 1, episode: 1, history: 'provider' })).toEqual({
      season: 1, episode: 1, history: 'provider',
    });
  });

  it('defaults to provider history and lets the queue reverse the default', () => {
    expect(effectiveWatchHistory({ ratingKey: '1' }, null)).toBe('provider');
    expect(effectiveWatchHistory({ ratingKey: '1' }, 'queue')).toBe('queue');
  });

  it('lets the entry override either queue default independently of its start', () => {
    expect(effectiveWatchHistory(
      { ratingKey: '1', watch_history: 'queue' },
      'provider',
    )).toBe('queue');
    expect(effectiveWatchHistory(
      { ratingKey: '1', watch_history: 'provider' },
      'queue',
    )).toBe('provider');
    expect(storedEntryWatchHistory({
      ratingKey: '1',
      start: { season: 1, episode: 2, history: 'queue' },
    })).toBe('queue');
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
